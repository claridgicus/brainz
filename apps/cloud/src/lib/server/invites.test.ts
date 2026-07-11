/**
 * The invite domain (Wave M) against fake ports:
 *   create   — happy path (hashed token at rest, +14d, emailed URL returned
 *              once), supersede, already-a-member 409, rate-limit 429,
 *              email normalization
 *   list     — pending only (accepted + expired filtered out)
 *   revoke   — pending deleted; unknown/consumed → false
 *   resend   — new token (old link dead), fresh expiry, re-emailed, throttle
 *   validate — valid / unknown / expired / consumed
 *   accept   — happy (member row + accepted_at atomically), case-insensitive
 *              email match REQUIRED (mismatch → clear error), single-use,
 *              expired, already-member idempotency
 */
// invites.ts → auth.ts → $app/server (SvelteKit runtime only) — stub it.
import { describe, expect, it, vi } from "vitest";
vi.mock("$app/server", () => ({ getRequestEvent: () => ({}) }));

import type { VaultRole } from "@brainz/contracts";
import {
  acceptInvite,
  createInvite,
  hashInviteToken,
  INVITE_INVALID_MESSAGE,
  INVITE_TTL_MS,
  listInvites,
  resendInvite,
  revokeInvite,
  validateInviteToken,
  type InviteDb,
  type InviteDeps,
  type InviteRow,
} from "./invites";
import { MAGIC_LINK_EMAIL_LIMIT } from "./rate-limit";
import type { Mailer } from "./mailer";

const NOW = new Date("2026-07-10T00:00:00.000Z");
const VAULT = { id: "vault-1", slug: "acme-brain", name: "Acme Brain" };
const OWNER = { id: "owner-1", name: "James" };

interface SentInvite {
  to: string;
  url: string;
  vaultName: string;
  role: string;
}

function fakeMailer() {
  const sent: SentInvite[] = [];
  const mailer: Mailer = {
    async sendMagicLink() {},
    async sendInvite(args) {
      sent.push(args);
    },
  };
  return { mailer, sent };
}

interface FakeState {
  invites: InviteRow[];
  members: Map<string, VaultRole>; // userId → role (single-vault fake)
  usersByEmail: Map<string, { id: string }>;
  emailCount: number;
  ipCount: number;
  magicLinkEvents: { email: string; ip: string }[];
}

function fakeDb(overrides: Partial<FakeState> = {}) {
  const state: FakeState = {
    invites: [],
    members: new Map([[OWNER.id, "owner"]]),
    usersByEmail: new Map([["james@example.com", { id: OWNER.id }]]),
    emailCount: 0,
    ipCount: 0,
    magicLinkEvents: [],
    ...overrides,
  };
  const inviterName = (invitedBy: string) => (invitedBy === OWNER.id ? OWNER.name : invitedBy);
  const join = (row: InviteRow) => ({ ...row, invitedByName: inviterName(row.invitedBy) });
  const db: InviteDb = {
    getVault: async (vaultId) => (vaultId === VAULT.id ? VAULT : null),
    findUserByEmail: async (email) => state.usersByEmail.get(email.toLowerCase()) ?? null,
    getMemberRole: async (vaultId, userId) =>
      vaultId === VAULT.id ? (state.members.get(userId) ?? null) : null,
    insertMember: async (row) => {
      state.members.set(row.userId, row.role);
    },
    deletePendingInvites: async (vaultId, email) => {
      state.invites = state.invites.filter(
        (i) => i.vaultId !== vaultId || i.email !== email || i.acceptedAt !== null,
      );
    },
    insertInvite: async (row) => {
      state.invites.push({ ...row });
    },
    listPendingInvites: async (vaultId) =>
      state.invites.filter((i) => i.vaultId === vaultId && i.acceptedAt === null).map(join),
    getInviteById: async (vaultId, inviteId) => {
      const row = state.invites.find((i) => i.vaultId === vaultId && i.id === inviteId);
      return row ? join(row) : null;
    },
    getInviteByHash: async (tokenHash) => {
      const row = state.invites.find((i) => i.tokenHash === tokenHash);
      return row ? join(row) : null;
    },
    deleteInvite: async (inviteId) => {
      state.invites = state.invites.filter((i) => i.id !== inviteId);
    },
    refreshInviteToken: async (inviteId, tokenHash, expiresAt) => {
      state.invites = state.invites.map((i) =>
        i.id === inviteId ? { ...i, tokenHash, expiresAt } : i,
      );
    },
    stampAccepted: async (inviteId, at) => {
      state.invites = state.invites.map((i) => (i.id === inviteId ? { ...i, acceptedAt: at } : i));
    },
    acceptAtomically: async ({ inviteId, member }) => {
      state.members.set(member.userId, member.role);
      state.invites = state.invites.map((i) =>
        i.id === inviteId ? { ...i, acceptedAt: member.createdAt } : i,
      );
    },
    guard: {
      now: () => NOW,
      record: async (e) => {
        state.magicLinkEvents.push({ email: e.email, ip: e.ip });
        state.emailCount++;
        state.ipCount++;
      },
      countRecentByEmail: async () => state.emailCount,
      countRecentByIp: async () => state.ipCount,
    },
  };
  return { db, state };
}

