import { describe, expect, it } from "vitest";
import { fakeD1 } from "./fake-d1.testutil";
import type { GuardDeps } from "./magic-link-guard";
import { gatePasswordSignIn, hasCredentialAccount, recordPasswordFailure } from "./reviewer-login";

function seed(d1: ReturnType<typeof fakeD1>) {
  const now = Date.now();
  const user = d1.db.prepare(
    `INSERT INTO user (id, name, email, email_verified, created_at, updated_at) VALUES (?, ?, ?, 1, ?, ?)`,
  );
  user.run("rev", "Reviewer", "reviewer@example.com", now, now);
  user.run("mag", "Magic user", "human@example.com", now, now);
  d1.db
    .prepare(
      `INSERT INTO account (id, user_id, account_id, provider_id, password, created_at, updated_at)
       VALUES ('a1', 'rev', 'rev', 'credential', 'scrypt-hash', ?, ?)`,
    )
    .run(now, now);
  d1.db
    .prepare(
      `INSERT INTO account (id, user_id, account_id, provider_id, created_at, updated_at)
       VALUES ('a2', 'mag', 'gh-1', 'github', ?, ?)`,
    )
    .run(now, now);
}

/** In-memory stand-in for the magic_link_events guard. */
function memoryGuard(): GuardDeps & { events: { email: string; ip: string }[] } {
  const events: { email: string; ip: string }[] = [];
  return {
    events,
    now: () => new Date(),
    record: async ({ email, ip }) => {
      events.push({ email, ip });
    },
    countRecentByEmail: async (email) => events.filter((e) => e.email === email).length,
    countRecentByIp: async (ip) => events.filter((e) => e.ip === ip).length,
  };
}

describe("reviewer password sign-in gate", () => {
  it("only credential accounts are on the allow-list (case-insensitive)", async () => {
    const d1 = fakeD1();
    seed(d1);
    expect(await hasCredentialAccount(d1, "reviewer@example.com")).toBe(true);
    expect(await hasCredentialAccount(d1, " Reviewer@Example.com ")).toBe(true);
    expect(await hasCredentialAccount(d1, "human@example.com")).toBe(false);
    expect(await hasCredentialAccount(d1, "nobody@example.com")).toBe(false);
  });

  it("refuses non-reviewers with Better Auth's generic 401, before Better Auth runs", async () => {
    const d1 = fakeD1();
    seed(d1);
    const res = await gatePasswordSignIn({ db: d1, guard: memoryGuard() }, { email: "human@example.com", ip: "1.1.1.1" });
    expect(res?.status).toBe(401);
    expect(await res?.json()).toEqual({ code: "INVALID_EMAIL_OR_PASSWORD", message: "Invalid email or password" });
  });

  it("lets a reviewer through to Better Auth", async () => {
    const d1 = fakeD1();
    seed(d1);
    expect(await gatePasswordSignIn({ db: d1, guard: memoryGuard() }, { email: "reviewer@example.com", ip: "1.1.1.1" })).toBeNull();
  });

  it("never counts successes: a reviewer who keeps signing in is never locked out", async () => {
    const d1 = fakeD1();
    seed(d1);
    const guard = memoryGuard();
    for (let i = 0; i < 20; i++) {
      expect(await gatePasswordSignIn({ db: d1, guard }, { email: "reviewer@example.com", ip: "10.0.0.1" })).toBeNull();
    }
    expect(guard.events).toHaveLength(0);
  });

  it("blocks an email after 5 recorded failures, and an IP bucket after 20", async () => {
    const d1 = fakeD1();
    seed(d1);
    const guard = memoryGuard();
    for (let i = 0; i < 5; i++) await recordPasswordFailure(guard, { email: "reviewer@example.com", ip: `10.0.0.${i}` });
    expect((await gatePasswordSignIn({ db: d1, guard }, { email: "reviewer@example.com", ip: "10.9.9.9" }))?.status).toBe(429);
    // Spraying unknown emails: each is a recorded failure; the IP trips at 20.
    const spray = memoryGuard();
    const statuses: number[] = [];
    for (let i = 0; i < 21; i++) {
      const res = await gatePasswordSignIn({ db: d1, guard: spray }, { email: `x${i}@example.com`, ip: "6.6.6.6" });
      statuses.push(res?.status ?? 0);
    }
    expect(statuses.slice(0, 20).every((s) => s === 401)).toBe(true);
    expect(statuses[20]).toBe(429);
    expect(spray.events).toHaveLength(20);
  });

  it("keeps password failures out of the magic-link buckets", async () => {
    const d1 = fakeD1();
    seed(d1);
    const guard = memoryGuard();
    await gatePasswordSignIn({ db: d1, guard }, { email: "Human@Example.com", ip: "1.1.1.1" });
    expect(guard.events).toEqual([{ email: "password:human@example.com", ip: "password:1.1.1.1" }]);
  });
});
