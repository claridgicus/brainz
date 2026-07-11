/**
 * The vault-invite domain (Wave M — vault membership & email invites).
 *
 * Model: an OWNER invites an email with a role (owner | editor | viewer). We
 * mint a 32-byte token (SHA-256 hash at rest, 14-day TTL), store the invite,
 * and EMAIL `<origin>/invite/<token>` via the Mailer. The create/resend
 * responses ALSO return that one-time URL (copyable in the UI) — but the LIST
 * endpoint can never reproduce it, because only the hash is stored. A new
 * invite for the same (vault, email) supersedes the pending one.
 *
 * Accepting requires a session whose email matches the invite's
 * (case-insensitively, via the shared normalizeEmail choke-point); mismatch,
 * expiry, and reuse are clear errors. Acceptance creates the `vault_member`
 * row with the invite's role and stamps `accepted_at` (single-use); an
 * acceptor who is somehow already a member is an idempotent success.
 *
 * Invite creation/resend sends email to arbitrary addresses — the same abuse
 * surface as magic-link requests — so both are counted in `magic_link_events`
 * under the existing durable guard (5/hour/email, 20/hour/IP).
 *
 * Everything runs against the small `InviteDb` port so the flows are
 * unit-testable without a Workers/D1 runtime; `inviteDbFrom` wires it to
 * drizzle/D1 (ports-and-fakes, same style as $lib/server/claim).
 */
import type { RequestEvent } from "@sveltejs/kit";
import type { VaultInvite, VaultRole } from "@brainz/contracts";
import { and, eq, isNull, sql } from "drizzle-orm";
import { HttpError, requirePlatform } from "./api-util";
import { isProductionEnv } from "./auth";
// One token implementation system-wide: 32 random bytes hex + SHA-256 at rest
// (identical requirements to Wave G's claim tokens — reuse, don't fork).
import { hashClaimToken as hashInviteToken, mintClaimToken as mintInviteToken } from "./claim";
import type { Db } from "./db";
import { createDb, schema } from "./db";
import { normalizeEmail } from "./email";
import { guardDepsFromDb, guardMagicLinkRequest, type GuardDeps } from "./magic-link-guard";
import { createMailer, type Mailer } from "./mailer";
import { MAGIC_LINK_EMAIL_LIMIT, MAGIC_LINK_IP_LIMIT, resolveRateLimitIp } from "./rate-limit";

export { hashInviteToken, mintInviteToken };

/** Invites live 14 days. */
export const INVITE_TTL_MS = 14 * 24 * 60 * 60 * 1000;

// --------------------------------------------------------------------- port

export interface InviteRow {
  id: string;
  vaultId: string;
  email: string;
  role: VaultRole;
  tokenHash: string;
  /** Inviter's user id (the wire shape carries their display name instead). */
  invitedBy: string;
  createdAt: Date;
  expiresAt: Date;
  acceptedAt: Date | null;
}

/** An invite joined with its inviter's display name (for the wire shape). */
export interface InviteJoined extends InviteRow {
  invitedByName: string;
}

export interface InviteVault {
  id: string;
  slug: string;
  name: string;
}

/**
 * Persistence port for the invite domain (drizzle/D1 in prod via
 * `inviteDbFrom`, fakes in tests).
 */
