/**
 * Claim domain tests (Wave G) over a fake ClaimDb + fake Mailer — the whole
 * claim-to-persist lifecycle without a Workers/D1 runtime:
 *
 *   request  — eligible (approval email w/ /claim/<token> URL, token HASHED at
 *              rest, 24 h expiry), already-claimed, throttled, supersede;
 *              an already-registered email STILL gets an approval token (the
 *              approval reconciles) with an identical result shape
 *   validate — pending summary vs unknown/expired/used tokens
 *   approve  — promote-in-place (new email), reconcile-to-existing (email that
 *              already has a user: vault reassigned, provisional user deleted,
 *              slug collision deduped), expired, reuse, single-use
 *   decline  — pending claim deleted, workspace left to expire
 */
import { describe, expect, it } from "vitest";
import {
  approveClaim,
  CLAIM_TTL_MS,
  declineClaim,
  dedupeSlug,
  handleClaimTool,
  hashClaimToken,
  isPlaceholderEmail,
  isProvisionalOwner,
  mintClaimToken,
  placeholderEmail,
  requestClaim,
  UNCLAIMED_WORKSPACE_NAME,
  validateClaimToken,
  type ClaimDb,
  type ClaimOwner,
  type ClaimRow,
  type ProvisionalVault,
} from "./claim";
import { MAGIC_LINK_EMAIL_LIMIT, MAGIC_LINK_IP_LIMIT } from "./rate-limit";
import type { Mailer } from "./mailer";

const NOW = new Date("2026-07-10T00:00:00.000Z");
const ORIGIN = "https://brainz.brownmatter.ai";

interface SentMail {
  kind: "approval" | "notice" | "magic";
  to: string;
  url?: string;
}

function fakeMailer() {
  const sent: SentMail[] = [];
  const mailer: Mailer = {
    async sendMagicLink({ to, url }) {
      sent.push({ kind: "magic", to, url });
    },
    async sendClaimApproval({ to, url }) {
      sent.push({ kind: "approval", to, url });
    },
    async sendClaimNotice({ to }) {
      sent.push({ kind: "notice", to });
    },
  };
  return { mailer, sent };
}

interface FakeVault {
  id: string;
  ownerId: string;
  slug: string;
}

interface FakeState {
  users: Map<string, ClaimOwner>;
  /** Real (non-provisional) accounts by lowercased email — the reconcile target. */
  registeredUsers: Map<string, { id: string }>;
  /** Vault registry (owner_id + slug), so reconcile moves + slug dedupe are testable. */
  vaults: Map<string, FakeVault>;
  claims: ClaimRow[];
  magicLinkEvents: { email: string; ip: string; at: Date }[];
  approvals: { userId: string; claimId: string; email: string; name: string; at: Date }[];
  reconciles: {
    provisionalUserId: string;
    existingUserId: string;
    claimId: string;
    vaultRenames: { vaultId: string; slug: string }[];
    at: Date;
  }[];
  emailCount: number;
  ipCount: number;
}

function provisionalOwner(id = "user-1"): ClaimOwner {
  return {
    id,
    name: UNCLAIMED_WORKSPACE_NAME,
    email: placeholderEmail(id),
    createdAt: new Date("2026-07-09T00:00:00.000Z"),
    expiresAt: new Date("2026-07-16T00:00:00.000Z"),
  };
}

