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
import {
  buildPublicMcpServer,
  isUniqueEmailViolation,
  type ProvisionedSignup,
  type SignupDeps,
} from "./public-mcp";

const NOW = new Date("2026-07-10T00:00:00.000Z");
const LOGIN_URL = "https://brainz.brownmatter.ai/api/auth/magic-link/verify?token=abc&callbackURL=/dashboard";

function fakeDeps(overrides: Partial<SignupDeps> = {}) {
  const persisted: ProvisionedSignup[] = [];
  const minted: string[] = [];
  const attempts: { ip: string }[] = [];
  const deps: SignupDeps = {
    now: () => NOW,
    ip: "203.0.113.7",
    recordSignupAttempt: async (e) => {
      attempts.push({ ip: e.ip });
    },
    countRecentSignups: async () => attempts.length,
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
  return { deps, persisted, minted, attempts };
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
    const { deps, persisted, minted, attempts } = fakeDeps();
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
    // The rate-limit attempt was recorded FIRST (before counting) for this IP.
    expect(attempts).toEqual([{ ip: "203.0.113.7" }]);
  });

  it("returns a second guidance block documenting the loginUrl handoff-exposure model", async () => {
    const { deps } = fakeDeps();
    const client = await connect(deps);
    const result = await client.callTool({
      name: "signup",
      arguments: { email: "human@example.com" },
    });
    expect(result.isError ?? false).toBe(false);
    const blocks = result.content as { type: string; text: string }[];
    // First block stays the strict SignupOutput JSON (wire shape unchanged).
    expect(signupOutputSchema.safeParse(JSON.parse(blocks[0].text)).success).toBe(true);
    // A second, additive text block carries the security guidance.
    expect(blocks).toHaveLength(2);
    const guidance = blocks[1].text;
    expect(guidance).toMatch(/single-use/i);
    expect(guidance).toMatch(/do NOT log|not.*log/i);
    // States the shorter (~10 min) TTL for the handed-off link.
    expect(guidance).toMatch(/10 ?min/i);
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
    // Insert-then-count: the count includes this attempt, so the window already
    // at the cap makes the inclusive count SIGNUP_RATE_LIMIT + 1 → over.
    const { deps, persisted } = fakeDeps({
      countRecentSignups: async () => SIGNUP_RATE_LIMIT + 1,
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

  it("records the attempt BEFORE the rate-limit decision (TOCTOU-safe order)", async () => {
    // Even a rate-limited attempt is recorded (attempts count toward the
    // window). Model an already-full window via a fixed inclusive count.
    const order: string[] = [];
    const { deps, persisted } = fakeDeps({
      recordSignupAttempt: async () => {
        order.push("record");
      },
      countRecentSignups: async () => {
        order.push("count");
        return SIGNUP_RATE_LIMIT + 1;
      },
    });
    const client = await connect(deps);
    const result = await client.callTool({
      name: "signup",
      arguments: { email: "human@example.com" },
    });
    expect(result.isError).toBe(true);
    expect(order).toEqual(["record", "count"]);
    expect(persisted).toHaveLength(0);
  });

  it("the Nth-under-cap signup passes; the atomic count admits exactly SIGNUP_RATE_LIMIT", async () => {
    // Shared attempts array across many signups from one IP models the durable
    // counter; the fake's countRecentSignups returns the inclusive length.
    const { deps, persisted } = fakeDeps();
    let accepted = 0;
    for (let i = 0; i < SIGNUP_RATE_LIMIT + 3; i++) {
      const client = await connect(deps);
      const result = await client.callTool({
        name: "signup",
        arguments: { email: `human${i}@example.com` },
      });
      if ((result.isError ?? false) === false) accepted++;
    }
    expect(accepted).toBe(SIGNUP_RATE_LIMIT);
    expect(persisted).toHaveLength(SIGNUP_RATE_LIMIT);
  });

  it("unique-email RACE: constraint violation on insert → friendly already-exists result", async () => {
    // The emailExists pre-check passes (returns false), but a concurrent signup
    // won the race, so the user INSERT trips the unique(email) index. That
    // opaque error must be mapped to the SAME friendly result, not surfaced raw.
    const { deps, persisted } = fakeDeps({
      emailExists: async () => false, // pre-check misses the racing winner
      persistSignup: async () => {
        throw new Error("D1_ERROR: UNIQUE constraint failed: user.email");
      },
    });
    const client = await connect(deps);
    const result = await client.callTool({
      name: "signup",
      arguments: { email: "human@example.com" },
    });
    expect(result.isError).toBe(true);
    expect(text(result)).toContain("already exists");
    expect(text(result)).toContain("/login");
    // The opaque constraint text is NOT leaked to the caller.
    expect(text(result)).not.toMatch(/UNIQUE constraint/i);
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
    // A non-constraint failure is surfaced (NOT swallowed as already-exists).
    expect(text(result)).toContain("D1 exploded");
    expect(text(result)).not.toContain("already exists");
  });
});

describe("isUniqueEmailViolation", () => {
  it("matches SQLite/D1 unique-constraint messages", () => {
    expect(isUniqueEmailViolation(new Error("UNIQUE constraint failed: user.email"))).toBe(true);
    expect(isUniqueEmailViolation(new Error("D1_ERROR: UNIQUE constraint failed"))).toBe(true);
    expect(isUniqueEmailViolation("unique_constraint violation")).toBe(true);
  });

  it("does not match unrelated errors", () => {
    expect(isUniqueEmailViolation(new Error("D1 exploded"))).toBe(false);
    expect(isUniqueEmailViolation(new Error("network timeout"))).toBe(false);
    expect(isUniqueEmailViolation(null)).toBe(false);
  });
});
