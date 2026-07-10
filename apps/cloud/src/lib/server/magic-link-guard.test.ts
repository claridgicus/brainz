/**
 * Magic-link request limiter (audit HIGH): per-email 5/hour + per-IP 20/hour,
 * durable (D1-backed). Tested against a fake GuardDeps so the boundary and
 * record behaviour are verified without a Workers runtime.
 */
import { describe, expect, it } from "vitest";
import {
  guardMagicLinkRequest,
  MAGIC_LINK_REQUEST_PATH,
  throttleResponse,
  type GuardDeps,
} from "./magic-link-guard";

const NOW = new Date("2026-07-10T12:00:00.000Z");

function fakeDeps(counts: { email?: number; ip?: number } = {}) {
  const recorded: { email: string; ip: string; at: Date }[] = [];
  const deps: GuardDeps = {
    now: () => NOW,
    countRecentByEmail: async () => counts.email ?? 0,
    countRecentByIp: async () => counts.ip ?? 0,
    record: async (e) => {
      recorded.push(e);
    },
  };
  return { deps, recorded };
}

describe("guardMagicLinkRequest", () => {
  it("allows and records a request under both limits", async () => {
    const { deps, recorded } = fakeDeps({ email: 4, ip: 19 });
    const res = await guardMagicLinkRequest(deps, { email: "U@Example.com", ip: "1.2.3.4" });
    expect(res.throttled).toBe(false);
    // Recorded with the normalized (lowercased) email.
    expect(recorded).toEqual([{ email: "u@example.com", ip: "1.2.3.4", at: NOW }]);
  });

  it("throttles at the per-email boundary (5th within the hour) — nothing recorded", async () => {
    const { deps, recorded } = fakeDeps({ email: 5, ip: 0 });
    const res = await guardMagicLinkRequest(deps, { email: "u@example.com", ip: "1.2.3.4" });
    expect(res.throttled).toBe(true);
    expect(recorded).toHaveLength(0);
  });

  it("throttles at the per-IP boundary (20th within the hour) even for a fresh email", async () => {
    const { deps, recorded } = fakeDeps({ email: 0, ip: 20 });
    const res = await guardMagicLinkRequest(deps, { email: "fresh@example.com", ip: "1.2.3.4" });
    expect(res.throttled).toBe(true);
    expect(recorded).toHaveLength(0);
  });

  it("normalizes the email before counting", async () => {
    let seen = "";
    const deps: GuardDeps = {
      now: () => NOW,
      countRecentByEmail: async (email) => {
        seen = email;
        return 0;
      },
      countRecentByIp: async () => 0,
      record: async () => {},
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
