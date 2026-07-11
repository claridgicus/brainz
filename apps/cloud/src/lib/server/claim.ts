/**
 * The claim-to-persist domain (Wave G — agent self-signup guardrails).
 *
 * Model: agent `signup` provisions an ANONYMOUS workspace whose owner expires
 * in 7 days. Persistence requires the inbox owner's approval: the agent calls
 * `claim {email}` (or passes `email` to signup), we mint a 32-byte token
 * (SHA-256 hash at rest, 24 h TTL) and EMAIL `<origin>/claim/<token>` to the
 * human. The URL never appears in any tool result — a URL in agent context
 * proves nothing about a human. Approving on that page is the ONLY path that
 * binds the email, verifies it, and clears the owner's expiry.
 *
 * Anti-oracle: the claim tool's output is identical whether the address is
 * fresh (approval email w/ token) or already registered (notice email, no
 * token) — `{status: "sent", expiresAt}` either way.
 *
 * Everything runs against the small `ClaimDb` port so the flows are
 * unit-testable without a Workers/D1 runtime; `claimDbFrom` wires it to
 * drizzle/D1. Claim requests are counted in `magic_link_events` under the
 * existing guard limits (5/hour/email, 20/hour/IP) — same abuse surface
 * (unsolicited email to arbitrary addresses).
 */
import { claimInputSchema, type ClaimOutput } from "@brainz/contracts";
import { and, eq, isNull, ne, asc, sql } from "drizzle-orm";
import type { Db } from "./db";
import { schema } from "./db";
import { normalizeEmail } from "./email";
import { guardDepsFromDb, guardMagicLinkRequest } from "./magic-link-guard";
import type { Mailer } from "./mailer";
import { fail, guarded, ok, type ToolResult } from "./mcp";
import { MAGIC_LINK_EMAIL_LIMIT, MAGIC_LINK_IP_LIMIT } from "./rate-limit";

// ------------------------------------------------------ provisional identity

/** Placeholder domain for unclaimed accounts — `.invalid` can never receive mail. */
export const PLACEHOLDER_EMAIL_DOMAIN = "pending.brainz.invalid";

/** Display name of a not-yet-claimed workspace owner. */
export const UNCLAIMED_WORKSPACE_NAME = "Unclaimed workspace";

/** Provisional accounts expire 7 days after signup unless claimed. */
export const SIGNUP_EXPIRY_MS = 7 * 24 * 60 * 60 * 1000;

/** Claim-approval tokens live 24 hours. */
export const CLAIM_TTL_MS = 24 * 60 * 60 * 1000;

export function placeholderEmail(userId: string): string {
  return `unclaimed-${userId}@${PLACEHOLDER_EMAIL_DOMAIN}`;
}

export function isPlaceholderEmail(email: string): boolean {
  return email.endsWith(`@${PLACEHOLDER_EMAIL_DOMAIN}`);
}

/** Provisional = still expiring AND still on the placeholder identity. */
export function isProvisionalOwner(owner: { email: string; expiresAt: Date | null }): boolean {
  return owner.expiresAt !== null && isPlaceholderEmail(owner.email);
}

// ------------------------------------------------------------------- tokens

/** Mint a claim token: 32 random bytes, hex-encoded (URL-safe). */
export function mintClaimToken(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(32));
  return [...bytes].map((b) => b.toString(16).padStart(2, "0")).join("");
}

/** SHA-256 hex digest — the only form a token takes at rest. */
export async function hashClaimToken(token: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(token));
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

// --------------------------------------------------------------------- port

export interface ClaimOwner {
  id: string;
  name: string;
  email: string;
  createdAt: Date;
  expiresAt: Date | null;
}

export interface ClaimRow {
  id: string;
  userId: string;
  email: string;
  tokenHash: string;
  createdAt: Date;
  expiresAt: Date;
  approvedAt: Date | null;
}

/** A vault owned by the provisional workspace — moved wholesale on reconcile. */
export interface ProvisionalVault {
  id: string;
  slug: string;
}

