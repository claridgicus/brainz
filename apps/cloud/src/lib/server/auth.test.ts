/**
 * Fail-closed secret (audit MEDIUM): createAuth/resolveSecret must throw when
 * BETTER_AUTH_SECRET is absent in production, and only fall back to the dev
 * secret under a genuine dev build.
 */
import { afterEach, describe, expect, it, vi } from "vitest";

// auth.ts imports getRequestEvent from $app/server at module load; it isn't
// called by resolveSecret, so a no-op mock is enough to import the module.
vi.mock("$app/server", () => ({ getRequestEvent: () => ({}) }));

import {
  APPROVE_REDIRECT_TTL_SECONDS,
  MAGIC_LINK_TTL_SECONDS,
  PRODUCTION_ORIGIN,
  resolveSecret,
  shouldMarkEmailVerified,
} from "./auth";
import type { CloudEnv } from "../../app.d";

// resolveSecret only reads BETTER_AUTH_SECRET + BETTER_AUTH_URL; DB is a stub.
function make(overrides: Partial<CloudEnv>): CloudEnv {
  return { DB: {}, ...overrides } as unknown as CloudEnv;
}

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("resolveSecret (fail-closed secret)", () => {
  it("returns the configured secret whenever it is set (dev or prod)", () => {
    vi.stubEnv("DEV", false);
    expect(resolveSecret(make({ BETTER_AUTH_SECRET: "real-secret" }))).toBe("real-secret");
    expect(
      resolveSecret(make({ BETTER_AUTH_SECRET: "real-secret", BETTER_AUTH_URL: PRODUCTION_ORIGIN })),
    ).toBe("real-secret");
  });

  it("THROWS in production (prod origin) when the secret is missing", () => {
    vi.stubEnv("DEV", false);
    expect(() => resolveSecret(make({ BETTER_AUTH_URL: PRODUCTION_ORIGIN }))).toThrow(
      /BETTER_AUTH_SECRET is required/,
    );
  });

  it("THROWS in a non-dev build even without a prod origin (fail closed)", () => {
    vi.stubEnv("DEV", false);
    expect(() => resolveSecret(make({}))).toThrow(/BETTER_AUTH_SECRET is required/);
  });

  it("allows the dev fallback only under a dev build", () => {
    vi.stubEnv("DEV", true);
    expect(resolveSecret(make({}))).toBe("dev-insecure-secret-change-me");
  });

  it("does NOT allow the dev fallback for the production origin even in a dev build", () => {
    vi.stubEnv("DEV", true);
    expect(() => resolveSecret(make({ BETTER_AUTH_URL: PRODUCTION_ORIGIN }))).toThrow(
      /BETTER_AUTH_SECRET is required/,
    );
  });
});

describe("shouldMarkEmailVerified (verify-email-on-signin)", () => {
  it("flips an unverified account (false)", () => {
    expect(shouldMarkEmailVerified({ emailVerified: false })).toBe(true);
  });

  it("treats missing/null emailVerified as unverified (flip)", () => {
    expect(shouldMarkEmailVerified({})).toBe(true);
    expect(shouldMarkEmailVerified({ emailVerified: null })).toBe(true);
  });

  it("is a no-op once already verified (idempotent)", () => {
    expect(shouldMarkEmailVerified({ emailVerified: true })).toBe(false);
  });
});

describe("claim-approve redirect TTL (Wave G — replaces the agent loginUrl TTL)", () => {
  it("is strictly shorter than the emailed default", () => {
    expect(APPROVE_REDIRECT_TTL_SECONDS).toBeLessThan(MAGIC_LINK_TTL_SECONDS);
  });

  it("is a tight window — the URL only ever lives as an immediate 303 Location", () => {
    expect(APPROVE_REDIRECT_TTL_SECONDS).toBeGreaterThan(0);
    expect(APPROVE_REDIRECT_TTL_SECONDS).toBeLessThanOrEqual(60);
  });
});