export interface InviteDb {
  getVault(vaultId: string): Promise<InviteVault | null>;
  /** Existing user for this (normalized) email, case-insensitively, or null. */
  findUserByEmail(email: string): Promise<{ id: string } | null>;
  getMemberRole(vaultId: string, userId: string): Promise<VaultRole | null>;
  insertMember(row: {
    id: string;
    vaultId: string;
    userId: string;
    role: VaultRole;
    createdAt: Date;
  }): Promise<void>;
  /** Supersede: delete pending (unaccepted) invites for (vault, email). */
  deletePendingInvites(vaultId: string, email: string): Promise<void>;
  insertInvite(row: InviteRow): Promise<void>;
  /** Pending = unaccepted; expiry is filtered by the caller against `now`. */
  listPendingInvites(vaultId: string): Promise<InviteJoined[]>;
  getInviteById(vaultId: string, inviteId: string): Promise<InviteJoined | null>;
  getInviteByHash(tokenHash: string): Promise<InviteJoined | null>;
  deleteInvite(inviteId: string): Promise<void>;
  /** Resend: swap in a fresh token hash + expiry (single stored token). */
  refreshInviteToken(inviteId: string, tokenHash: string, expiresAt: Date): Promise<void>;
  /** Stamp consumption (single-use). */
  stampAccepted(inviteId: string, at: Date): Promise<void>;
  /** Atomic accept: create the membership AND stamp the invite consumed. */
  acceptAtomically(args: {
    inviteId: string;
    member: { id: string; vaultId: string; userId: string; role: VaultRole; createdAt: Date };
  }): Promise<void>;
  /** Rate-limit counters over magic_link_events (shared with the sign-in guard). */
  guard: GuardDeps;
}

/** Wire the invite domain to the D1 control plane. */
export function inviteDbFrom(db: Db): InviteDb {
  const joined = {
    id: schema.vaultInvite.id,
    vaultId: schema.vaultInvite.vaultId,
    email: schema.vaultInvite.email,
    role: schema.vaultInvite.role,
    tokenHash: schema.vaultInvite.tokenHash,
    invitedBy: schema.vaultInvite.invitedBy,
    createdAt: schema.vaultInvite.createdAt,
    expiresAt: schema.vaultInvite.expiresAt,
    acceptedAt: schema.vaultInvite.acceptedAt,
    invitedByName: schema.user.name,
  };
  const toJoined = (r: Omit<InviteJoined, "role"> & { role: string }): InviteJoined => ({
    ...r,
    role: r.role as VaultRole,
  });
  return {
    getVault: async (vaultId) => {
      const rows = await db
        .select({ id: schema.vault.id, slug: schema.vault.slug, name: schema.vault.name })
        .from(schema.vault)
        .where(eq(schema.vault.id, vaultId))
        .limit(1);
      return rows[0] ?? null;
    },
    findUserByEmail: async (email) => {
      // Normalize the input AND lower() the column (belt-and-suspenders, same
      // rationale as claimDbFrom.findUserByEmail).
      const normalized = normalizeEmail(email);
      const rows = await db
        .select({ id: schema.user.id })
        .from(schema.user)
        .where(eq(sql`lower(${schema.user.email})`, normalized))
        .limit(1);
      return rows[0] ?? null;
    },
    getMemberRole: async (vaultId, userId) => {
      const rows = await db
        .select({ role: schema.vaultMember.role })
        .from(schema.vaultMember)
        .where(and(eq(schema.vaultMember.vaultId, vaultId), eq(schema.vaultMember.userId, userId)))
        .limit(1);
      return rows.length > 0 ? (rows[0].role as VaultRole) : null;
    },
    insertMember: async (row) => {
      await db.insert(schema.vaultMember).values(row);
    },
    deletePendingInvites: async (vaultId, email) => {
      await db
        .delete(schema.vaultInvite)
        .where(
          and(
            eq(schema.vaultInvite.vaultId, vaultId),
            eq(schema.vaultInvite.email, normalizeEmail(email)),
            isNull(schema.vaultInvite.acceptedAt),
          ),
        );
    },
    insertInvite: async (row) => {
      await db.insert(schema.vaultInvite).values(row);
    },
    listPendingInvites: async (vaultId) => {
      const rows = await db
        .select(joined)
        .from(schema.vaultInvite)
        .innerJoin(schema.user, eq(schema.vaultInvite.invitedBy, schema.user.id))
        .where(and(eq(schema.vaultInvite.vaultId, vaultId), isNull(schema.vaultInvite.acceptedAt)))
        .orderBy(schema.vaultInvite.createdAt);
      return rows.map(toJoined);
    },
    getInviteById: async (vaultId, inviteId) => {
      const rows = await db
        .select(joined)
        .from(schema.vaultInvite)
        .innerJoin(schema.user, eq(schema.vaultInvite.invitedBy, schema.user.id))
        .where(and(eq(schema.vaultInvite.vaultId, vaultId), eq(schema.vaultInvite.id, inviteId)))
        .limit(1);
      return rows.length > 0 ? toJoined(rows[0]) : null;
    },
    getInviteByHash: async (tokenHash) => {
      const rows = await db
        .select(joined)
        .from(schema.vaultInvite)
        .innerJoin(schema.user, eq(schema.vaultInvite.invitedBy, schema.user.id))
        .where(eq(schema.vaultInvite.tokenHash, tokenHash))
        .limit(1);
      return rows.length > 0 ? toJoined(rows[0]) : null;
    },
    deleteInvite: async (inviteId) => {
      await db.delete(schema.vaultInvite).where(eq(schema.vaultInvite.id, inviteId));
    },
    refreshInviteToken: async (inviteId, tokenHash, expiresAt) => {
      await db
        .update(schema.vaultInvite)
        .set({ tokenHash, expiresAt })
        .where(eq(schema.vaultInvite.id, inviteId));
    },
    stampAccepted: async (inviteId, at) => {
      await db
        .update(schema.vaultInvite)
        .set({ acceptedAt: at })
        .where(eq(schema.vaultInvite.id, inviteId));
    },
    acceptAtomically: async ({ inviteId, member }) => {
      // One D1 batch = one implicit transaction: membership + consumption
      // land together or not at all.
      await db.batch([
        db.insert(schema.vaultMember).values(member),
        db
          .update(schema.vaultInvite)
          .set({ acceptedAt: member.createdAt })
          .where(eq(schema.vaultInvite.id, inviteId)),
      ]);
    },
    guard: guardDepsFromDb(db),
  };
}