/** What the approval email + page show about the workspace being claimed. */
export interface WorkspaceSummary {
  vaultName: string;
  keyName: string;
  keyPrefix: string;
}

/**
 * Persistence port for the claim domain (drizzle/D1 in prod via `claimDbFrom`,
 * fakes in tests).
 */
export interface ClaimDb {
  getUserById(id: string): Promise<ClaimOwner | null>;
  /**
   * The existing (real) user for this email, case-insensitively, or null. Used
   * on approval to decide promote-in-place vs reconcile-to-existing. Matches how
   * sign-in normalizes email (compared lowercased), so `James@x.com` and
   * `james@x.com` resolve to the same account.
   */
  findUserByEmail(email: string): Promise<{ id: string } | null>;
  /** The owner's first vault + its first API key (what the claim attaches). */
  workspaceSummary(userId: string): Promise<WorkspaceSummary | null>;
  /** Every vault owned by the provisional workspace (usually one). */
  vaultsOwnedBy(userId: string): Promise<ProvisionalVault[]>;
  /** Slugs already taken on the target account — to dedupe on reconcile. */
  vaultSlugsOwnedBy(userId: string): Promise<Set<string>>;
  deletePendingClaims(userId: string): Promise<void>;
  insertClaim(row: ClaimRow): Promise<void>;
  getClaimByHash(tokenHash: string): Promise<ClaimRow | null>;
  /**
   * Atomic approval: bind email + verified + permanent + fixed name on the
   * user, stamp the claim approved, delete the user's OTHER pending claims.
   */
  approve(args: {
    userId: string;
    claimId: string;
    email: string;
    name: string;
    at: Date;
  }): Promise<void>;
  /**
   * Atomic reconcile: reassign each provisional vault to `existingUserId`
   * (applying any slug renames to dodge collisions on the target account),
   * grant the existing user an `owner` vault_member row on every moved vault
   * (Wave M: membership is the access source of truth — the provisional
   * user's own member rows cascade away with their deletion), stamp the claim
   * approved, then DELETE the provisional user (which cascades away its
   * now-empty rows). api_key rows are vault_id-scoped, so they follow the
   * vault automatically — no key move needed. All in one D1 batch.
   */
  reconcile(args: {
    provisionalUserId: string;
    existingUserId: string;
    claimId: string;
    /** ALL vaults being moved (renamed or not) — each needs a member row. */
    vaultIds: string[];
    vaultRenames: { vaultId: string; slug: string }[];
    at: Date;
  }): Promise<void>;
  /** Delete a pending (unapproved) claim by token hash. */
  deletePendingClaimByHash(tokenHash: string): Promise<void>;
  // Rate-limit counters over magic_link_events (shared with the sign-in guard).
  countRecentMagicLinkByEmail(email: string, since: Date): Promise<number>;
  countRecentMagicLinkByIp(ip: string, since: Date): Promise<number>;
  recordMagicLinkEvent(event: { email: string; ip: string; at: Date }): Promise<void>;
}

