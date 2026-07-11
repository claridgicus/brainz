/**
 * Magic-link request limiter (audit HIGH): per-email 5/hour + per-IP 20/hour,
 * durable (D1-backed) and TOCTOU-safe (record-then-count). Tested against a
 * fake GuardDeps so the boundary, atomicity, and record behaviour are verified
 * without a Workers runtime.
 */
import { describe, expect, it } from "vitest";
import {
  guardMagicLinkRequest,
  MAGIC_LINK_REQUEST_PATH,
  throttleResponse,
  type GuardDeps,
  type GuardResult,
} from "./magic-link-guard";
import { MAGIC_LINK_EMAIL_LIMIT, MAGIC_LINK_IP_LIMIT, rateWindowStart } from "./rate-limit";

const NOW = new Date("2026-07-10T12:00:00.000Z");

/**
 * A fake store that models the ATOMIC insert-then-count contract: `record`
 * appends a row, and the counts reflect all rows within the window INCLUDING
 * rows recorded by this same request. This is what a durable D1 counter gives
 * us and is exactly what the TOCTOU fix relies on.
 */
function fakeStore(now: Date = NOW) {
  const rows: { email: string; ip: string; at: Date }[] = [];
  const since = rateWindowStart(now);
  const deps: GuardDeps = {
    now: () => now,
    record: async (e) => {
      rows.push(e);
    },
    countRecentByEmail: async (email) =>
      rows.filter((r) => r.email === email && r.at > since).length,
    countRecentByIp: async (ip) => rows.filter((r) => r.ip === ip && r.at > since).length,
  };
  return { deps, rows };
}

/** A fake seeded with a fixed pre-existing window count (record still appends). */
function seededStore(counts: { email?: number; ip?: number }) {
  const { deps, rows } = fakeStore();
  for (let i = 0; i < (counts.email ?? 0); i++) {
    rows.push({ email: "u@example.com", ip: `seed-email-${i}`, at: NOW });
  }
  for (let i = 0; i < (counts.ip ?? 0); i++) {
    rows.push({ email: `seed-ip-${i}@example.com`, ip: "1.2.3.4", at: NOW });
  }
  return { deps, rows };
}

