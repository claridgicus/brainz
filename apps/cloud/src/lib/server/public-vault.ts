/**
 * Public vaults — anonymous READ-ONLY access via an unguessable, revocable
 * token (Wave: public vaults). An owner enables public access on a vault; we
 * mint a 32-byte token, store only its SHA-256 hash on the vault row
 * (`public_token_hash`, `public_enabled`, `public_created_at`), and return the
 * plaintext + the `/public/<token>` URL EXACTLY ONCE. That token then grants an
 * ANONYMOUS VIEWER (Wave M role model): the read-only web view and the read-only
 * MCP tool surface — never members, keys, invites, writes, or task mutations.
 *
 * Token discipline mirrors api-keys / invites / claim: 32 random bytes hex,
 * SHA-256 at rest, plaintext shown once, regenerable (rotate mints a new token
 * so the old link dies), revocable (disable clears the hash). Resolution is by
 * hash and 404-disciplined: an unknown, revoked, rotated, or disabled token is
 * indistinguishable from a missing vault (no tenancy-existence leak).
 *
 * Everything is pure data-in/data-out over drizzle so it can be exercised
 * without a Workers runtime; the routes wire it to D1.
 */
import { and, count, eq, gt, isNotNull } from "drizzle-orm";
// One token implementation system-wide: 32 random bytes hex + SHA-256 at rest
// (identical requirements to claim/invite tokens — reuse, don't fork).
import { hashClaimToken as hashPublicToken, mintClaimToken as mintPublicToken } from "./claim";
import type { Db } from "./db";
import { schema } from "./db";
import {
  exceedsPublicReadRateLimitInclusive,
  rateWindowStart,
} from "./rate-limit";

export { hashPublicToken, mintPublicToken };

export interface PublicEnableResult {
  token: string;
  createdAt: Date;
}

/**
 * Enable public access (or ROTATE it — same operation): mint a fresh token,
 * store its hash, flip `public_enabled` true, stamp `public_created_at`. Any
 * previously issued token stops resolving the moment its hash is overwritten.
 * Caller must have already verified OWNER role on the vault (owner-only route).
 */
export async function enablePublicAccess(
  db: Db,
  vaultId: string,
  now: Date,
): Promise<PublicEnableResult> {
  const token = mintPublicToken();
  await db
    .update(schema.vault)
    .set({
      publicEnabled: true,
      publicTokenHash: await hashPublicToken(token),
      publicCreatedAt: now,
    })
    .where(eq(schema.vault.id, vaultId));
  return { token, createdAt: now };
}

/**
 * Disable public access: flip the flag AND clear the hash so the old token can
 * never resolve again (revocation, not just a hidden flag). Idempotent.
 */
export async function disablePublicAccess(db: Db, vaultId: string): Promise<void> {
  await db
    .update(schema.vault)
    .set({ publicEnabled: false, publicTokenHash: null, publicCreatedAt: null })
    .where(eq(schema.vault.id, vaultId));
}

/**
 * Resolve a raw public token to its vault, or null when the token is unknown,
 * rotated, revoked, or the vault's public access is disabled. Look up BY HASH
 * and require `public_enabled` — the 404 discipline lives at the call sites,
 * which turn null into a 404 (web) or 401 (MCP) with no existence leak.
 */
export async function resolvePublicVault(
  db: Db,
  token: string,
): Promise<typeof schema.vault.$inferSelect | null> {
  if (!token) return null;
  const tokenHash = await hashPublicToken(token);
  const rows = await db
    .select()
    .from(schema.vault)
    .where(
      and(
        eq(schema.vault.publicTokenHash, tokenHash),
        eq(schema.vault.publicEnabled, true),
        // Belt-and-suspenders: never match a cleared hash even if a stray
        // enabled row ever had a null hash.
        isNotNull(schema.vault.publicTokenHash),
      ),
    )
    .limit(1);
  return rows[0] ?? null;
}

/** The public status of a vault (owner-facing), derived from its row. */
export function publicStatusOf(vault: typeof schema.vault.$inferSelect): {
  enabled: boolean;
  createdAt: string | null;
} {
  const enabled = vault.publicEnabled && vault.publicTokenHash !== null;
  return {
    enabled,
    createdAt: enabled && vault.publicCreatedAt ? vault.publicCreatedAt.toISOString() : null,
  };
}

/** Build the shareable public URL for a raw token on a given origin. */
export function publicUrl(origin: string, token: string): string {
  return `${origin}/public/${token}`;
}

/**
 * Per-IP rate limit for the anonymous public-read surface. TOCTOU-safe like the
 * signup limiter: RECORD this attempt first, then count the window (inclusive of
 * it) and report whether it PASSED the cap. Returns `{ limited: true }` when the
 * caller should reject with 429. Never throws on the write — a failed record
 * degrades to "not limited" rather than blocking legitimate reads.
 */
export async function recordAndCheckPublicRead(
  db: Db,
  ip: string,
  now: Date,
): Promise<{ limited: boolean }> {
  await db
    .insert(schema.publicReadEvent)
    .values({ id: crypto.randomUUID(), ip, createdAt: now });
  const rows = await db
    .select({ n: count() })
    .from(schema.publicReadEvent)
    .where(
      and(
        eq(schema.publicReadEvent.ip, ip),
        gt(schema.publicReadEvent.createdAt, rateWindowStart(now)),
      ),
    );
  return { limited: exceedsPublicReadRateLimitInclusive(rows[0]?.n ?? 0) };
}