/** Wire the claim domain to the D1 control plane. */
export function claimDbFrom(db: Db): ClaimDb {
  const guard = guardDepsFromDb(db);
  return {
    getUserById: async (id) => {
      const rows = await db.select().from(schema.user).where(eq(schema.user.id, id)).limit(1);
      return rows[0] ?? null;
    },
    findUserByEmail: async (email) => {
      // Normalize the input (canonical form) AND lower() the column: our flows
      // normalize on write, but a human account created directly through Better
      // Auth could carry mixed case, so the column-side lower() is
      // belt-and-suspenders — a stray mixed-case row can never fork or dodge
      // this lookup.
      const normalized = normalizeEmail(email);
      const rows = await db
        .select({ id: schema.user.id })
        .from(schema.user)
        .where(eq(sql`lower(${schema.user.email})`, normalized))
        .limit(1);
      return rows[0] ?? null;
    },
    vaultsOwnedBy: async (userId) => {
      const rows = await db
        .select({ id: schema.vault.id, slug: schema.vault.slug })
        .from(schema.vault)
        .where(eq(schema.vault.ownerId, userId));
      return rows;
    },
    vaultSlugsOwnedBy: async (userId) => {
      const rows = await db
        .select({ slug: schema.vault.slug })
        .from(schema.vault)
        .where(eq(schema.vault.ownerId, userId));
      return new Set(rows.map((r) => r.slug));
    },
    workspaceSummary: async (userId) => {
      const rows = await db
        .select({
          vaultName: schema.vault.name,
          keyName: schema.apiKey.name,
          keyPrefix: schema.apiKey.keyPrefix,
        })
        .from(schema.vault)
        .innerJoin(schema.apiKey, eq(schema.apiKey.vaultId, schema.vault.id))
        .where(eq(schema.vault.ownerId, userId))
        .orderBy(asc(schema.vault.createdAt), asc(schema.apiKey.createdAt))
        .limit(1);
      return rows[0] ?? null;
    },
    deletePendingClaims: async (userId) => {
      await db
        .delete(schema.accountClaim)
        .where(and(eq(schema.accountClaim.userId, userId), isNull(schema.accountClaim.approvedAt)));
    },
    insertClaim: async (row) => {
      await db.insert(schema.accountClaim).values(row);
    },
    getClaimByHash: async (tokenHash) => {
      const rows = await db
        .select()
        .from(schema.accountClaim)
        .where(eq(schema.accountClaim.tokenHash, tokenHash))
        .limit(1);
      return rows[0] ?? null;
    },
    approve: async ({ userId, claimId, email, name, at }) => {
      // One D1 batch = one implicit transaction: all three or none.
      await db.batch([
        db
          .update(schema.user)
          .set({ email, emailVerified: true, expiresAt: null, name, updatedAt: at })
          .where(eq(schema.user.id, userId)),
        db.update(schema.accountClaim).set({ approvedAt: at }).where(eq(schema.accountClaim.id, claimId)),
        db
          .delete(schema.accountClaim)
          .where(
            and(
              eq(schema.accountClaim.userId, userId),
              ne(schema.accountClaim.id, claimId),
              isNull(schema.accountClaim.approvedAt),
            ),
          ),
      ]);
    },
    reconcile: async ({ provisionalUserId, existingUserId, claimId, vaultIds, vaultRenames, at }) => {
      // One D1 batch = one implicit transaction. Order matters:
      //  1. rename any colliding vault slugs FIRST (still owned by the
      //     provisional user, so the (owner_id, slug) unique index can't clash
      //     with the target account's existing slugs yet),
      //  2. reassign ALL of the provisional user's vaults to the existing user,
      //  2b. grant the existing user an `owner` membership on every moved
      //     vault (Wave M: vault_member is the session-access source of
      //     truth). Upsert: if they were somehow already a member (e.g. via a
      //     prior invite), promote that row to owner instead of failing the
      //     (vault_id, user_id) unique index,
      //  3. stamp the claim approved (audit trail; survives the user delete
      //     because account_claims.user_id points at the provisional row —
      //     which we delete last, cascading the claim away),
      //  4. DELETE the provisional user. Vaults were already moved off it, so
      //     the cascade only removes its leftover rows (sessions, its own
      //     member rows, its own pending claims). api_key rows are
      //     vault_id-scoped and moved with the vault, so they follow
      //     automatically.
      const statements = [
        ...vaultRenames.map((r) =>
          db.update(schema.vault).set({ slug: r.slug }).where(eq(schema.vault.id, r.vaultId)),
        ),
        db
          .update(schema.vault)
          .set({ ownerId: existingUserId })
          .where(eq(schema.vault.ownerId, provisionalUserId)),
        ...vaultIds.map((vaultId) =>
          db
            .insert(schema.vaultMember)
            .values({
              id: crypto.randomUUID(),
              vaultId,
              userId: existingUserId,
              role: "owner",
              createdAt: at,
            })
            .onConflictDoUpdate({
              target: [schema.vaultMember.vaultId, schema.vaultMember.userId],
              set: { role: "owner" },
            }),
        ),
        db.update(schema.accountClaim).set({ approvedAt: at }).where(eq(schema.accountClaim.id, claimId)),
        db.delete(schema.user).where(eq(schema.user.id, provisionalUserId)),
      ];
      // db.batch requires a non-empty tuple; the last two statements always run.
      await db.batch(statements as [(typeof statements)[number], ...typeof statements]);
    },
    deletePendingClaimByHash: async (tokenHash) => {
      await db
        .delete(schema.accountClaim)
        .where(
          and(eq(schema.accountClaim.tokenHash, tokenHash), isNull(schema.accountClaim.approvedAt)),
        );
    },
    countRecentMagicLinkByEmail: (email, since) => guard.countRecentByEmail(email, since),
    countRecentMagicLinkByIp: (ip, since) => guard.countRecentByIp(ip, since),
    recordMagicLinkEvent: (event) => guard.record(event),
  };
}