// -------------------------------------------------------------- wire shapes

/** Contract wire shape (vaultInviteSchema): invitedBy is the DISPLAY NAME. */
export function toInviteWire(invite: InviteJoined): VaultInvite {
  return {
    id: invite.id,
    email: invite.email,
    role: invite.role,
    createdAt: invite.createdAt.toISOString(),
    expiresAt: invite.expiresAt.toISOString(),
    invitedBy: invite.invitedByName,
  };
}

// ------------------------------------------------------------ create invite

export interface InviteDeps {
  db: InviteDb;
  mailer: Mailer;
  /** Request origin the invite URL is built on, e.g. https://brainz.brownmatter.ai */
  origin: string;
  /** Client IP (CF-Connecting-IP) — one of the two rate-limit keys. */
  ip: string;
  now(): Date;
}

export type InviteCreateResult =
  | { ok: true; invite: VaultInvite; url: string }
  | { ok: false; status: number; message: string };

/**
 * Wire InviteDeps from a request event (routes + the /invite page action).
 * Invites email arbitrary addresses, so the client IP is a rate-limit key —
 * fail closed on a missing cf-connecting-ip in production, exactly like the
 * magic-link request path.
 */
export function inviteDepsFrom(event: RequestEvent): InviteDeps {
  const platform = requirePlatform(event);
  const resolvedIp = resolveRateLimitIp(
    event.request.headers.get("cf-connecting-ip"),
    isProductionEnv(platform.env),
  );
  if (!resolvedIp.ok) {
    throw new HttpError(429, "rate limited: missing client IP; retry through the edge");
  }
  return {
    db: inviteDbFrom(createDb(platform.env.DB)),
    mailer: createMailer(platform.env),
    origin: platform.env.BETTER_AUTH_URL || event.url.origin,
    ip: resolvedIp.ip,
    now: () => new Date(),
  };
}

const THROTTLE_MESSAGE =
  `rate limit exceeded: at most ${MAGIC_LINK_EMAIL_LIMIT} invite/sign-in emails per hour per ` +
  `address (${MAGIC_LINK_IP_LIMIT}/hour per IP) — wait and try again later`;

