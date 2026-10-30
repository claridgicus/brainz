/**
 * Public MCP server tests over fake SignupDeps, exercised through a real MCP
 * client via the SDK's InMemoryTransport — proves the unauthenticated
 * /mcp/agent surface offers only PUBLIC_MCP_TOOLS (signup + sign_in), that the
 * unauthenticated /mcp directory listing offers the directory vault tools for
 * lazy auth (Wave OA) and never signup/sign_in/session_hook, that signup v2
 * (Wave G) provisions an ANONYMOUS provisional account (placeholder identity,
 * 7-day expiry), returns NO URL of any kind, fires the claim request when an
 * email is supplied, and enforces the per-IP rate limit with the TOCTOU-safe
 * record-before-count order — and that sign_in emails a magic link, returns NO
 * URL, rate-limits like the login page, and never leaks account existence — all
 * without a Workers runtime.
 */
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import {
  DIRECTORY_MCP_TOOL_NAMES,
  MCP_TOOLS,
  OAUTH_MCP_TOOLS,
  OAUTH_MCP_TOOL_NAMES,
  PUBLIC_MCP_TOOLS,
  PUBLIC_MCP_TOOL_NAMES,
  signInOutputSchema,
  signupOutputSchema,
} from "@brainz/contracts";
import { describe, expect, it } from "vitest";
import { hashApiKey } from "./api-keys";
import { isPlaceholderEmail, SIGNUP_EXPIRY_MS, UNCLAIMED_WORKSPACE_NAME } from "./claim";
import { SIGNUP_RATE_LIMIT } from "./rate-limit";
import {
  buildDirectoryListingMcpServer,
  buildPublicMcpServer,
  type ProvisionedSignup,
  type SignupDeps,
} from "./public-mcp";

const NOW = new Date("2026-07-10T00:00:00.000Z");

function fakeDeps(overrides: Partial<SignupDeps> = {}) {
  const persisted: ProvisionedSignup[] = [];
  const claimRequests: { userId: string; email: string }[] = [];
  const signInRequests: { email: string }[] = [];
  const attempts: { ip: string }[] = [];
  const deps: SignupDeps = {
    now: () => NOW,
    ip: "203.0.113.7",
    recordSignupAttempt: async (e) => {
      attempts.push({ ip: e.ip });
    },
    countRecentSignups: async () => attempts.length,
    persistSignup: async (p) => {
      persisted.push(p);
    },
    requestClaim: async (args) => {
      claimRequests.push(args);
    },
    requestSignIn: async (args) => {
      signInRequests.push(args);
      return { throttled: false };
    },
    ...overrides,
  };
  return { deps, persisted, claimRequests, signInRequests, attempts };
}

