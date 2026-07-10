/**
 * API key helpers (pure, Workers-safe — Web Crypto only).
 *
 * Token format: `bz_` + 32 random base62 chars. Only the SHA-256 hex digest
 * is stored at rest; the plaintext is returned exactly once at creation.
 */

export const API_KEY_PREFIX = "bz_";
const RANDOM_LENGTH = 32;
const ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";

/** Generate a new plaintext API key: bz_<32 base62 chars>. */
export function generateApiKey(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(RANDOM_LENGTH));
  let out = API_KEY_PREFIX;
  for (const b of bytes) out += ALPHABET[b % ALPHABET.length];
  return out;
}

/** Does this look like one of our bearer keys? */
export function isApiKeyFormat(token: string): boolean {
  return /^bz_[A-Za-z0-9]{32}$/.test(token);
}

/** Display prefix stored alongside the hash (e.g. "bz_a1B2c…") — never enough to use. */
export function keyPrefixOf(key: string): string {
  return `${key.slice(0, API_KEY_PREFIX.length + 5)}…`;
}

/** SHA-256 hex digest of the plaintext key (what we store / look up). */
export async function hashApiKey(key: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(key));
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

/** Extract a bearer token from an Authorization header (null if absent/malformed). */
export function parseBearer(header: string | null): string | null {
  if (!header) return null;
  const m = /^Bearer\s+(.+)$/i.exec(header.trim());
  return m ? m[1].trim() : null;
}