function fakeDb(overrides: Partial<FakeState> = {}) {
  const state: FakeState = {
    users: new Map([["user-1", provisionalOwner()]]),
    registeredUsers: new Map(),
    // Default: the provisional user owns one vault ("agent-vault").
    vaults: new Map([["vault-1", { id: "vault-1", ownerId: "user-1", slug: "agent-vault" }]]),
    claims: [],
    magicLinkEvents: [],
    approvals: [],
    reconciles: [],
    emailCount: 0,
    ipCount: 0,
    ...overrides,
  };
  const db: ClaimDb = {
    getUserById: async (id) => state.users.get(id) ?? null,
    findUserByEmail: async (email) => state.registeredUsers.get(email.toLowerCase()) ?? null,
    workspaceSummary: async (userId) =>
      state.users.has(userId)
        ? { vaultName: "Agent Vault", keyName: "agent-signup", keyPrefix: "bz_a1B2c…" }
        : null,
    vaultsOwnedBy: async (userId): Promise<ProvisionalVault[]> =>
      [...state.vaults.values()]
        .filter((v) => v.ownerId === userId)
        .map((v) => ({ id: v.id, slug: v.slug })),
    vaultSlugsOwnedBy: async (userId) =>
      new Set([...state.vaults.values()].filter((v) => v.ownerId === userId).map((v) => v.slug)),
    deletePendingClaims: async (userId) => {
      state.claims = state.claims.filter((c) => c.userId !== userId || c.approvedAt !== null);
    },
    insertClaim: async (row) => {
      state.claims.push({ ...row });
    },
    getClaimByHash: async (tokenHash) =>
      state.claims.find((c) => c.tokenHash === tokenHash) ?? null,
    approve: async (args) => {
      state.approvals.push(args);
      const owner = state.users.get(args.userId);
      if (owner) {
        state.users.set(args.userId, {
          ...owner,
          email: args.email,
          name: args.name,
          expiresAt: null,
        });
      }
      state.claims = state.claims
        .filter((c) => c.userId !== args.userId || c.id === args.claimId)
        .map((c) => (c.id === args.claimId ? { ...c, approvedAt: args.at } : c));
      // The promoted account now owns this email.
      state.registeredUsers.set(args.email.toLowerCase(), { id: args.userId });
    },
    reconcile: async (args) => {
      state.reconciles.push(args);
      // Apply slug renames first (still on the provisional owner).
      for (const r of args.vaultRenames) {
        const v = state.vaults.get(r.vaultId);
        if (v) state.vaults.set(v.id, { ...v, slug: r.slug });
      }
      // Reassign every provisional vault to the existing user.
      for (const v of [...state.vaults.values()]) {
        if (v.ownerId === args.provisionalUserId) {
          state.vaults.set(v.id, { ...v, ownerId: args.existingUserId });
        }
      }
      // Stamp the claim approved, then delete the provisional user + cascade its
      // remaining pending claims.
      state.claims = state.claims.map((c) =>
        c.id === args.claimId ? { ...c, approvedAt: args.at } : c,
      );
      state.users.delete(args.provisionalUserId);
      state.claims = state.claims.filter((c) => c.userId !== args.provisionalUserId);
    },
    deletePendingClaimByHash: async (tokenHash) => {
      state.claims = state.claims.filter(
        (c) => c.tokenHash !== tokenHash || c.approvedAt !== null,
      );
    },
    countRecentMagicLinkByEmail: async () => state.emailCount,
    countRecentMagicLinkByIp: async () => state.ipCount,
    recordMagicLinkEvent: async (event) => {
      state.magicLinkEvents.push(event);
    },
  };
  return { db, state };
}

/** Register a real (non-provisional) account with the given email + optional vaults. */
function registerUser(
  state: FakeState,
  id: string,
  email: string,
  vaultSlugs: string[] = [],
): void {
  state.registeredUsers.set(email.toLowerCase(), { id });
  state.users.set(id, {
    id,
    name: email.split("@")[0],
    email,
    createdAt: new Date("2026-01-01T00:00:00.000Z"),
    expiresAt: null,
  });
  vaultSlugs.forEach((slug, i) =>
    state.vaults.set(`${id}-v${i}`, { id: `${id}-v${i}`, ownerId: id, slug }),
  );
}

function deps(db: ClaimDb, mailer: Mailer) {
  return { db, mailer, origin: ORIGIN, ip: "203.0.113.7", now: () => NOW };
}

/** Extract the raw token from a captured approval URL. */
function tokenFrom(url: string): string {
  const m = /\/claim\/([0-9a-f]+)$/.exec(url);
  expect(m, `approval URL shape: ${url}`).toBeTruthy();
  return m![1];
}

// ---------------------------------------------------------------- identity