// ------------------------------------------------------------ request claim

export interface ClaimRequestDeps {
  /** The claim persistence port (claimDbFrom(drizzleDb) in prod). */
  db: ClaimDb;
  mailer: Mailer;
  /** Request origin the approval URL is built on, e.g. https://brainz.brownmatter.ai */
  origin: string;
  /** Client IP (CF-Connecting-IP) — one of the two rate-limit keys. */
  ip: string;
  now(): Date;
}

export type RequestClaimResult =
  | { ok: true; expiresAt: Date }
  | { ok: false; reason: "already-claimed" | "throttled" | "no-owner"; message: string };

/**
 * Handle a claim request for the workspace owned by `userId`: supersede prior
 * pending claims, mint + store a hashed 24 h token, and EMAIL the approval
 * link. Already-registered addresses get a notice email instead (no token) —
 * the result is identical either way (no account-existence oracle). The
 * approval URL is never returned.
 */
export async function requestClaim(
  deps: ClaimRequestDeps,
  args: { userId: string; email: string },
): Promise<RequestClaimResult> {
  const email = normalizeEmail(args.email);
  const now = deps.now();

  const owner = await deps.db.getUserById(args.userId);
  if (!owner) {
    return { ok: false, reason: "no-owner", message: "workspace owner not found" };
  }
  if (!isProvisionalOwner(owner)) {
    return {
      ok: false,
      reason: "already-claimed",
      message: "already claimed — manage keys in the vault's settings page",
    };
  }

  // Same abuse surface as the magic-link request path (unsolicited email to
  // arbitrary addresses), so the same durable guard + event table apply.
  const { throttled } = await guardMagicLinkRequest(
    {
      now: deps.now,
      countRecentByEmail: deps.db.countRecentMagicLinkByEmail,
      countRecentByIp: deps.db.countRecentMagicLinkByIp,
      record: deps.db.recordMagicLinkEvent,
    },
    { email, ip: deps.ip },
  );
  if (throttled) {
    return {
      ok: false,
      reason: "throttled",
      message:
        `rate limit exceeded: at most ${MAGIC_LINK_EMAIL_LIMIT} claim/sign-in emails per hour per ` +
        `address (${MAGIC_LINK_IP_LIMIT}/hour per IP) — wait and try again later`,
    };
  }

  // A new request supersedes the owner's prior pending claims.
  await deps.db.deletePendingClaims(owner.id);

  const expiresAt = new Date(now.getTime() + CLAIM_TTL_MS);

  // NB: we always mint an approval token, EVEN when the email already has an
  // account. The token travels only in the emailed link — reaching the real
  // inbox owner, whose click is the consent to RECONCILE (approveClaim moves the
  // provisional vault to their existing account and deletes the provisional
  // user; see the reconcile branch there). The tool result is `{status:"sent"}`
  // either way, so this is not an account-existence oracle. This replaces the
  // old notice-only dead-end that left the provisioned vault orphaned under the
  // provisional user (the incident that motivated this fix).
  const token = mintClaimToken();
  await deps.db.insertClaim({
    id: crypto.randomUUID(),
    userId: owner.id,
    email,
    tokenHash: await hashClaimToken(token),
    createdAt: now,
    expiresAt,
    approvedAt: null,
  });

  const summary = await deps.db.workspaceSummary(owner.id);
  await sendQuietly(() =>
    deps.mailer.sendClaimApproval?.({
      to: email,
      url: `${deps.origin}/claim/${token}`,
      vaultName: summary?.vaultName ?? "My vault",
      keyName: summary?.keyName ?? "agent-signup",
      keyPrefix: summary?.keyPrefix ?? "bz_…",
    }),
  );
  return { ok: true, expiresAt };
}