function deps(db: InviteDb, mailer: Mailer): InviteDeps {
  return { db, mailer, origin: "https://brainz.brownmatter.ai", ip: "203.0.113.7", now: () => NOW };
}

function createArgs(email = "colleague@example.com", role: VaultRole = "editor") {
  return { vaultId: VAULT.id, email, role, invitedByUserId: OWNER.id, invitedByName: OWNER.name };
}

const tokenFrom = (url: string) => url.split("/invite/")[1];

describe("createInvite", () => {
  it("stores a HASHED 14-day token, emails the link, and returns the one-time URL + wire invite", async () => {
    const { db, state } = fakeDb();
    const { mailer, sent } = fakeMailer();
    const result = await createInvite(deps(db, mailer), createArgs());
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    // The URL is <origin>/invite/<64-hex token> and was emailed with the
    // vault name + role (the Wave M sendInvite shape).
    expect(result.url).toMatch(/^https:\/\/brainz\.brownmatter\.ai\/invite\/[0-9a-f]{64}$/);
    expect(sent).toEqual([
      { to: "colleague@example.com", url: result.url, vaultName: "Acme Brain", role: "editor" },
    ]);

    // Wire shape: inviter's display name, ISO dates, +14d expiry.
    expect(result.invite).toMatchObject({ email: "colleague@example.com", role: "editor", invitedBy: "James" });
    expect(result.invite.expiresAt).toBe(new Date(NOW.getTime() + INVITE_TTL_MS).toISOString());

    // At rest: only the SHA-256 hash — never the token itself.
    const token = tokenFrom(result.url);
    expect(state.invites).toHaveLength(1);
    expect(state.invites[0].tokenHash).toBe(await hashInviteToken(token));
    expect(JSON.stringify(state.invites)).not.toContain(token);
  });

  it("normalizes the invited email through the shared choke-point", async () => {
    const { db, state } = fakeDb();
    const { mailer, sent } = fakeMailer();
    const result = await createInvite(deps(db, mailer), createArgs("  Colleague@Example.COM "));
    expect(result.ok).toBe(true);
    expect(state.invites[0].email).toBe("colleague@example.com");
    expect(sent[0].to).toBe("colleague@example.com");
    // The rate-limit bucket is keyed on the normalized email too.
    expect(state.magicLinkEvents[0].email).toBe("colleague@example.com");
  });

  it("a new invite for the same (vault, email) SUPERSEDES the pending one — the old link dies", async () => {
    const { db, state } = fakeDb();
    const { mailer } = fakeMailer();
    const first = await createInvite(deps(db, mailer), createArgs("colleague@example.com", "viewer"));
    const second = await createInvite(deps(db, mailer), createArgs("colleague@example.com", "editor"));
    expect(first.ok && second.ok).toBe(true);
    if (!first.ok || !second.ok) return;

    expect(state.invites).toHaveLength(1);
    expect(state.invites[0].role).toBe("editor");
    // The superseded token no longer validates; the new one does.
    expect(await validateInviteToken(db, tokenFrom(first.url), NOW)).toBeNull();
    expect(await validateInviteToken(db, tokenFrom(second.url), NOW)).not.toBeNull();
  });

  it("inviting an address that is already a member → 409", async () => {
    const { db } = fakeDb(); // james@example.com IS the owner
    const { mailer, sent } = fakeMailer();
    const result = await createInvite(deps(db, mailer), createArgs("James@example.com"));
    expect(result).toMatchObject({ ok: false, status: 409 });
    expect(sent).toHaveLength(0);
  });

  it("is rate-limited through the shared magic-link guard (emails to arbitrary addresses)", async () => {
    const { db, state } = fakeDb({ emailCount: MAGIC_LINK_EMAIL_LIMIT });
    const { mailer, sent } = fakeMailer();
    const result = await createInvite(deps(db, mailer), createArgs());
    expect(result).toMatchObject({ ok: false, status: 429 });
    expect(result.ok === false && /rate limit/.test(result.message)).toBe(true);
    expect(sent).toHaveLength(0);
    expect(state.invites).toHaveLength(0);
  });
});

