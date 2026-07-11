/**
 * The single, system-wide email normalizer.
 *
 * INVARIANT: every email that is stored, compared, or used as a rate-limit key
 * MUST pass through this helper first. Mixed-case must never enter the system —
 * `James@Example.COM` and `james@example.com` are the SAME account, share ONE
 * rate-limit bucket, and can never fork into two identities.
 *
 * This is the canonical choke-point. Better Auth also lowercases emails it
 * writes/looks up internally (createUser/findUserByEmail), but relying on that
 * implicitly left our own layers inconsistent (signup, sign_in, the magic-link
 * request guard, the claim flow, and every findUserByEmail/emailRegistered
 * lookup). By routing all of them through this ONE helper — chosen to match
 * Better Auth's own `trim().toLowerCase()` normalization so the email we hand
 * it is already canonical — a raw insert or a case-variant request can neither
 * store mixed case nor create a duplicate bucket/identity.
 *
 * Keep this the ONLY normalization style in the server. Do not inline
 * `.trim().toLowerCase()` at call sites; call `normalizeEmail` so there is one
 * definition to reason about.
 */
export function normalizeEmail(email: string): string {
  return email.trim().toLowerCase();
}
