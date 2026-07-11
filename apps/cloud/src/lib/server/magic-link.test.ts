/**
 * magicLinkMinter (task-agent-loginurl-hardening): the agent-signup `loginUrl`
 * is minted with a DISTINCT, SHORTER TTL than an emailed link so a leaked-but-
 * unopened handoff link (tool results are often logged) goes stale sooner.
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
    // Keep the real constants (AGENT_MAGIC_LINK_TTL_SECONDS, PRODUCTION_ORIGIN).
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

import { AGENT_MAGIC_LINK_TTL_SECONDS, MAGIC_LINK_TTL_SECONDS } from "./auth";
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

  it("pins the shorter agent TTL (<= the emailed default) on the auth instance", async () => {
    const mint = magicLinkMinter(ENV, "https://brainz.brownmatter.ai");
    await mint("human@example.com");
    expect(createAuthCalls).toHaveLength(1);
    const pinned = createAuthCalls[0].opts?.magicLinkTtlSeconds;
    expect(pinned).toBe(AGENT_MAGIC_LINK_TTL_SECONDS);
    // The load-bearing guarantee: agent links never outlive an emailed link.
    expect(pinned).toBeLessThanOrEqual(MAGIC_LINK_TTL_SECONDS);
    expect(pinned).toBeLessThan(MAGIC_LINK_TTL_SECONDS);
  });
});
