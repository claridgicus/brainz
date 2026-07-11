/**
 * magicLinkMinter (Wave G): mints the verify URL the /claim/[token] APPROVE
 * action 303-redirects the approving browser to — its ONLY caller. It must
 * pin the tight APPROVE_REDIRECT_TTL_SECONDS (the URL is consumed by the
 * immediate redirect, never emailed, never handed to an agent — the retired
 * signup `loginUrl` path is gone).
 *
 * We mock `./auth` so `createAuth` returns a fake Better Auth whose
 * `signInMagicLink` drives the capturing mailer exactly as the real plugin
 * would — no Workers runtime / D1 needed. The assertion is on the TTL the minter
 * pins (<= the emailed default) plus the normal mint→capture→return behaviour.
 */
import { afterEach, describe, expect, it, vi } from "vitest";

// auth.ts imports getRequestEvent from $app/server at module load (pulled in via
// vi.importActual below); a no-op mock is enough to import the module in tests.
vi.mock("$app/server", () => ({ getRequestEvent: () => ({}) }));

// Capture every createAuth call's args so we can assert the pinned TTL.
const createAuthCalls: Array<{
  env: Record<string, unknown>;
  mailer: { sendMagicLink: (a: { to?: string; url: string }) => Promise<void> };
  opts?: { magicLinkTtlSeconds?: number };
}> = [];

vi.mock("./auth", async () => {
  const actual = await vi.importActual<typeof import("./auth")>("./auth");
  return {
    // Keep the real constants (APPROVE_REDIRECT_TTL_SECONDS, PRODUCTION_ORIGIN).
    ...actual,
    createAuth: (
      env: Record<string, unknown>,
      mailer: { sendMagicLink: (a: { to?: string; url: string }) => Promise<void> },
      opts?: { magicLinkTtlSeconds?: number },
    ) => {
      createAuthCalls.push({ env, mailer, opts });
      // Fake auth: signInMagicLink simply "delivers" a URL through the mailer,
      // which for the minter is the capturing mailer — same contract Better Auth
      // fulfils, minus the real token/DB.
      return {
        api: {
          async signInMagicLink({ body }: { body: { email: string; callbackURL?: string } }) {
            const url = `https://brainz.brownmatter.ai/api/auth/magic-link/verify?token=tok&callbackURL=${body.callbackURL}`;
            await mailer.sendMagicLink({ to: body.email, url });
            return { status: true };
          },
        },
      };
    },
  };
});

import { APPROVE_REDIRECT_TTL_SECONDS, MAGIC_LINK_TTL_SECONDS } from "./auth";
import { magicLinkMinter } from "./magic-link";
import type { CloudEnv } from "../../app.d";

const ENV = { DB: {}, BETTER_AUTH_SECRET: "s", BETTER_AUTH_URL: "https://brainz.brownmatter.ai" } as unknown as CloudEnv;

afterEach(() => {
  createAuthCalls.length = 0;
});

describe("magicLinkMinter", () => {
  it("mints a link and returns the captured URL", async () => {
    const mint = magicLinkMinter(ENV, "https://brainz.brownmatter.ai");
    const url = await mint("human@example.com");
    expect(url).toContain("/magic-link/verify?token=");
    expect(url).toContain("callbackURL=/dashboard");
  });

  it("pins the tight approve-redirect TTL (<< the emailed default) on the auth instance", async () => {
    const mint = magicLinkMinter(ENV, "https://brainz.brownmatter.ai");
    await mint("human@example.com");
    expect(createAuthCalls).toHaveLength(1);
    const pinned = createAuthCalls[0].opts?.magicLinkTtlSeconds;
    expect(pinned).toBe(APPROVE_REDIRECT_TTL_SECONDS);
    // The load-bearing guarantee: the redirect URL never outlives an emailed
    // link — it only has to survive one immediate 303.
    expect(pinned).toBeLessThan(MAGIC_LINK_TTL_SECONDS);
  });
});