describe("listInvites / revokeInvite", () => {
  it("lists PENDING invites only — consumed and expired ones disappear", async () => {
    const { db, state } = fakeDb();
    const { mailer } = fakeMailer();
    await createInvite(deps(db, mailer), createArgs("a@example.com"));
    await createInvite(deps(db, mailer), createArgs("b@example.com"));
    await createInvite(deps(db, mailer), createArgs("c@example.com"));
    state.invites[0].acceptedAt = NOW; // consumed
    state.invites[1].expiresAt = new Date(NOW.getTime() - 1); // expired

    const pending = await listInvites(db, VAULT.id, NOW);
    expect(pending.map((i) => i.email)).toEqual(["c@example.com"]);
    // The list shape never carries a URL or token material.
    expect(JSON.stringify(pending)).not.toMatch(/url|token/i);
  });

  it("revokes a pending invite; unknown or consumed → false", async () => {
    const { db, state } = fakeDb();
    const { mailer } = fakeMailer();
    const created = await createInvite(deps(db, mailer), createArgs());
    expect(created.ok).toBe(true);
    if (!created.ok) return;
    expect(await revokeInvite(db, VAULT.id, "nope")).toBe(false);
    expect(await revokeInvite(db, VAULT.id, created.invite.id)).toBe(true);
    expect(state.invites).toHaveLength(0);
    // The revoked link is dead.
    expect(await validateInviteToken(db, tokenFrom(created.url), NOW)).toBeNull();
  });
});

describe("resendInvite", () => {
  it("mints a NEW token (old link dead), extends the expiry, and re-emails", async () => {
    const { db } = fakeDb();
    const { mailer, sent } = fakeMailer();
    const created = await createInvite(deps(db, mailer), createArgs());
    expect(created.ok).toBe(true);
    if (!created.ok) return;

    const later = new Date(NOW.getTime() + 1000);
    const resent = await resendInvite(
      { db, mailer, origin: "https://brainz.brownmatter.ai", ip: "203.0.113.7", now: () => later },
      { vaultId: VAULT.id, inviteId: created.invite.id },
    );
    expect(resent.ok).toBe(true);
    if (!resent.ok) return;

    expect(resent.url).not.toBe(created.url);
    expect(sent).toHaveLength(2);
    expect(sent[1].url).toBe(resent.url);
    expect(resent.invite.expiresAt).toBe(new Date(later.getTime() + INVITE_TTL_MS).toISOString());
    // Old token dead, new token live.
    expect(await validateInviteToken(db, tokenFrom(created.url), later)).toBeNull();
    expect(await validateInviteToken(db, tokenFrom(resent.url), later)).not.toBeNull();
  });

  it("unknown or consumed invite → 404; throttle → 429 without a new token", async () => {
    const { db, state } = fakeDb();
    const { mailer } = fakeMailer();
    const created = await createInvite(deps(db, mailer), createArgs());
    if (!created.ok) throw new Error("setup failed");

    expect(
      await resendInvite(deps(db, mailer), { vaultId: VAULT.id, inviteId: "nope" }),
    ).toMatchObject({ ok: false, status: 404 });

    state.emailCount = MAGIC_LINK_EMAIL_LIMIT;
    const throttled = await resendInvite(deps(db, mailer), {
      vaultId: VAULT.id,
      inviteId: created.invite.id,
    });
    expect(throttled).toMatchObject({ ok: false, status: 429 });
    // The stored token was NOT rotated on the throttled attempt.
    expect(await validateInviteToken(db, tokenFrom(created.url), NOW)).not.toBeNull();
  });
});

describe("validateInviteToken", () => {
  it("resolves a live token to the invite + vault; garbage/expired/consumed → null", async () => {
    const { db, state } = fakeDb();
    const { mailer } = fakeMailer();
    const created = await createInvite(deps(db, mailer), createArgs());
    if (!created.ok) throw new Error("setup failed");
    const token = tokenFrom(created.url);

    const summary = await validateInviteToken(db, token, NOW);
    expect(summary?.vault).toEqual(VAULT);
    expect(summary?.invite).toMatchObject({
      email: "colleague@example.com",
      role: "editor",
      invitedByName: "James",
    });

    expect(await validateInviteToken(db, "0".repeat(64), NOW)).toBeNull();
    // Expired (the exact expiry instant is already invalid).
    expect(
      await validateInviteToken(db, token, new Date(NOW.getTime() + INVITE_TTL_MS)),
    ).toBeNull();
    // Consumed.
    state.invites[0].acceptedAt = NOW;
    expect(await validateInviteToken(db, token, NOW)).toBeNull();
  });
});

