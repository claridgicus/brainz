/**
 * Public MCP server tests over fake SignupDeps, exercised through a real MCP
 * client via the SDK's InMemoryTransport — proves the unauthenticated /mcp
 * surface is exactly PUBLIC_MCP_TOOLS and the signup flow provisions the
 * account, returns a magic-link loginUrl, and enforces the duplicate-email and
 * rate-limit rules without a Workers runtime.
 */
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { MCP_TOOL_NAMES, PUBLIC_MCP_TOOL_NAMES, signupOutputSchema } from "@brainz/contracts";
import { describe, expect, it } from "vitest";
import { hashApiKey } from "./api-keys";
import { SIGNUP_RATE_LIMIT } from "./rate-limit";
import { buildPublicMcpServer, type ProvisionedSignup, type SignupDeps } from "./public-mcp";

const NOW = new Date("2026-07-10T00:00:00.000Z");
const LOGIN_URL = "https://brainz.brownmatter.ai/api/auth/magic-link/verify?token=abc&callbackURL=/dashboard";

function fakeDeps(overrides: Partial<SignupDeps> = {}) {
  const persisted: ProvisionedSignup[] = [];
  const minted: string[] = [];
  const deps: SignupDeps = {
    now: () => NOW,
    ip: "203.0.113.7",
    countRecentSignups: async () => 0,
    emailExists: async () => false,
    persistSignup: async (p) => {
      persisted.push(p);
    },
    createLoginLink: async (email) => {
      minted.push(email);
      return LOGIN_URL;
    },
    ...overrides,
  };
  return { deps, persisted, minted };
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
  it("registers exactly the PUBLIC_MCP_TOOLS — signup only, none of the 9 vault tools", async () => {
    const client = await connect(fakeDeps().deps);
    const { tools } = await client.listTools();
    expect(tools.map((t) => t.name)).toEqual([...PUBLIC_MCP_TOOL_NAMES]);
    for (const name of MCP_TOOL_NAMES) {
      expect(tools.map((t) => t.name)).not.toContain(name);
    }
  });

  it("signup provisions user + vault + key and returns a magic-link loginUrl", async () => {
    const { deps, persisted, minted } = fakeDeps();
    const client = await connect(deps);
    const result = await client.callTool({
      name: "signup",
      arguments: { email: "Human@Example.COM", vaultName: "Acme Brain" },
    });
    expect(result.isError ?? false).toBe(false);

    const payload = JSON.parse(text(result));
    expect(signupOutputSchema.safeParse(payload).success).toBe(true);
    expect(payload.email).toBe("human@example.com"); // normalized
    expect(payload.vaultSlug).toBe("acme-brain");
    expect(payload.apiKey).toMatch(/^bz_[A-Za-z0-9]{32}$/);
    expect(payload.loginUrl).toBe(LOGIN_URL);
    // No claimUrl remains in the wire shape.
    expect("claimUrl" in payload).toBe(false);
    // The magic link was minted for the normalized email, after persistence.
    expect(minted).toEqual(["human@example.com"]);

    expect(persisted).toHaveLength(1);
    const p = persisted[0];
    // Passwordless pre-verified account: unverified email, no credential row.
    expect(p.user.email).toBe("human@example.com");
    expect(p.user.emailVerified).toBe(false);
    expect(p.vault.ownerId).toBe(p.user.id);
    expect(p.vault.name).toBe("Acme Brain");
    // Only the key hash at rest — never the plaintext.
    expect(p.apiKey.keyHash).toBe(await hashApiKey(payload.apiKey));
    expect(JSON.stringify(p)).not.toContain(payload.apiKey);
    expect(p.event.ip).toBe("203.0.113.7");
  });

  it('defaults the vault to "My vault" / my-vault', async () => {
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

  it("duplicate email → isError with sign-in guidance, nothing persisted, no link minted", async () => {
    const { deps, persisted, minted } = fakeDeps({ emailExists: async () => true });
    const client = await connect(deps);
    const result = await client.callTool({
      name: "signup",
      arguments: { email: "human@example.com" },
    });
    expect(result.isError).toBe(true);
    expect(text(result)).toContain("already exists");
    expect(text(result)).toContain("/login");
    expect(persisted).toHaveLength(0);
    expect(minted).toHaveLength(0);
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
