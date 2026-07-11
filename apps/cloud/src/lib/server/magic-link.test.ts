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
import { magicLinkMinter, magicLinkSender } from "./magic-link";
import { DevMailer } from "./mailer";
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

describe("magicLinkSender (sign_in — EMAIL the link, never return it)", () => {
  it("delivers a magic link through the real (env-selected) mailer and returns nothing", async () => {
    // ENV has no SEND_EMAIL binding → createMailer picks the DevMailer, which
    // captures the 'sent' link in lastLink. Assert the send path was invoked.
    const send = magicLinkSender(ENV, "https://brainz.brownmatter.ai");
    const returned = await send("human@example.com");
    // sign_in must not hand back a URL — it returns void.
    expect(returned).toBeUndefined();
    // The mailer createMailer(env) supplied to createAuth is a DevMailer (no
    // SEND_EMAIL binding); the fake auth drove its sendMagicLink, so its
    // lastLink captures the send — proving the mailer/send path was invoked.
    expect(createAuthCalls).toHaveLength(1);
    const mailer = createAuthCalls[0].mailer as DevMailer;
    expect(mailer).toBeInstanceOf(DevMailer);
    expect(mailer.lastLink).not.toBeNull();
    expect(mailer.lastLink!.to).toBe("human@example.com");
    expect(mailer.lastLink!.url).toContain("/magic-link/verify?token=");
  });

  it("does NOT pin the short approve TTL — sign_in emails the normal-lifetime link", async () => {
    const send = magicLinkSender(ENV, "https://brainz.brownmatter.ai");
    await send("human@example.com");
    expect(createAuthCalls).toHaveLength(1);
    // magicLinkSender passes no opts override → the normal emailed TTL applies.
    expect(createAuthCalls[0].opts?.magicLinkTtlSeconds).toBeUndefined();
  });
});