describe("acceptInvite", () => {
  async function inviteToken(db: InviteDb, mailer: Mailer, email = "colleague@example.com") {
    const created = await createInvite(deps(db, mailer), createArgs(email));
    if (!created.ok) throw new Error("setup failed");
    return { token: tokenFrom(created.url), inviteId: created.invite.id };
  }

  it("happy path: membership created with the invite's role, invite consumed, vault slug returned", async () => {
    const { db, state } = fakeDb();
    const { mailer } = fakeMailer();
    const { token } = await inviteToken(db, mailer);

    const result = await acceptInvite(
      db,
      { token, userId: "user-2", userEmail: "colleague@example.com" },
      NOW,
    );
    expect(result).toEqual({
      ok: true,
      vaultId: VAULT.id,
      slug: VAULT.slug,
      role: "editor",
      alreadyMember: false,
    });
    expect(state.members.get("user-2")).toBe("editor");
    expect(state.invites[0].acceptedAt).toEqual(NOW);
  });

  it("email match is case-insensitive (the invited human signs in as Colleague@Example.COM)", async () => {
    const { db, state } = fakeDb();
    const { mailer } = fakeMailer();
    const { token } = await inviteToken(db, mailer);
    const result = await acceptInvite(
      db,
      { token, userId: "user-2", userEmail: "Colleague@Example.COM" },
      NOW,
    );
    expect(result).toMatchObject({ ok: true, role: "editor" });
    expect(state.members.get("user-2")).toBe("editor");
  });

  it("a DIFFERENT signed-in email is a clear mismatch error — never a silent grant", async () => {
    const { db, state } = fakeDb();
    const { mailer } = fakeMailer();
    const { token } = await inviteToken(db, mailer);
    const result = await acceptInvite(
      db,
      { token, userId: "user-3", userEmail: "someone-else@example.com" },
      NOW,
    );
    expect(result).toMatchObject({ ok: false, reason: "email-mismatch" });
    expect(result.ok === false && result.message).toContain("colleague@example.com");
    expect(result.ok === false && result.message).toContain("someone-else@example.com");
    expect(state.members.has("user-3")).toBe(false);
    expect(state.invites[0].acceptedAt).toBeNull(); // still acceptable by the right account
  });

  it("expired token → invalid", async () => {
    const { db } = fakeDb();
    const { mailer } = fakeMailer();
    const { token } = await inviteToken(db, mailer);
    const result = await acceptInvite(
      db,
      { token, userId: "user-2", userEmail: "colleague@example.com" },
      new Date(NOW.getTime() + INVITE_TTL_MS + 1),
    );
    expect(result).toEqual({ ok: false, reason: "invalid", message: INVITE_INVALID_MESSAGE });
  });

  it("single-use: a consumed token never accepts twice", async () => {
    const { db } = fakeDb();
    const { mailer } = fakeMailer();
    const { token } = await inviteToken(db, mailer);
    const first = await acceptInvite(
      db,
      { token, userId: "user-2", userEmail: "colleague@example.com" },
      NOW,
    );
    expect(first.ok).toBe(true);
    const again = await acceptInvite(
      db,
      { token, userId: "user-9", userEmail: "colleague@example.com" },
      NOW,
    );
    expect(again).toMatchObject({ ok: false, reason: "invalid" });
  });

  it("already a member → idempotent success keeping the EXISTING role; invite still consumed", async () => {
    const { db, state } = fakeDb();
    const { mailer } = fakeMailer();
    state.members.set("user-2", "owner"); // somehow already in (e.g. reconciled)
    const { token } = await inviteToken(db, mailer);
    const result = await acceptInvite(
      db,
      { token, userId: "user-2", userEmail: "colleague@example.com" },
      NOW,
    );
    expect(result).toMatchObject({ ok: true, alreadyMember: true, role: "owner" });
    expect(state.members.get("user-2")).toBe("owner"); // NOT demoted to the invite's editor
    expect(state.invites[0].acceptedAt).toEqual(NOW);
  });

  it("unknown token → invalid with the ask-for-a-new-invite guidance", async () => {
    const { db } = fakeDb();
    const result = await acceptInvite(
      db,
      { token: "f".repeat(64), userId: "user-2", userEmail: "colleague@example.com" },
      NOW,
    );
    expect(result).toEqual({ ok: false, reason: "invalid", message: INVITE_INVALID_MESSAGE });
  });
});