async function connect(deps: SignupDeps | "directory"): Promise<Client> {
  const server = deps === "directory" ? buildDirectoryListingMcpServer() : buildPublicMcpServer(deps);
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

describe("directory listing (unauthenticated /mcp)", () => {
  it("lists the directory vault tools only: no signup, sign_in, session_hook or claim", async () => {
    const client = await connect("directory");
    const { tools } = await client.listTools();
    // Wave OA: the gated vault tools are LISTED so directory clients know they
    // exist; calling one is answered by the /mcp route's 401 OAuth challenge.
    expect(tools.map((t) => t.name)).toEqual([...DIRECTORY_MCP_TOOL_NAMES, ...OAUTH_MCP_TOOL_NAMES]);
    for (const name of ["signup", "sign_in", "session_hook", "claim"]) {
      expect(tools.map((t) => t.name)).not.toContain(name);
    }
    for (const tool of tools) {
      const contract = [...MCP_TOOLS, ...OAUTH_MCP_TOOLS].find((t) => t.name === tool.name)!;
      expect(tool.annotations).toEqual({ title: contract.title, ...contract.annotations });
    }
  });

  it("sends the neutral server instructions, not the directive session primer", async () => {
    const client = await connect("directory");
    const instructions = client.getInstructions() ?? "";
    expect(instructions).toContain("get_context");
    expect(instructions).not.toMatch(/every session|don't wait|by default/i);
  });

  it("a gated tool that slips past the route's 401 gate is an isError, never vault data", async () => {
    const client = await connect("directory");
    const result = await client.callTool({ name: "search_concepts", arguments: { query: "x" } });
    expect(result.isError).toBe(true);
    expect(text(result)).toMatch(/sign in required/);
  });
});

describe("agent self-signup server (unauthenticated /mcp/agent)", () => {
  it("lists exactly signup + sign_in with their contract annotations", async () => {
    const client = await connect(fakeDeps().deps);
    const { tools } = await client.listTools();
    expect(tools.map((t) => t.name)).toEqual([...PUBLIC_MCP_TOOL_NAMES]);
    for (const contract of PUBLIC_MCP_TOOLS) {
      const tool = tools.find((t) => t.name === contract.name)!;
      expect(tool.annotations).toEqual({ title: contract.title, ...contract.annotations });
    }
  });

  it("anonymous signup provisions a provisional user + vault + key — no email needed", async () => {
    const { deps, persisted, claimRequests, attempts } = fakeDeps();
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
    // Wave M: membership is the access source of truth — signup provisions
    // the creator's `owner` vault_member row alongside the vault.
    expect(p.member.vaultId).toBe(p.vault.id);
    expect(p.member.userId).toBe(p.user.id);
    expect(p.member.role).toBe("owner");
    // Only the key hash at rest — never the plaintext.
    expect(p.apiKey.keyHash).toBe(await hashApiKey(payload.apiKey));
    expect(JSON.stringify(p)).not.toContain(payload.apiKey);
    // The rate-limit attempt was recorded FIRST (before counting) for this IP.
    expect(attempts).toEqual([{ ip: "203.0.113.7" }]);
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
    // is nothing to conflict with. The flow succeeds like any other. (The old
    // unique-email-race fix is subsumed by this emailless design.)
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
    // Insert-then-count: the count includes this attempt, so the window already
    // at the cap makes the inclusive count SIGNUP_RATE_LIMIT + 1 → over.
    const { deps, persisted } = fakeDeps({
      countRecentSignups: async () => SIGNUP_RATE_LIMIT + 1,
    });
    const client = await connect(deps);
    const result = await client.callTool({ name: "signup", arguments: {} });
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

describe("sign_in tool (email a magic link — human must action it)", () => {
  it("fires the sign-in request (magic-link send path) with the normalized email", async () => {
    const { deps, signInRequests, persisted } = fakeDeps();
    const client = await connect(deps);
    const result = await client.callTool({
      name: "sign_in",
      arguments: { email: "Human@Example.COM" },
    });
    expect(result.isError ?? false).toBe(false);
    // The send path was invoked exactly once, with the normalized address.
    expect(signInRequests).toEqual([{ email: "human@example.com" }]);
    // sign_in never provisions anything.
    expect(persisted).toHaveLength(0);
    const payload = JSON.parse(text(result));
    expect(signInOutputSchema.safeParse(payload).success).toBe(true);
    expect(payload.status).toBe("sent");
  });

  it("returns NO login URL of any kind — the human actions it from their inbox", async () => {
    const { deps } = fakeDeps();
    const client = await connect(deps);
    const result = await client.callTool({
      name: "sign_in",
      arguments: { email: "human@example.com" },
    });
    expect(result.isError ?? false).toBe(false);
    const payload = JSON.parse(text(result));
    expect("loginUrl" in payload).toBe(false);
    expect("url" in payload).toBe(false);
    // No block carries anything URL-shaped or a token.
    expect(allText(result)).not.toMatch(/https?:\/\//);
    // The confirmation makes clear the link is emailed only.
    expect(allText(result)).toMatch(/inbox/i);
  });

  it("gives the SAME generic response whether or not the address has an account (no leak)", async () => {
    // The send path is invoked identically regardless of eligibility; sign_in
    // does not consult existence. Two different addresses → identical output.
    const a = fakeDeps();
    const b = fakeDeps();
    const clientA = await connect(a.deps);
    const clientB = await connect(b.deps);
    const resA = await clientA.callTool({ name: "sign_in", arguments: { email: "known@example.com" } });
    const resB = await clientB.callTool({ name: "sign_in", arguments: { email: "unknown@example.com" } });
    expect(text(resA)).toBe(text(resB));
    expect(a.signInRequests).toEqual([{ email: "known@example.com" }]);
    expect(b.signInRequests).toEqual([{ email: "unknown@example.com" }]);
  });

  it("rate-limit trip → friendly isError, and no email leak about existence", async () => {
    const { deps } = fakeDeps({
      requestSignIn: async () => ({ throttled: true }),
    });
    const client = await connect(deps);
    const result = await client.callTool({
      name: "sign_in",
      arguments: { email: "human@example.com" },
    });
    expect(result.isError).toBe(true);
    expect(text(result)).toMatch(/rate limit/i);
    // The throttle message must not reveal whether the account exists.
    expect(text(result)).not.toMatch(/account (exists|not found)/i);
  });

  it("invalid email format → error, no send path invoked", async () => {
    const { deps, signInRequests } = fakeDeps();
    const client = await connect(deps);
    let errored = false;
    try {
      const result = await client.callTool({
        name: "sign_in",
        arguments: { email: "not-an-email" },
      });
      errored = result.isError === true;
    } catch {
      errored = true;
    }
    expect(errored).toBe(true);
    expect(signInRequests).toHaveLength(0);
  });
});