/**
 * Email delivery must never fail the (already-recorded) claim request — the
 * production mailer swallows its own send errors, but defend against any
 * unexpected throw too. Never logs the token/URL.
 */
async function sendQuietly(send: () => Promise<void> | undefined): Promise<void> {
  try {
    await send();
  } catch (err) {
    // eslint-disable-next-line no-console
    console.error(
      `[claim] email delivery failed (claim still recorded): ${
        err instanceof Error ? err.message : String(err)
      }`,
    );
  }
}

// ---------------------------------------------------------------- validate

/** What the /claim/[token] approval page shows. */
export interface ClaimSummary {
  /** The email being bound. */
  email: string;
  vaultName: string;
  keyName: string;
  keyPrefix: string;
  /** When the workspace (owner account) was created. */
  createdAt: Date;
  /** When this claim token expires. */
  expiresAt: Date;
}

/**
 * Resolve a raw claim token to its pending claim + workspace summary, or null
 * when the token is unknown, expired, or already used.
 */
export async function validateClaimToken(
  db: ClaimDb,
  token: string,
  now: Date,
): Promise<ClaimSummary | null> {
  const claim = await db.getClaimByHash(await hashClaimToken(token));
  if (!claim || claim.approvedAt !== null || claim.expiresAt.getTime() <= now.getTime()) {
    return null;
  }
  const owner = await db.getUserById(claim.userId);
  if (!owner) return null;
  const summary = await db.workspaceSummary(claim.userId);
  if (!summary) return null;
  return {
    email: claim.email,
    vaultName: summary.vaultName,
    keyName: summary.keyName,
    keyPrefix: summary.keyPrefix,
    createdAt: owner.createdAt,
    expiresAt: claim.expiresAt,
  };
}

// ----------------------------------------------------------------- approve

export type ApproveClaimResult =
  | { ok: true; userId: string; email: string; reconciled: boolean }
  | { ok: false; reason: "invalid"; message: string };

/**
 * Deduplicate a slug against a set of already-taken slugs by appending `-2`,
 * `-3`, … until free. Pure + exported for testing.
 */
export function dedupeSlug(slug: string, taken: Set<string>): string {
  if (!taken.has(slug)) return slug;
  for (let n = 2; ; n++) {
    const candidate = `${slug}-${n}`;
    if (!taken.has(candidate)) return candidate;
  }
}

/**
 * Approve a claim — the ONLY path that persists a provisional workspace. The
 * INVARIANT: two users must never share an email, and a provisional identity
 * must never survive for an email that already has a real account.
 *
 * When the claim email becomes known here we branch on whether that email
 * already has a user (case-insensitively, matching sign-in normalization):
 *
 *  - EXISTING user → RECONCILE: reassign the provisional workspace's vault(s)
 *    to that user (deduping any slug that collides with a vault they already
 *    own), stamp the claim approved, and DELETE the provisional user. The
 *    workspace now appears in the existing account's dashboard (which filters
 *    vault by owner_id). api_key rows are vault_id-scoped, so they follow the
 *    vault automatically. This is the fix for the identity-fork incident.
 *
 *  - NO existing user → PROMOTE the provisional user in place: bind
 *    user.email = claim.email, emailVerified = true, clear expires_at, fix the
 *    placeholder name, stamp approved_at, delete the user's other pending
 *    claims.
 *
 * Single-use: a consumed/expired/unknown token never approves.
 */
