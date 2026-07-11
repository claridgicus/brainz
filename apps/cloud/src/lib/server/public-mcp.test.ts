/**
 * Public MCP server tests over fake SignupDeps, exercised through a real MCP
 * client via the SDK's InMemoryTransport — proves the unauthenticated /mcp
 * surface is exactly PUBLIC_MCP_TOOLS and that signup v2 (Wave G) provisions
 * an ANONYMOUS provisional account (placeholder identity, 7-day expiry),
 * returns NO URL of any kind, fires the claim request when an email is
 * supplied, and enforces the per-IP rate limit — all without a Workers
 * runtime.
 */
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { MCP_TOOL_NAMES, PUBLIC_MCP_TOOL_NAMES, signupOutputSchema } from "@brainz/contracts";
import { describe, expect, it } from "vitest";
import { hashApiKey } from "./api-keys";
import { isPlaceholderEmail, SIGNUP_EXPIRY_MS, UNCLAIMED_WORKSPACE_NAME } from "./claim";
import { SIGNUP_RATE_LIMIT } from "./rate-limit";
import { buildPublicMcpServer, type ProvisionedSignup, type SignupDeps } from "./public-mcp";

const NOW = new Date("2026-07-10T00:00:00.000Z");

function fakeDeps(overrides: Partial<SignupDeps> = {}) {
  const persisted: ProvisionedSignup[] = [];
  const claimRequests: { userId: string; email: string }[] = [];
  const deps: SignupDeps = {
    now: () => NOW,
    ip: "203.0.113.7",
    countRecentSignups: async () => 0,
    persistSignup: async (p) => {
      persisted.push(p);
    },
    requestClaim: async (args) => {
      claimRequests.push(args);
    },
    ...overrides,
  };
  return { deps, persisted, claimRequests };
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

function allText(result: Awaited<ReturnType<Client["callTool"]>>): string {
  return (result.content as { type: string; text: string }[])
    .filter((c) => c.type === "text")
    .map((c) => c.text)
    .join("\n");
}

describe("public MCP server (unauthenticated surface)", () => {
  it("registers exactly the PUBLIC_MCP_TOOLS — signup only, none of the vault tools", async () => {
    const client = await connect(fakeDeps().deps);
    const { tools } = await client.listTools();
    expect(tools.map((t) => t.name)).toEqual([...PUBLIC_MCP_TOOL_NAMES]);
    for (const name of MCP_TOOL_NAMES) {
      expect(tools.map((t) => t.name)).not.toContain(name);
    }
    // The cloud-only claim tool is NOT on the public surface either.
    expect(tools.map((t) => t.name)).not.toContain("claim");
  });

  it("anonymous signup provisions a provisional user + vault + key — no email needed", async () => {
    const { deps, persisted, claimRequests } = fakeDeps();
    const client = await connect(deps);
    const result = await client.callTool({
      name: "signup",
      arguments: { vaultName: "Acme Brain" },
    });
    expect(result.isError ?? false).toBe(false);

    const payload = JSON.parse(text(result));
    expect(signupOutputSchema.safeParse(payload).success).toBe(true);
    expect(payload.vaultSlug).toBe("acme-brain");
    expect(payload.apiKey).toMatch(/^bz_[A-Za-z0-9]{32}$/);
    expect(payload.claimEmailSent).toBe(false);
    expect(payload.expiresAt).toBe(new Date(NOW.getTime() + SIGNUP_EXPIRY_MS).toISOString());

    expect(persisted).toHaveLength(1);
    const p = persisted[0];
    // Provisional placeholder identity: unclaimed-<userId>@pending.brainz.invalid,
    // "Unclaimed workspace", unverified, expiring in 7 days.
    expect(p.user.email).toBe(`unclaimed-${p.user.id}@pending.brainz.invalid`);
    expect(isPlaceholderEmail(p.user.email)).toBe(true);
    expect(p.user.name).toBe(UNCLAIMED_WORKSPACE_NAME);
    expect(p.user.emailVerified).toBe(false);
    expect(p.user.expiresAt?.toISOString()).toBe(payload.expiresAt);
    expect(p.vault.ownerId).toBe(p.user.id);
    expect(p.vault.name).toBe("Acme Brain");
    // Only the key hash at rest — never the plaintext.
    expect(p.apiKey.keyHash).toBe(await hashApiKey(payload.apiKey));
    expect(JSON.stringify(p)).not.toContain(payload.apiKey);
    expect(p.event.ip).toBe("203.0.113.7");
    // No email supplied → no claim request fired.
    expect(claimRequests).toHaveLength(0);
  });

  it("never returns a URL of any kind — in the wire shape or the guidance block", async () => {
    const { deps } = fakeDeps();
    const client = await connect(deps);
    const result = await client.callTool({
      name: "signup",
      arguments: { email: "human@example.com" },
    });
    expect(result.isError ?? false).toBe(false);
    const payload = JSON.parse(text(result));
    expect("loginUrl" in payload).toBe(false);
    expect("claimUrl" in payload).toBe(false);
    expect("email" in payload).toBe(false);
    // Neither block carries anything URL-shaped.
    expect(allText(result)).not.toMatch(/https?:\/\//);
  });

  it("appends a guidance block: secret key, expiry date, claim-to-persist", async () => {
    const { deps } = fakeDeps();
    const client = await connect(deps);
    const result = await client.callTool({ name: "signup", arguments: {} });
    expect(result.isError ?? false).toBe(false);
    const blocks = result.content as { type: string; text: string }[];
    // First block stays the strict SignupOutput JSON (wire shape).
    expect(signupOutputSchema.safeParse(JSON.parse(blocks[0].text)).success).toBe(true);
    expect(blocks).toHaveLength(2);
    const guidance = blocks[1].text;
    expect(guidance).toMatch(/SECRET/i);
    expect(guidance).toMatch(/never log/i);
    // Names the concrete expiry date and the claim path.
    expect(guidance).toContain(
      new Date(NOW.getTime() + SIGNUP_EXPIRY_MS).toISOString().slice(0, 10),
    );
    expect(guidance).toMatch(/`claim`/);
    expect(guidance).toMatch(/EMAILED/);
  });

  it("with email: fires the claim request for the new owner, claimEmailSent true", async () => {
    const { deps, persisted, claimRequests } = fakeDeps();
    const client = await connect(deps);
    const result = await client.callTool({
      name: "signup",
      arguments: { email: "Human@Example.COM" },
    });
    expect(result.isError ?? false).toBe(false);
    const payload = JSON.parse(text(result));
    expect(payload.claimEmailSent).toBe(true);
    // Fired after persistence, for the new user, with the normalized email.
    expect(claimRequests).toEqual([{ userId: persisted[0].user.id, email: "human@example.com" }]);
  });

  it("claimEmailSent stays true even when the claim request fails (no eligibility oracle)", async () => {
    const { deps, persisted } = fakeDeps({
      requestClaim: async () => {
        throw new Error("address already registered"); // must never surface
      },
    });
    const client = await connect(deps);
    const result = await client.callTool({
      name: "signup",
      arguments: { email: "taken@example.com" },
    });
    expect(result.isError ?? false).toBe(false);
    const payload = JSON.parse(text(result));
    expect(payload.claimEmailSent).toBe(true);
    expect(allText(result)).not.toContain("already registered");
    expect(persisted).toHaveLength(1); // signup itself still succeeded
  });

  it("an email that already has an account does NOT block signup (no enumeration error)", async () => {
    // Wave G removed the emailExists gate: nothing binds at signup, so there
    // is nothing to conflict with. The flow succeeds like any other.
    const { deps, persisted } = fakeDeps();
    const client = await connect(deps);
    const result = await client.callTool({
      name: "signup",
      arguments: { email: "existing-user@example.com" },
    });
    expect(result.isError ?? false).toBe(false);
    expect(persisted).toHaveLength(1);
  });

  it('defaults the vault to "My vault" / my-vault', async () => {
    const { deps, persisted } = fakeDeps();
    const client = await connect(deps);
    const result = await client.callTool({ name: "signup", arguments: {} });
    const payload = JSON.parse(text(result));
    expect(payload.vaultSlug).toBe("my-vault");
    expect(persisted[0].vault.name).toBe("My vault");
  });

  it("6th signup in the window from one IP → rate-limit isError, nothing persisted", async () => {
    const { deps, persisted } = fakeDeps({
      countRecentSignups: async () => SIGNUP_RATE_LIMIT,
    });
    const client = await connect(deps);
    const result = await client.callTool({ name: "signup", arguments: {} });
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
    const result = await client.callTool({ name: "signup", arguments: {} });
    expect(result.isError).toBe(true);
    expect(text(result)).toContain("D1 exploded");
  });
});
