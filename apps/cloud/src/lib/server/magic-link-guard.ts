/**
 * D1-backed rate limiting for the magic-link REQUEST path (audit HIGH fix).
 *
 * Better Auth's magic-link plugin has an in-memory limiter, but Workers spin up
 * a fresh instance per request, so it can't stop an attacker mail-bombing an
 * address or enumerating accounts across the fleet. This guard runs in
 * hooks.server.ts BEFORE Better Auth handles `POST /api/auth/sign-in/magic-link`
 * and enforces a durable rolling-window limit:
 *   - per email: 5 / hour  (stops mail-bombing one address)
 *   - per IP:    20 / hour (stops one client bombing many addresses)
 *
 * On a trip it returns a friendly 429 and NEVER reveals whether the email
 * exists (the normal success response is a generic "check your inbox" anyway).
 * On pass it records the attempt so the window count is accurate.
 *
 * The decision logic runs against a small port (`GuardDeps`) so it is
 * unit-testable without a Workers/D1 runtime; `guardDepsFromDb` wires it to
 * drizzle/D1.
 */
import { and, count, eq, gt } from "drizzle-orm";
import type { Db } from "./db";
import { schema } from "./db";
import {
  MAGIC_LINK_EMAIL_LIMIT,
  MAGIC_LINK_IP_LIMIT,
  magicLinkThrottled,
  rateWindowStart,
} from "./rate-limit";

/** The Better Auth endpoint that mints + emails a magic link. */
export const MAGIC_LINK_REQUEST_PATH = "/api/auth/sign-in/magic-link";

export interface GuardDeps {
  now(): Date;
  /** Record this attempt FIRST — before counting (see guardMagicLinkRequest). */
  record(event: { email: string; ip: string; at: Date }): Promise<void>;
  countRecentByEmail(email: string, since: Date): Promise<number>;
  countRecentByIp(ip: string, since: Date): Promise<number>;
}

export interface GuardResult {
  throttled: boolean;
}

/**
 * Enforce the magic-link request limit for (email, ip). Returns whether the
 * request should be throttled.
 *
 * TOCTOU FIX (audit HIGH): the previous order — COUNT the window, decide, THEN
 * INSERT — was a time-of-check/time-of-use race. Concurrent requests all read
 * the SAME pre-insert count, all passed the cap check, and all inserted, so the
 * per-email/per-IP caps were bypassable under parallelism. We now RECORD the
 * attempt FIRST and only THEN count the window (which now includes this
 * attempt), rejecting if the inclusive count is over the cap. Because every
 * concurrent request commits its own row before any of them counts, at most
 * `cap` requests can observe a count at or below the cap — the check is atomic
 * with respect to the durable D1 counter. Counting this attempt makes the count
 * 1-based (the Nth attempt sees N), so magicLinkThrottled uses the inclusive
 * (count > limit) test and a cap of 5 still admits exactly 5 attempts. The
 * recorded rows are self-healing: as the rolling window slides they fall out of
 * the count and the address/IP recovers with no cleanup.
 */
export async function guardMagicLinkRequest(
  deps: GuardDeps,
  args: { email: string; ip: string },
): Promise<GuardResult> {
  const now = deps.now();
  const since = rateWindowStart(now);
  const email = args.email.trim().toLowerCase();

  // Record first, then count the window (now inclusive of this attempt).
  await deps.record({ email, ip: args.ip, at: now });

  const [emailInWindow, ipInWindow] = await Promise.all([
    deps.countRecentByEmail(email, since),
    deps.countRecentByIp(args.ip, since),
  ]);

  return { throttled: magicLinkThrottled({ emailInWindow, ipInWindow }) };
}

/** Wire the guard to the D1 control plane. */
export function guardDepsFromDb(db: Db): GuardDeps {
  const countSince = async (
    column: typeof schema.magicLinkEvent.email | typeof schema.magicLinkEvent.ip,
    value: string,
    since: Date,
  ): Promise<number> => {
    const rows = await db
      .select({ n: count() })
      .from(schema.magicLinkEvent)
      .where(and(eq(column, value), gt(schema.magicLinkEvent.createdAt, since)));
    return rows[0]?.n ?? 0;
  };
  return {
    now: () => new Date(),
    countRecentByEmail: (email, since) => countSince(schema.magicLinkEvent.email, email, since),
    countRecentByIp: (ip, since) => countSince(schema.magicLinkEvent.ip, ip, since),
    record: async ({ email, ip, at }) => {
      await db.insert(schema.magicLinkEvent).values({
        id: crypto.randomUUID(),
        email,
        ip,
        createdAt: at,
      });
    },
  };
}

/** Friendly throttle response — no account-existence leak. */
export function throttleResponse(): Response {
  return new Response(
    JSON.stringify({
      message:
        "Too many sign-in requests. Please wait a bit before requesting another link " +
        `(limit ${MAGIC_LINK_EMAIL_LIMIT}/hour per email, ${MAGIC_LINK_IP_LIMIT}/hour per address).`,
    }),
    { status: 429, headers: { "content-type": "application/json" } },
  );
}