export async function approveClaim(
  db: ClaimDb,
  token: string,
  now: Date,
): Promise<ApproveClaimResult> {
  const claim = await db.getClaimByHash(await hashClaimToken(token));
  if (!claim || claim.approvedAt !== null || claim.expiresAt.getTime() <= now.getTime()) {
    return {
      ok: false,
      reason: "invalid",
      message:
        "this claim link is invalid, expired, or already used — ask your agent to request a new claim",
    };
  }
  const owner = await db.getUserById(claim.userId);
  if (!owner) {
    return { ok: false, reason: "invalid", message: "the workspace this claim belongs to is gone" };
  }

  const existing = await db.findUserByEmail(claim.email);

  // Guard: if the provisional owner IS already the account for this email
  // (shouldn't normally happen — a provisional owner carries a placeholder
  // email — but keeps the branch total), fall through to promote-in-place.
  if (existing && existing.id !== owner.id) {
    // RECONCILE to the existing account. Move every vault the provisional user
    // owns, renaming any slug that would collide with the target's existing
    // vaults so the (owner_id, slug) unique index holds after the move.
    const vaults = await db.vaultsOwnedBy(owner.id);
    const taken = await db.vaultSlugsOwnedBy(existing.id);
    const vaultRenames: { vaultId: string; slug: string }[] = [];
    for (const v of vaults) {
      const deduped = dedupeSlug(v.slug, taken);
      taken.add(deduped); // reserve so sibling vaults don't collide with each other
      if (deduped !== v.slug) vaultRenames.push({ vaultId: v.id, slug: deduped });
    }
    await db.reconcile({
      provisionalUserId: owner.id,
      existingUserId: existing.id,
      claimId: claim.id,
      vaultIds: vaults.map((v) => v.id),
      vaultRenames,
      at: now,
    });
    return { ok: true, userId: existing.id, email: claim.email, reconciled: true };
  }

  // PROMOTE the provisional user in place.
  const name = owner.name === UNCLAIMED_WORKSPACE_NAME
    ? claim.email.split("@")[0] || claim.email
    : owner.name;
  await db.approve({ userId: owner.id, claimId: claim.id, email: claim.email, name, at: now });
  return { ok: true, userId: owner.id, email: claim.email, reconciled: false };
}

/** Decline a claim: delete the pending row; the workspace expires on schedule. */
export async function declineClaim(db: ClaimDb, token: string): Promise<void> {
  await db.deletePendingClaimByHash(await hashClaimToken(token));
}

// ------------------------------------------------------------ MCP tool glue

export interface ClaimToolDeps extends ClaimRequestDeps {
  /** Owner of the vault the calling API key is scoped to. */
  ownerId: string;
}

/**
 * Handler for the cloud-only authenticated `claim` MCP tool (CLOUD_MCP_TOOLS).
 * The result NEVER contains the approval URL — only the emailed link's expiry.
 */
export async function handleClaimTool(input: unknown, deps: ClaimToolDeps): Promise<ToolResult> {
  return guarded(async () => {
    const parsed = claimInputSchema.safeParse(input);
    if (!parsed.success) {
      return fail(`invalid claim input: ${parsed.error.issues[0]?.message ?? "bad arguments"}`);
    }
    const result = await requestClaim(deps, { userId: deps.ownerId, email: parsed.data.email });
    if (!result.ok) return fail(result.message);
    const output: ClaimOutput = { status: "sent", expiresAt: result.expiresAt.toISOString() };
    return ok(output);
  });
}