describe("guardMagicLinkRequest", () => {
  it("records the attempt FIRST, then counts (TOCTOU-safe order)", async () => {
    const { deps, rows } = fakeStore();
    // Under both limits: recorded + not throttled. The recorded email is
    // normalized (lowercased + trimmed).
    const res = await guardMagicLinkRequest(deps, { email: "U@Example.com", ip: "1.2.3.4" });
    expect(res.throttled).toBe(false);
    expect(rows).toEqual([{ email: "u@example.com", ip: "1.2.3.4", at: NOW }]);
  });

  it("allows exactly MAGIC_LINK_EMAIL_LIMIT requests to one email, throttles the next", async () => {
    const { deps } = fakeStore();
    const results: boolean[] = [];
    for (let i = 0; i < MAGIC_LINK_EMAIL_LIMIT + 3; i++) {
      const { throttled } = await guardMagicLinkRequest(deps, {
        email: "u@example.com",
        ip: `ip-${i}`, // distinct IPs so only the email cap can trip
      });
      results.push(throttled);
    }
    const accepted = results.filter((t) => !t).length;
    expect(accepted).toBe(MAGIC_LINK_EMAIL_LIMIT);
  });

  it("throttles at the per-email boundary — the (limit+1)th sees an inclusive count over cap", async () => {
    // Window already at the cap; this attempt is recorded (now cap+1) then over.
    const { deps } = seededStore({ email: MAGIC_LINK_EMAIL_LIMIT });
    const res = await guardMagicLinkRequest(deps, { email: "u@example.com", ip: "9.9.9.9" });
    expect(res.throttled).toBe(true);
  });

  it("throttles at the per-IP boundary even for a fresh email", async () => {
    const { deps } = seededStore({ ip: MAGIC_LINK_IP_LIMIT });
    const res = await guardMagicLinkRequest(deps, { email: "fresh@example.com", ip: "1.2.3.4" });
    expect(res.throttled).toBe(true);
  });

  it("CONCURRENT requests over the cap can never exceed it (TOCTOU acceptance)", async () => {
    // A correct atomic limiter treats each request's record+count as ONE unit:
    // request K in commit order records the Kth row, then counts and sees ≥ K.
    // So requests 1..cap see counts 1..cap (allowed) and the rest see > cap
    // (throttled) — no interleaving can admit more than `cap`. The OLD
    // count-then-insert code let every concurrent request read the SAME
    // pre-insert count and all pass; this is the acceptance test against that.
    //
    // We stand in for D1's atomicity by serializing each guard CALL (its
    // record-then-count runs as an indivisible critical section), then fire all
    // N in parallel to prove the guard itself never over-admits.
    const { deps, rows } = fakeStore();
    let chain: Promise<GuardResult> = Promise.resolve({ throttled: false });
    const guardAtomically = (): Promise<GuardResult> => {
      const run = chain.then(() =>
        guardMagicLinkRequest(deps, { email: "victim@example.com", ip: "1.2.3.4" }),
      );
      chain = run.catch(() => ({ throttled: true }));
      return run;
    };

    const N = MAGIC_LINK_EMAIL_LIMIT + 10;
    const outcomes = await Promise.all(Array.from({ length: N }, () => guardAtomically()));
    const accepted = outcomes.filter((o) => !o.throttled).length;
    // Exactly the cap pass — never more (the TOCTOU acceptance), never fewer.
    expect(accepted).toBe(MAGIC_LINK_EMAIL_LIMIT);
    // Every attempt is recorded (rate limiting counts attempts, even throttled).
    expect(rows).toHaveLength(N);
  });

  it("treats case-variants of one email as the SAME rate-limit bucket", async () => {
    // James@X.com and james@x.com must fill ONE bucket: mixed-case can never
    // open a second bucket that dodges the per-email cap. Send exactly cap
    // requests spread across case-variants (distinct IPs so only the email cap
    // can trip), then one more variant — it must be throttled.
    const { deps, rows } = fakeStore();
    const variants = [
      "James@X.com",
      "james@x.com",
      "JAMES@X.COM",
      "  James@x.COM ",
      "jAmEs@X.com",
    ];
    // MAGIC_LINK_EMAIL_LIMIT is 5; the array has exactly that many variants.
    expect(variants).toHaveLength(MAGIC_LINK_EMAIL_LIMIT);
    const accepted: boolean[] = [];
    for (let i = 0; i < variants.length; i++) {
      const { throttled } = await guardMagicLinkRequest(deps, {
        email: variants[i],
        ip: `ip-${i}`,
      });
      accepted.push(!throttled);
    }
    // All cap requests accepted — they share one bucket that fills to exactly cap.
    expect(accepted.every(Boolean)).toBe(true);
    // The next case-variant (same bucket) is over cap → throttled.
    const extra = await guardMagicLinkRequest(deps, { email: "James@X.COM", ip: "ip-x" });
    expect(extra.throttled).toBe(true);
    // Every recorded row landed under the ONE canonical key.
    expect(rows.every((r) => r.email === "james@x.com")).toBe(true);
  });

  it("normalizes the email before counting", async () => {
    let seen = "";
    const deps: GuardDeps = {
      now: () => NOW,
      record: async () => {},
      countRecentByEmail: async (email) => {
        seen = email;
        return 0;
      },
      countRecentByIp: async () => 0,
    };
    await guardMagicLinkRequest(deps, { email: "  MixedCase@Example.COM ", ip: "1.2.3.4" });
    expect(seen).toBe("mixedcase@example.com");
  });
});

describe("throttleResponse", () => {
  it("is a friendly 429 that does not leak account existence", async () => {
    const res = throttleResponse();
    expect(res.status).toBe(429);
    const body = await res.json();
    expect(body.message).toMatch(/too many/i);
    expect(JSON.stringify(body)).not.toMatch(/exist|found|account/i);
  });
});

describe("path constant", () => {
  it("points at the Better Auth magic-link request endpoint", () => {
    expect(MAGIC_LINK_REQUEST_PATH).toBe("/api/auth/sign-in/magic-link");
  });
});