describe("provisional identity helpers", () => {
  it("placeholder emails are recognizable and end in the .invalid domain", () => {
    const email = placeholderEmail("abc-123");
    expect(email).toBe("unclaimed-abc-123@pending.brainz.invalid");
    expect(isPlaceholderEmail(email)).toBe(true);
    expect(isPlaceholderEmail("human@example.com")).toBe(false);
  });

  it("isProvisionalOwner requires BOTH an expiry and the placeholder email", () => {
    expect(isProvisionalOwner(provisionalOwner())).toBe(true);
    expect(isProvisionalOwner({ email: "h@x.com", expiresAt: new Date() })).toBe(false);
    expect(isProvisionalOwner({ email: placeholderEmail("u"), expiresAt: null })).toBe(false);
  });

  it("dedupeSlug leaves a free slug untouched and appends -2, -3… on collision", () => {
    expect(dedupeSlug("agent-vault", new Set())).toBe("agent-vault");
    expect(dedupeSlug("agent-vault", new Set(["agent-vault"]))).toBe("agent-vault-2");
    expect(dedupeSlug("agent-vault", new Set(["agent-vault", "agent-vault-2"]))).toBe(
      "agent-vault-3",
    );
  });

  it("tokens are 32 bytes hex, unique, and hashed to a different value", async () => {
    const a = mintClaimToken();
    const b = mintClaimToken();
    expect(a).toMatch(/^[0-9a-f]{64}$/);
    expect(a).not.toBe(b);
    expect(await hashClaimToken(a)).toMatch(/^[0-9a-f]{64}$/);
    expect(await hashClaimToken(a)).not.toBe(a);
  });
});

// ------------------------------------------------------------ requestClaim

