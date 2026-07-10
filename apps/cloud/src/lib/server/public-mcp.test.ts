/**
 * Public MCP server tests over fake SignupDeps, exercised through a real MCP
 * client via the SDK's InMemoryTransport — proves the unauthenticated /mcp
 * surface is exactly PUBLIC_MCP_TOOLS and the signup flow enforces the
 * duplicate-email and rate-limit rules without a Workers runtime.
 */
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { MCP_TOOL_NAMES, PUBLIC_MCP_TOOL_NAMES, signupOutputSchema } from "@brainz/contracts";
import { describe, expect, it } from "vitest";
import { hashApiKey } from "./api-keys";
import { hashClaimToken, SIGNUP_RATE_LIMIT } from "./claims";
import { buildPublicMcpServer, type ProvisionedSignup, type SignupDeps } from "./public-mcp";

const NOW = new Date("2026-07-10T00:00:00.000Z");

function fakeDeps(overrides: Partial<SignupDeps> = {}) {
  const persisted: ProvisionedSignup[] = [];
  const deps: SignupDeps = {
    now: () => NOW,
    origin: "https://brain.brownmatter.ai",
    ip: "203.0.113.7",
    countRecentSignups: async () => 0,
    emailExists: async () => false,
    persistSignup: async (p) => {
      persisted.push(p);
    },
    ...overrides,
  };
  return { deps, persisted };
}

async function connect(deps: SignupDeps): Promise<Client> {
  const server = buildPublicMcpServer(deps);
  const client = new Client({ name: "test-client", version: "0.0.0" });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  await client.connect(clientTransport);
  return client;
}

function text(result: Awaited<ReturnType<Client["callTool"]>>): string {
  return (result.content as { type: string; text: string }[]).find((c) => c.type === "text")!.text;
}

describe("public MCP server (unauthenticated surface)", () => {
  it("registers exactly the PUBLIC_MCP_TOOLS — signup only, none of the 8 vault tools", async () => {
    const client = await connect(fakeDeps().deps);
    const { tools } = await client.listTools();
    expect(tools.map((t) => t.name)).toEqual([...PUBLIC_MCP_TOOL_NAMES]);
    for (const name of MCP_TOOL_NAMES) {
      expect(tools.map((t) => t.name)).not.toContain(name);
    }
  });

  it("signup provisions user + vault + key + claim and returns the contract output", async () => {
    const { deps, persisted } = fakeDeps();
    const client = await connect(deps);
    const result = await client.callTool({
      name: "signup",
      arguments: { email: "Human@Example.COM", vaultName: "Acme Brain" },
    });
    expect(result.isError ?? false).toBe(false);

    const payload = JSON.parse(text(result));
    expect(signupOutputSchema.safeParse(payload).success).toBe(true);
    expect(payload.email).toBe("human@example.com"); // normalized like Better Auth
    expect(payload.vaultSlug).toBe("acme-brain");
    expect(payload.apiKey).toMatch(/^bz_[A-Za-z0-9]{32}$/);
    expect(payload.claimUrl).toMatch(
      /^https:\/\/brain\.brownmatter\.ai\/claim\/[0-9a-f]{64}$/,
    );

    expect(persisted).toHaveLength(1);
    const p = persisted[0];
    // Better Auth-compatible pre-claim user: unverified, no credential row anywhere.
    expect(p.user.email).toBe("human@example.com");
    expect(p.user.emailVerified).toBe(false);
    expect(p.vault.ownerId).toBe(p.user.id);
    expect(p.vault.name).toBe("Acme Brain");
    expect(p.claim.userId).toBe(p.user.id);
    expect(p.claim.claimedAt).toBeNull();
    expect(p.claim.expiresAt.getTime() - p.claim.createdAt.getTime()).toBe(
      7 * 24 * 60 * 60 * 1000,
    );
    // Only hashes at rest — never the plaintexts.
    expect(p.apiKey.keyHash).toBe(await hashApiKey(payload.apiKey));
    const token = payload.claimUrl.split("/claim/")[1];
    expect(p.claim.tokenHash).toBe(await hashClaimToken(token));
    expect(JSON.stringify(p)).not.toContain(payload.apiKey);
    expect(JSON.stringify(p)).not.toContain(token);
    expect(p.event.ip).toBe("203.0.113.7");
  });

  it("defaults the vault to \"My vault\" / my-vault", async () => {
    const { deps, persisted } = fakeDeps();
    const client = await connect(deps);
    const result = await client.callTool({
      name: "signup",
      arguments: { email: "human@example.com" },
    });
    const payload = JSON.parse(text(result));
    expect(payload.vaultSlug).toBe("my-vault");
    expect(persisted[0].vault.name).toBe("My vault");
  });

  it("duplicate email → isError with sign-in guidance, nothing persisted", async () => {
    const { deps, persisted } = fakeDeps({ emailExists: async () => true });
    const client = await connect(deps);
    const result = await client.callTool({
      name: "signup",
      arguments: { email: "human@example.com" },
    });
    expect(result.isError).toBe(true);
    expect(text(result)).toContain("already exists");
    expect(text(result)).toContain("/login");
    expect(persisted).toHaveLength(0);
  });

  it("6th signup in the window from one IP → rate-limit isError, nothing persisted", async () => {
    const { deps, persisted } = fakeDeps({
      countRecentSignups: async () => SIGNUP_RATE_LIMIT,
    });
    const client = await connect(deps);
    const result = await client.callTool({
      name: "signup",
      arguments: { email: "human@example.com" },
    });
    expect(result.isError).toBe(true);
    expect(text(result)).toMatch(/rate limit/i);
    expect(persisted).toHaveLength(0);
  });

  it("invalid email format → error, nothing persisted", async () => {
    const { deps, persisted } = fakeDeps();
    const client = await connect(deps);
    // The SDK validates the input schema (protocol error); the handler also
    // re-validates (isError). Either way it must fail and persist nothing.
    let errored = false;
    try {
      const result = await client.callTool({ name: "signup", arguments: { email: "not-an-email" } });
      errored = result.isError === true;
    } catch {
      errored = true;
    }
    expect(errored).toBe(true);
    expect(persisted).toHaveLength(0);
  });

  it("persistence failures become isError results, not protocol errors", async () => {
    const { deps } = fakeDeps({
      persistSignup: async () => {
        throw new Error("D1 exploded");
      },
    });
    const client = await connect(deps);
    const result = await client.callTool({
      name: "signup",
      arguments: { email: "human@example.com" },
    });
    expect(result.isError).toBe(true);
    expect(text(result)).toContain("D1 exploded");
  });
});
