/**
 * Vault access resolution for REST + MCP (Wave M: membership-based).
 *
 * Two credentials:
 * - Session cookie (locals.user): access iff the user has a `vault_member`
 *   row on the vault; the row's role (owner | editor | viewer) gates what
 *   they may do. Non-members get 404 — foreign vaults are indistinguishable
 *   from missing ones (no tenancy-existence leak).
 * - Bearer `bz_` API key: scoped to exactly its vault, data-plane only.
 *
 * ============================ PINNED DECISION ============================
 * API keys carry an EDITOR-EQUIVALENT data-plane scope, and key MANAGEMENT
 * stays owner-only (session-only routes; "keys can't mint keys"). The
 * `viewer` role therefore constrains only SESSION-authenticated surfaces:
 * a viewer cannot create keys at all (owner-only), so no bearer key ever
 * carries viewer scope — every key resolves to `role: "editor"` here and
 * every MCP vault tool (reads AND writes) works over any valid key. This is
 * the "keys carry the vault's data-plane scope" option SPEC-CLOUD.md's Wave M
 * section leaves as the agent's call.
 * =========================================================================
 *
 * Role gates (enforced via `requireVaultAccess({ role })` at every route):
 * - owner  — everything: rename/delete vault, API keys, members, invites,
 *            plus all editor abilities. The LAST owner can never leave or be
 *            demoted/removed (see $lib/server/members).
 * - editor — concept/task reads + writes; NO keys/members/invites, no
 *            vault rename/delete.
 * - viewer — read-only (browse, search, context, related, lists); NO
 *            upserts, task mutations, or any admin surface.
 *
 * A MEMBER with an insufficient role gets 403 (they can already see the
 * vault, so this is not an existence leak); a NON-member gets 404.
 */
import type { RequestEvent } from "@sveltejs/kit";
import type { VaultRole } from "@brainz/contracts";
import { and, eq } from "drizzle-orm";
import { hashApiKey, isApiKeyFormat, parseBearer } from "./api-keys";
import { HttpError, requirePlatform } from "./api-util";
import { createDb, schema } from "./db";

export type { VaultRole };

export interface VaultAccess {
  vault: typeof schema.vault.$inferSelect;
  via: "session" | "key";
  /** The caller's effective role: the member row's role, or "editor" for keys. */
  role: VaultRole;
}

/** Role lattice: viewer < editor < owner. Pure + exported for unit testing. */
const ROLE_RANK: Record<VaultRole, number> = { viewer: 0, editor: 1, owner: 2 };

export function roleSatisfies(actual: VaultRole, required: VaultRole): boolean {
  return ROLE_RANK[actual] >= ROLE_RANK[required];
}

/** The 403 body for members whose role is insufficient for the route. */
export function insufficientRoleMessage(required: VaultRole): string {
  return required === "owner"
    ? "forbidden: this action requires the owner role"
    : `forbidden: this action requires the ${required} role (viewers are read-only)`;
}

/**
 * The 401 body for keys whose provisional owner expired unclaimed (Wave G).
 * Surfaced verbatim on both REST and /mcp bearer paths.
 */
export const WORKSPACE_EXPIRED_MESSAGE =
  "workspace expired unclaimed — sign up again, or ask your human to approve the claim email";

/**
 * Wave G expiry rule: a provisional owner (`expires_at` set by agent signup)
 * whose expiry has passed makes every key on their vaults unauthorized.
 * NULL = permanent account (human-created or claimed). Pure + exported for
 * unit testing.
 */
export function isOwnerExpired(ownerExpiresAt: Date | null, now: Date): boolean {
  return ownerExpiresAt !== null && ownerExpiresAt.getTime() < now.getTime();
}

/**
 * Resolve an api_key row (+vault) from a bearer token; null when invalid.
 *
 * This is the single bearer-auth chokepoint for BOTH surfaces — every REST
 * route goes through requireVaultAccess → resolveApiKey, and /mcp calls it
 * directly — so the Wave G owner-expiry rejection lives here: a key whose
 * vault owner is past `expires_at` throws a 401 HttpError with
 * WORKSPACE_EXPIRED_MESSAGE (a message-carrying rejection, unlike the silent
 * null for unknown keys).
 */