describe("requestClaim", () => {
  it("eligible: stores a HASHED 24h claim and emails the approval link with the key summary", async () => {
    const { db, state } = fakeDb();
    const { mailer, sent } = fakeMailer();
    const result = await requestClaim(deps(db, mailer), {
      userId: "user-1",
      email: "Human@Example.COM",
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.expiresAt).toEqual(new Date(NOW.getTime() + CLAIM_TTL_MS));

    expect(state.claims).toHaveLength(1);
    const claim = state.claims[0];
    expect(claim.userId).toBe("user-1");
    expect(claim.email).toBe("human@example.com"); // normalized
    expect(claim.expiresAt).toEqual(new Date(NOW.getTime() + CLAIM_TTL_MS));
    expect(claim.approvedAt).toBeNull();

    expect(sent).toHaveLength(1);
    expect(sent[0].kind).toBe("approval");
    expect(sent[0].to).toBe("human@example.com");
    expect(sent[0].url).toMatch(new RegExp(`^${ORIGIN}/claim/[0-9a-f]{64}$`));
    // Token at rest is the SHA-256 hash of the emailed token — never the raw.
    const rawToken = tokenFrom(sent[0].url!);
    expect(claim.tokenHash).toBe(await hashClaimToken(rawToken));
    expect(claim.tokenHash).not.toBe(rawToken);

    // Counted in magic_link_events (shared abuse surface).
    expect(state.magicLinkEvents).toEqual([
      { email: "human@example.com", ip: "203.0.113.7", at: NOW },
    ]);
  });

  it("already-claimed owner → error result, nothing sent or stored", async () => {
    const { db, state } = fakeDb({
      users: new Map([
        [
          "user-1",
          { ...provisionalOwner(), email: "claimed@example.com", expiresAt: null },
        ],
      ]),
    });
    const { mailer, sent } = fakeMailer();
    const result = await requestClaim(deps(db, mailer), {
      userId: "user-1",
      email: "human@example.com",
    });
    expect(result).toMatchObject({ ok: false, reason: "already-claimed" });
    expect(result.ok === false && result.message).toMatch(/already claimed/);
    expect(result.ok === false && result.message).toMatch(/settings/);
    expect(sent).toHaveLength(0);
    expect(state.claims).toHaveLength(0);
  });

  it("already-registered address → STILL emits an approval token (approval reconciles), identical result shape", async () => {
    // The fix: an email that already has an account must NOT dead-end at a
    // notice. It gets a real approval link (to the inbox owner only), whose
    // click reconciles the provisional vault into the existing account. The
    // tool result stays {status:"sent"} either way — no enumeration oracle.
    const { db, state } = fakeDb();
    registerUser(state, "existing-user", "human@example.com");
    const { mailer, sent } = fakeMailer();
    const result = await requestClaim(deps(db, mailer), {
      userId: "user-1",
      email: "human@example.com",
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.expiresAt).toEqual(new Date(NOW.getTime() + CLAIM_TTL_MS));
    // A hashed claim token IS stored and an approval link IS emailed.
    expect(state.claims).toHaveLength(1);
    expect(sent).toHaveLength(1);
    expect(sent[0].kind).toBe("approval");
    expect(sent[0].to).toBe("human@example.com");
    expect(sent[0].url).toMatch(new RegExp(`^${ORIGIN}/claim/[0-9a-f]{64}$`));
  });

  it("a MIXED-CASE address matches an already-registered (lowercase) account — normalizes before lookup", async () => {
    // The account was stored canonically (lowercase). A claim requested with a
    // case-variant of it must normalize BEFORE the findUserByEmail lookup so it
    // resolves to the SAME account. An already-registered email still gets a
    // real approval token (the human's click is the consent to reconcile the
    // provisional workspace into their existing account).
    const { db, state } = fakeDb({ registeredUsers: new Map([["human@example.com", { id: "existing-human" }]]) });
    const { mailer, sent } = fakeMailer();
    const result = await requestClaim(deps(db, mailer), {
      userId: "user-1",
      email: "  Human@Example.COM ",
    });
    expect(result.ok).toBe(true);
    // Matched across case → an approval link is sent to the normalized address.
    expect(sent).toHaveLength(1);
    expect(sent[0].kind).toBe("approval");
    expect(sent[0].to).toBe("human@example.com");
    expect(state.claims).toHaveLength(1);
    // The rate-limit event is keyed on the normalized form (shared bucket).
    expect(state.magicLinkEvents).toEqual([
      { email: "human@example.com", ip: "203.0.113.7", at: NOW },
    ]);
  });

  it("throttled by the email window → error result, nothing sent (attempt still recorded)", async () => {
    // TOCTOU-safe guard (record-before-count, inclusive `count > limit`): the
    // inclusive window count already PAST the email cap trips the throttle. The
    // attempt is recorded FIRST (it counts toward the window), so a throttled
    // request DOES leave a magic_link_events row — but no claim/email is sent.
    const { db, state } = fakeDb({ emailCount: MAGIC_LINK_EMAIL_LIMIT + 1 });
    const { mailer, sent } = fakeMailer();
    const result = await requestClaim(deps(db, mailer), {
      userId: "user-1",
      email: "human@example.com",
    });
    expect(result).toMatchObject({ ok: false, reason: "throttled" });
    expect(sent).toHaveLength(0);
    expect(state.claims).toHaveLength(0);
    // Recorded first (TOCTOU-safe order) — the attempt counts toward the window.
    expect(state.magicLinkEvents).toHaveLength(1);
  });

  it("throttled by the IP window too", async () => {
    const { db } = fakeDb({ ipCount: MAGIC_LINK_IP_LIMIT + 1 });
    const { mailer } = fakeMailer();
    const result = await requestClaim(deps(db, mailer), {
      userId: "user-1",
      email: "human@example.com",
    });
    expect(result).toMatchObject({ ok: false, reason: "throttled" });
  });

  it("a new request SUPERSEDES the owner's prior pending claims", async () => {
    const { db, state } = fakeDb();
    const { mailer, sent } = fakeMailer();
    await requestClaim(deps(db, mailer), { userId: "user-1", email: "first@example.com" });
    await requestClaim(deps(db, mailer), { userId: "user-1", email: "second@example.com" });

    expect(state.claims).toHaveLength(1);
    expect(state.claims[0].email).toBe("second@example.com");
    // The first token no longer validates; the second does.
    const firstToken = tokenFrom(sent[0].url!);
    const secondToken = tokenFrom(sent[1].url!);
    expect(await validateClaimToken(db, firstToken, NOW)).toBeNull();
    expect(await validateClaimToken(db, secondToken, NOW)).not.toBeNull();
  });

  it("unknown owner → no-owner error", async () => {
    const { db } = fakeDb();
    const { mailer } = fakeMailer();
    const result = await requestClaim(deps(db, mailer), {
      userId: "ghost",
      email: "human@example.com",
    });
    expect(result).toMatchObject({ ok: false, reason: "no-owner" });
  });

  it("mailer failures never fail the (already recorded) request", async () => {
    const { db, state } = fakeDb();
    const mailer: Mailer = {
      async sendMagicLink() {},
      async sendClaimApproval() {
        throw new Error("smtp exploded");
      },
    };
    const result = await requestClaim(deps(db, mailer), {
      userId: "user-1",
      email: "human@example.com",
    });
    expect(result.ok).toBe(true);
    expect(state.claims).toHaveLength(1);
  });
});

// -------------------------------------------------------- validateClaimToken

describe("validateClaimToken", () => {
  async function pendingClaim() {
    const { db, state } = fakeDb();
    const { mailer, sent } = fakeMailer();
    await requestClaim(deps(db, mailer), { userId: "user-1", email: "human@example.com" });
    return { db, state, token: tokenFrom(sent[0].url!) };
  }

  it("resolves a pending token to the page summary", async () => {
    const { db, token } = await pendingClaim();
    const summary = await validateClaimToken(db, token, NOW);
    expect(summary).toEqual({
      email: "human@example.com",
      vaultName: "Agent Vault",
      keyName: "agent-signup",
      keyPrefix: "bz_a1B2c…",
      createdAt: new Date("2026-07-09T00:00:00.000Z"),
      expiresAt: new Date(NOW.getTime() + CLAIM_TTL_MS),
    });
  });

  it("unknown token → null", async () => {
    const { db } = await pendingClaim();
    expect(await validateClaimToken(db, mintClaimToken(), NOW)).toBeNull();
  });

  it("expired token → null", async () => {
    const { db, token } = await pendingClaim();
    const afterExpiry = new Date(NOW.getTime() + CLAIM_TTL_MS + 1);
    expect(await validateClaimToken(db, token, afterExpiry)).toBeNull();
  });

  it("already-approved token → null (single-use)", async () => {
    const { db, token } = await pendingClaim();
    expect((await approveClaim(db, token, NOW)).ok).toBe(true);
    expect(await validateClaimToken(db, token, NOW)).toBeNull();
  });
});

// ------------------------------------------------------------- approveClaim

describe("approveClaim", () => {
  async function pendingClaim(dbOverrides: Partial<FakeState> = {}) {
    const { db, state } = fakeDb(dbOverrides);
    const { mailer, sent } = fakeMailer();
    await requestClaim(deps(db, mailer), { userId: "user-1", email: "human@example.com" });
    return { db, state, token: tokenFrom(sent[0].url!) };
  }

  it("new email → promotes in place: binds email, verifies, clears expiry, fixes the placeholder name", async () => {
    const { db, state, token } = await pendingClaim();
    const result = await approveClaim(db, token, NOW);
    expect(result).toEqual({
      ok: true,
      userId: "user-1",
      email: "human@example.com",
      reconciled: false,
    });

    expect(state.approvals).toHaveLength(1);
    expect(state.approvals[0]).toMatchObject({
      userId: "user-1",
      email: "human@example.com",
      name: "human", // placeholder "Unclaimed workspace" → email local part
      at: NOW,
    });
    expect(state.reconciles).toHaveLength(0);
    const owner = state.users.get("user-1")!;
    expect(owner.email).toBe("human@example.com");
    expect(owner.expiresAt).toBeNull();
    expect(state.claims[0].approvedAt).toEqual(NOW);
  });

  it("keeps a non-placeholder name as-is", async () => {
    const { db, state, token } = await pendingClaim({
      users: new Map([["user-1", { ...provisionalOwner(), name: "Custom name" }]]),
    });
    expect((await approveClaim(db, token, NOW)).ok).toBe(true);
    expect(state.approvals[0].name).toBe("Custom name");
  });

  it("expired token → invalid, nothing changed", async () => {
    const { db, state, token } = await pendingClaim();
    const afterExpiry = new Date(NOW.getTime() + CLAIM_TTL_MS + 1);
    const result = await approveClaim(db, token, afterExpiry);
    expect(result).toMatchObject({ ok: false, reason: "invalid" });
    expect(result.ok === false && result.message).toMatch(/request a new claim/);
    expect(state.approvals).toHaveLength(0);
  });

  it("a consumed token never approves twice (single-use)", async () => {
    const { db, state, token } = await pendingClaim();
    expect((await approveClaim(db, token, NOW)).ok).toBe(true);
    const again = await approveClaim(db, token, NOW);
    expect(again).toMatchObject({ ok: false, reason: "invalid" });
    expect(state.approvals).toHaveLength(1);
  });

  it("existing email → RECONCILES: vault moves to the existing user, provisional user deleted", async () => {
    // The incident scenario: james@ already has a real account; an agent
    // provisioned a vault under a provisional user; approval must attach the
    // vault to the real account and remove the provisional identity.
    const { db, state } = fakeDb();
    registerUser(state, "james", "human@example.com"); // existing account, no vaults yet
    const { mailer, sent } = fakeMailer();
    await requestClaim(deps(db, mailer), { userId: "user-1", email: "human@example.com" });
    const token = tokenFrom(sent[0].url!);

    const result = await approveClaim(db, token, NOW);
    expect(result).toEqual({
      ok: true,
      userId: "james",
      email: "human@example.com",
      reconciled: true,
    });

    // The vault now belongs to the existing user (visible in their dashboard).
    expect(state.vaults.get("vault-1")!.ownerId).toBe("james");
    // The provisional user is gone — no duplicate identity survives.
    expect(state.users.has("user-1")).toBe(false);
    // In-place promotion did NOT run.
    expect(state.approvals).toHaveLength(0);
    expect(state.reconciles).toHaveLength(1);
    // The reconcile was atomic (one batch call) and stamped the claim.
    expect(state.claims.find((c) => c.userId === "james")).toBeUndefined();
  });

  it("existing email with a slug collision → the moved vault's slug is deduped", async () => {
    const { db, state } = fakeDb();
    // Existing user already owns a vault with the SAME slug the provisional
    // vault carries ("agent-vault") — the move must rename to avoid the
    // (owner_id, slug) unique-index clash.
    registerUser(state, "james", "human@example.com", ["agent-vault"]);
    const { mailer, sent } = fakeMailer();
    await requestClaim(deps(db, mailer), { userId: "user-1", email: "human@example.com" });
    const token = tokenFrom(sent[0].url!);

    const result = await approveClaim(db, token, NOW);
    expect(result.ok).toBe(true);

    const moved = state.vaults.get("vault-1")!;
    expect(moved.ownerId).toBe("james");
    expect(moved.slug).toBe("agent-vault-2"); // deduped
    // The existing user now owns BOTH vaults, with distinct slugs.
    const jamesSlugs = [...state.vaults.values()]
      .filter((v) => v.ownerId === "james")
      .map((v) => v.slug)
      .sort();
    expect(jamesSlugs).toEqual(["agent-vault", "agent-vault-2"]);
    expect(state.reconciles[0].vaultRenames).toEqual([{ vaultId: "vault-1", slug: "agent-vault-2" }]);
  });

  it("existing email matched case-insensitively (James@… vs james@…)", async () => {
    const { db, state } = fakeDb();
    registerUser(state, "james", "James@Example.com");
    const { mailer, sent } = fakeMailer();
    // Agent supplies a differently-cased address; requestClaim lowercases it.
    await requestClaim(deps(db, mailer), { userId: "user-1", email: "JAMES@example.com" });
    const token = tokenFrom(sent[0].url!);
    const result = await approveClaim(db, token, NOW);
    expect(result).toMatchObject({ ok: true, userId: "james", reconciled: true });
    expect(state.vaults.get("vault-1")!.ownerId).toBe("james");
    expect(state.users.has("user-1")).toBe(false);
  });

  it("unknown token → invalid", async () => {
    const { db } = await pendingClaim();
    expect(await approveClaim(db, mintClaimToken(), NOW)).toMatchObject({
      ok: false,
      reason: "invalid",
    });
  });
});

// ------------------------------------------------------------- declineClaim

describe("declineClaim", () => {
  it("deletes the pending claim; the token stops validating and approving", async () => {
    const { db, state } = fakeDb();
    const { mailer, sent } = fakeMailer();
    await requestClaim(deps(db, mailer), { userId: "user-1", email: "human@example.com" });
    const token = tokenFrom(sent[0].url!);

    await declineClaim(db, token);
    expect(state.claims).toHaveLength(0);
    expect(await validateClaimToken(db, token, NOW)).toBeNull();
    expect(await approveClaim(db, token, NOW)).toMatchObject({ ok: false, reason: "invalid" });
    // The owner stays provisional — the workspace expires on schedule.
    expect(state.users.get("user-1")!.expiresAt).not.toBeNull();
  });

  it("is idempotent for unknown tokens", async () => {
    const { db } = fakeDb();
    await expect(declineClaim(db, mintClaimToken())).resolves.toBeUndefined();
  });
});

// ---------------------------------------------------------- handleClaimTool

describe("handleClaimTool (cloud-only MCP tool)", () => {
  function toolDeps(db: ClaimDb, mailer: Mailer) {
    return { ...deps(db, mailer), ownerId: "user-1" };
  }

  it("returns strict {status: 'sent', expiresAt} and NEVER the approval URL", async () => {
    const { db } = fakeDb();
    const { mailer, sent } = fakeMailer();
    const result = await handleClaimTool({ email: "human@example.com" }, toolDeps(db, mailer));
    expect(result.isError ?? false).toBe(false);
    const payload = JSON.parse(result.content[0].text);
    expect(payload).toEqual({
      status: "sent",
      expiresAt: new Date(NOW.getTime() + CLAIM_TTL_MS).toISOString(),
    });
    // The emailed URL (and its token) never appear in any content block.
    const everything = result.content.map((c) => c.text).join("\n");
    expect(everything).not.toContain(tokenFrom(sent[0].url!));
    expect(everything).not.toMatch(/https?:\/\//);
  });

  it("output is identical for an already-registered address (no oracle)", async () => {
    const { db, state } = fakeDb();
    registerUser(state, "existing-user", "human@example.com");
    const { mailer } = fakeMailer();
    const result = await handleClaimTool({ email: "human@example.com" }, toolDeps(db, mailer));
    expect(result.isError ?? false).toBe(false);
    expect(JSON.parse(result.content[0].text)).toEqual({
      status: "sent",
      expiresAt: new Date(NOW.getTime() + CLAIM_TTL_MS).toISOString(),
    });
  });

  it("already-claimed workspace → isError with settings guidance", async () => {
    const { db } = fakeDb({
      users: new Map([
        ["user-1", { ...provisionalOwner(), email: "h@x.com", expiresAt: null }],
      ]),
    });
    const { mailer } = fakeMailer();
    const result = await handleClaimTool({ email: "human@example.com" }, toolDeps(db, mailer));
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toMatch(/already claimed/);
  });

  it("throttled → isError mentioning the rate limit", async () => {
    // Inclusive (count > limit) guard: over the cap trips the throttle.
    const { db } = fakeDb({ emailCount: MAGIC_LINK_EMAIL_LIMIT + 1 });
    const { mailer } = fakeMailer();
    const result = await handleClaimTool({ email: "human@example.com" }, toolDeps(db, mailer));
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toMatch(/rate limit/i);
  });

  it("invalid email → isError, and unexpected throws become isError too", async () => {
    const { db } = fakeDb();
    const { mailer } = fakeMailer();
    const bad = await handleClaimTool({ email: "nope" }, toolDeps(db, mailer));
    expect(bad.isError).toBe(true);

    const exploding = fakeDb();
    exploding.db.getUserById = async () => {
      throw new Error("D1 exploded");
    };
    const thrown = await handleClaimTool(
      { email: "human@example.com" },
      toolDeps(exploding.db, mailer),
    );
    expect(thrown.isError).toBe(true);
    expect(thrown.content[0].text).toContain("D1 exploded");
  });
});