/**
 * Create an invite (caller must already be verified as an OWNER of the
 * vault): supersede any pending invite for the same (vault, email), mint +
 * store a hashed 14-day token, EMAIL the invite link, and return the wire
 * invite PLUS the one-time URL.
 */
export async function createInvite(
  deps: InviteDeps,
  args: { vaultId: string; email: string; role: VaultRole; invitedByUserId: string; invitedByName: string },
): Promise<InviteCreateResult> {
  const email = normalizeEmail(args.email);
  const now = deps.now();

  const vault = await deps.db.getVault(args.vaultId);
  if (!vault) return { ok: false, status: 404, message: "vault not found" };

  // Inviting an address that is ALREADY a member is a no-op worth surfacing.
  const existing = await deps.db.findUserByEmail(email);
  if (existing && (await deps.db.getMemberRole(args.vaultId, existing.id)) !== null) {
    return { ok: false, status: 409, message: `${email} is already a member of this vault` };
  }

  // Same abuse surface as the magic-link request path (unsolicited email to
  // arbitrary addresses), so the same durable guard + event table apply.
  const { throttled } = await guardMagicLinkRequest(deps.db.guard, { email, ip: deps.ip });
  if (throttled) return { ok: false, status: 429, message: THROTTLE_MESSAGE };

  // A new invite supersedes the pending one for this (vault, email).
  await deps.db.deletePendingInvites(args.vaultId, email);

  const token = mintInviteToken();
  const row: InviteRow = {
    id: crypto.randomUUID(),
    vaultId: args.vaultId,
    email,
    role: args.role,
    tokenHash: await hashInviteToken(token),
    invitedBy: args.invitedByUserId,
    createdAt: now,
    expiresAt: new Date(now.getTime() + INVITE_TTL_MS),
    acceptedAt: null,
  };
  await deps.db.insertInvite(row);

  const url = `${deps.origin}/invite/${token}`;
  await sendQuietly(() =>
    deps.mailer.sendInvite?.({ to: email, url, vaultName: vault.name, role: args.role }),
  );
  return { ok: true, invite: toInviteWire({ ...row, invitedByName: args.invitedByName }), url };
}

/**
 * Email delivery must never fail the (already-recorded) invite — the
 * production mailer swallows its own send errors, but defend against any
 * unexpected throw too. Never logs the token/URL.
 */
async function sendQuietly(send: () => Promise<void> | undefined): Promise<void> {
  try {
    await send();
  } catch (err) {
    // eslint-disable-next-line no-console
    console.error(
      `[invites] email delivery failed (invite still recorded): ${
        err instanceof Error ? err.message : String(err)
      }`,
    );
  }
}

// ------------------------------------------------------------- list / revoke

/** Pending (unaccepted, unexpired) invites for a vault, oldest first. */
export async function listInvites(
  db: InviteDb,
  vaultId: string,
  now: Date,
): Promise<VaultInvite[]> {
  const rows = await db.listPendingInvites(vaultId);
  return rows.filter((r) => r.expiresAt.getTime() > now.getTime()).map(toInviteWire);
}

/** Revoke a pending invite; false when unknown (or already consumed). */
export async function revokeInvite(
  db: InviteDb,
  vaultId: string,
  inviteId: string,
): Promise<boolean> {
  const invite = await db.getInviteById(vaultId, inviteId);
  if (!invite || invite.acceptedAt !== null) return false;
  await db.deleteInvite(inviteId);
  return true;
}

// ------------------------------------------------------------------- resend

/**
 * Re-send a pending invite: mint a NEW token (the old link stops working),
 * push the expiry out another 14 days, re-email, and return the fresh
 * one-time URL. Rate-limited like creation.
 */