export async function resolveApiKey(
  event: RequestEvent,
): Promise<{ key: typeof schema.apiKey.$inferSelect; vault: typeof schema.vault.$inferSelect } | null> {
  const token = parseBearer(event.request.headers.get("authorization"));
  if (!token || !isApiKeyFormat(token)) return null;
  const platform = requirePlatform(event);
  const db = createDb(platform.env.DB);
  const keyHash = await hashApiKey(token);
  const rows = await db
    .select({ key: schema.apiKey, vault: schema.vault, ownerExpiresAt: schema.user.expiresAt })
    .from(schema.apiKey)
    .innerJoin(schema.vault, eq(schema.apiKey.vaultId, schema.vault.id))
    .innerJoin(schema.user, eq(schema.vault.ownerId, schema.user.id))
    .where(eq(schema.apiKey.keyHash, keyHash))
    .limit(1);
  if (rows.length === 0) return null;
  if (isOwnerExpired(rows[0].ownerExpiresAt, new Date())) {
    throw new HttpError(401, WORKSPACE_EXPIRED_MESSAGE);
  }
  // Touch last_used_at out of band; never block or fail the request on it.
  const touch = db
    .update(schema.apiKey)
    .set({ lastUsedAt: new Date() })
    .where(eq(schema.apiKey.id, rows[0].key.id))
    .then(
      () => {},
      () => {},
    );
  platform.context.waitUntil(touch);
  return { key: rows[0].key, vault: rows[0].vault };
}

/**
 * Look up the caller's membership role on a vault (session path). Exported
 * for the routes that need the role without the full access ceremony.
 */
export async function memberRole(
  db: ReturnType<typeof createDb>,
  vaultId: string,
  userId: string,
): Promise<VaultRole | null> {
  const rows = await db
    .select({ role: schema.vaultMember.role })
    .from(schema.vaultMember)
    .where(and(eq(schema.vaultMember.vaultId, vaultId), eq(schema.vaultMember.userId, userId)))
    .limit(1);
  return rows.length > 0 ? (rows[0].role as VaultRole) : null;
}

export interface VaultAccessOptions {
  /** Restrict to cookie sessions (vault mutation, key/member/invite management). */
  sessionOnly?: boolean;
  /**
   * Minimum role required (default "viewer" — i.e. any member). Insufficient
   * role → 403 for a member; non-members are always 404. Bearer keys count as
   * "editor" (see the pinned decision above), so `role: "owner"` routes must
   * also be `sessionOnly` — keys can never satisfy them.
   */
  role?: VaultRole;
}

/**
 * Require access to `vaultId` (route param). Session users get vaults they
 * are MEMBERS of (role-gated); bearer keys get exactly their vault with
 * editor-equivalent scope.
 */
export async function requireVaultAccess(
  event: RequestEvent,
  vaultId: string,
  opts: VaultAccessOptions = {},
): Promise<VaultAccess> {
  const platform = requirePlatform(event);
  const db = createDb(platform.env.DB);
  const required = opts.role ?? "viewer";

  if (event.locals.user) {
    const rows = await db
      .select({ vault: schema.vault, role: schema.vaultMember.role })
      .from(schema.vaultMember)
      .innerJoin(schema.vault, eq(schema.vaultMember.vaultId, schema.vault.id))
      .where(
        and(eq(schema.vaultMember.vaultId, vaultId), eq(schema.vaultMember.userId, event.locals.user.id)),
      )
      .limit(1);
    // Non-member: 404, not 403 — foreign vaults must be indistinguishable
    // from missing ones.
    if (rows.length === 0) throw new HttpError(404, "vault not found");
    const role = rows[0].role as VaultRole;
    if (!roleSatisfies(role, required)) {
      throw new HttpError(403, insufficientRoleMessage(required));
    }
    return { vault: rows[0].vault, via: "session", role };
  }

  if (!opts.sessionOnly) {
    const resolved = await resolveApiKey(event);
    if (resolved) {
      if (resolved.vault.id !== vaultId) throw new HttpError(404, "vault not found");
      // Pinned decision: keys are editor-equivalent on the data plane.
      const role: VaultRole = "editor";
      if (!roleSatisfies(role, required)) {
        throw new HttpError(401, "authentication required");
      }
      return { vault: resolved.vault, via: "key", role };
    }
  }

  throw new HttpError(401, "authentication required");
}

/** Require a cookie session (401 otherwise) and return the user. */
export function requireUser(event: RequestEvent): NonNullable<App.Locals["user"]> {
  if (!event.locals.user) throw new HttpError(401, "authentication required");
  return event.locals.user;
}
