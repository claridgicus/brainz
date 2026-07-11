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
  isMagicLinkVerify,
  isProductionEnv,
  MAGIC_LINK_TTL_SECONDS,
  MAGIC_LINK_VERIFY_PATH,
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

describe("isMagicLinkVerify (gate emailVerified flip to the magic-link path)", () => {
  it("constant is the magicLink plugin verify endpoint", () => {
    expect(MAGIC_LINK_VERIFY_PATH).toBe("/magic-link/verify");
  });

  it("is true only for the magic-link verify path", () => {
    expect(isMagicLinkVerify({ path: "/magic-link/verify" })).toBe(true);
  });

  it("is false for OAuth callbacks and other session-creating paths", () => {
    // GitHub OAuth callback proves control of a GitHub account, NOT the email —
    // so it must NOT flip emailVerified.
    expect(isMagicLinkVerify({ path: "/callback/github" })).toBe(false);
    expect(isMagicLinkVerify({ path: "/oauth2/callback/github" })).toBe(false);
    expect(isMagicLinkVerify({ path: "/sign-in/magic-link" })).toBe(false); // request, not verify
    expect(isMagicLinkVerify({})).toBe(false);
    expect(isMagicLinkVerify(null)).toBe(false);
    expect(isMagicLinkVerify(undefined)).toBe(false);
  });
});

describe("emailVerified flip decision (hook gate: magic-link path only)", () => {
  // The session.create.before hook flips iff isMagicLinkVerify(ctx) AND the user
  // is still unverified. These assert the composed gate the hook applies.
  const wouldFlip = (
    ctx: { path?: string } | null,
    user: { emailVerified?: boolean | null },
  ): boolean => isMagicLinkVerify(ctx) && shouldMarkEmailVerified(user);

  it("magic-link verify of an unverified user → flips", () => {
    expect(wouldFlip({ path: MAGIC_LINK_VERIFY_PATH }, { emailVerified: false })).toBe(true);
  });

  it("magic-link verify of an already-verified user → no-op (idempotent)", () => {
    expect(wouldFlip({ path: MAGIC_LINK_VERIFY_PATH }, { emailVerified: true })).toBe(false);
  });

  it("OAuth-path session for an unverified user → NOT flipped (no false verified)", () => {
    expect(wouldFlip({ path: "/callback/github" }, { emailVerified: false })).toBe(false);
  });

  it("session with no endpoint context → NOT flipped", () => {
    expect(wouldFlip(null, { emailVerified: false })).toBe(false);
  });
});

describe("isProductionEnv (fail-closed environment test)", () => {
  it("is true when pinned to the production origin (even in a dev build)", () => {
    vi.stubEnv("DEV", true);
    expect(isProductionEnv({ BETTER_AUTH_URL: PRODUCTION_ORIGIN })).toBe(true);
  });

  it("is true in a built (non-dev) bundle regardless of origin", () => {
    vi.stubEnv("DEV", false);
    expect(isProductionEnv({})).toBe(true);
    expect(isProductionEnv({ BETTER_AUTH_URL: "http://localhost:8787" })).toBe(true);
  });

  it("is false only for a genuine dev build not pinned to prod", () => {
    vi.stubEnv("DEV", true);
    expect(isProductionEnv({})).toBe(false);
    expect(isProductionEnv({ BETTER_AUTH_URL: "http://localhost:8787" })).toBe(false);
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