export async function resendInvite(
  deps: InviteDeps,
  args: { vaultId: string; inviteId: string },
): Promise<InviteCreateResult> {
  const now = deps.now();
  const invite = await deps.db.getInviteById(args.vaultId, args.inviteId);
  if (!invite || invite.acceptedAt !== null) {
    return { ok: false, status: 404, message: "invite not found" };
  }
  const vault = await deps.db.getVault(args.vaultId);
  if (!vault) return { ok: false, status: 404, message: "vault not found" };

  const { throttled } = await guardMagicLinkRequest(deps.db.guard, {
    email: invite.email,
    ip: deps.ip,
  });
  if (throttled) return { ok: false, status: 429, message: THROTTLE_MESSAGE };

  const token = mintInviteToken();
  const expiresAt = new Date(now.getTime() + INVITE_TTL_MS);
  await deps.db.refreshInviteToken(invite.id, await hashInviteToken(token), expiresAt);

  const url = `${deps.origin}/invite/${token}`;
  await sendQuietly(() =>
    deps.mailer.sendInvite?.({ to: invite.email, url, vaultName: vault.name, role: invite.role }),
  );
  return { ok: true, invite: toInviteWire({ ...invite, expiresAt }), url };
}

// ----------------------------------------------------------------- validate

/** What the /invite/[token] page shows about a (still-valid) invite. */
export interface InviteSummary {
  invite: InviteJoined;
  vault: InviteVault;
}

/**
 * Resolve a raw invite token to its pending invite + vault, or null when the
 * token is unknown, expired, or already used.
 */
export async function validateInviteToken(
  db: InviteDb,
  token: string,
  now: Date,
): Promise<InviteSummary | null> {
  const invite = await db.getInviteByHash(await hashInviteToken(token));
  if (!invite || invite.acceptedAt !== null || invite.expiresAt.getTime() <= now.getTime()) {
    return null;
  }
  const vault = await db.getVault(invite.vaultId);
  if (!vault) return null;
  return { invite, vault };
}

// ------------------------------------------------------------------- accept

export type AcceptInviteResult =
  | { ok: true; vaultId: string; slug: string; role: VaultRole; alreadyMember: boolean }
  | { ok: false; reason: "invalid" | "email-mismatch"; message: string };

export const INVITE_INVALID_MESSAGE =
  "this invite link is invalid, expired, or already used — ask the vault owner for a new invite";

/**
 * Accept an invite as the signed-in user. REQUIRES a case-insensitive email
 * match between the session user and the invite (the shared normalizeEmail
 * choke-point on both sides); mismatch is a clear error, never a silent
 * grant. Single-use: acceptance stamps `accepted_at` atomically with the
 * membership insert. An acceptor who is already a member is an idempotent
 * success (their existing role wins; the invite is still consumed).
 */
export async function acceptInvite(
  db: InviteDb,
  args: { token: string; userId: string; userEmail: string },
  now: Date,
): Promise<AcceptInviteResult> {
  const invite = await db.getInviteByHash(await hashInviteToken(args.token));
  if (!invite || invite.acceptedAt !== null || invite.expiresAt.getTime() <= now.getTime()) {
    return { ok: false, reason: "invalid", message: INVITE_INVALID_MESSAGE };
  }
  const vault = await db.getVault(invite.vaultId);
  if (!vault) return { ok: false, reason: "invalid", message: INVITE_INVALID_MESSAGE };

  const sessionEmail = normalizeEmail(args.userEmail);
  if (sessionEmail !== invite.email) {
    return {
      ok: false,
      reason: "email-mismatch",
      message:
        `this invite was sent to ${invite.email}, but you are signed in as ${sessionEmail} — ` +
        "sign in with the invited address to accept",
    };
  }

  const existingRole = await db.getMemberRole(invite.vaultId, args.userId);
  if (existingRole !== null) {
    // Idempotent: already a member — just consume the invite.
    await db.stampAccepted(invite.id, now);
    return { ok: true, vaultId: vault.id, slug: vault.slug, role: existingRole, alreadyMember: true };
  }

  await db.acceptAtomically({
    inviteId: invite.id,
    member: {
      id: crypto.randomUUID(),
      vaultId: invite.vaultId,
      userId: args.userId,
      role: invite.role,
      createdAt: now,
    },
  });
  return { ok: true, vaultId: vault.id, slug: vault.slug, role: invite.role, alreadyMember: false };
}
