/**
 * The shared vault-create path (POST /api/vaults, the consent page's "+ New
 * vault", MCP create_vault) over the migrated control plane: the atomic
 * vault + owner membership insert, the per-account cap, the hourly limit,
 * and `also` statements applying only when the vault was created.
 */
import { describe, expect, it } from "vitest";
import { HttpError } from "./api-util";
import { fakeD1, seedOwner } from "./fake-d1.testutil";
import { RATE_WINDOW_MS } from "./rate-limit";
import {
  createVault,
  DEFAULT_MAX_VAULTS_PER_USER,
  DEFAULT_VAULT_CREATE_RATE_LIMIT,
  IF_VAULT_CREATED,
  vaultLimitsFromEnv,
  type VaultLimits,
} from "./vaults";

const LIMITS: VaultLimits = { maxVaultsPerUser: 20, createsPerHour: 10 };
const NOW = new Date("2026-10-30T06:00:00.000Z");

function setup() {
  const d1 = fakeD1();
  seedOwner(d1, "u1", "v1");
  return d1;
}

/** A user who owns no vault yet. */
function seedUser(d1: ReturnType<typeof fakeD1>, userId: string) {
  d1.db
    .prepare(`INSERT INTO user (id, name, email, email_verified, created_at, updated_at) VALUES (?, ?, ?, 0, 0, 0)`)
    .run(userId, userId, `${userId}@example.com`);
}

async function status(p: Promise<unknown>): Promise<number> {
  try {
    await p;
    return 0;
  } catch (err) {
    if (err instanceof HttpError) return err.status;
    throw err;
  }
}

const count = (d1: ReturnType<typeof fakeD1>, sql: string, ...args: unknown[]) =>
  (d1.db.prepare(sql).get(...args) as { n: number }).n;

describe("createVault", () => {
  it("creates the vault and its owner membership, slugified from the name", async () => {
    const d1 = setup();
    const vault = await createVault(d1, "u1", { name: "Side Project!" }, { limits: LIMITS, now: NOW });
    expect(vault).toMatchObject({ ownerId: "u1", slug: "side-project", name: "Side Project!", publicEnabled: false });
    const row = d1.db.prepare(`SELECT * FROM vault WHERE id = ?`).get(vault.id) as Record<string, unknown>;
    expect(row).toMatchObject({ owner_id: "u1", slug: "side-project", created_at: NOW.getTime(), public_enabled: 0 });
    expect(d1.db.prepare(`SELECT role FROM vault_member WHERE vault_id = ? AND user_id = 'u1'`).get(vault.id)).toEqual({
      role: "owner",
    });
  });

  it("an explicit slug wins; a slug the owner already uses is a 409 that writes nothing", async () => {
    const d1 = setup();
    expect((await createVault(d1, "u1", { name: "X", slug: "My Slug" }, { limits: LIMITS, now: NOW })).slug).toBe("my-slug");
    expect(await status(createVault(d1, "u1", { name: "Other", slug: "my-slug" }, { limits: LIMITS, now: NOW }))).toBe(409);
    expect(await status(createVault(d1, "u1", { name: "!!!" }, { limits: LIMITS, now: NOW }))).toBe(400);
    expect(count(d1, `SELECT COUNT(*) AS n FROM vault WHERE owner_id = 'u1'`)).toBe(2);
  });

  it("refuses past the per-account cap with a 403 naming the limit", async () => {
    const d1 = setup(); // u1 already owns v1
    const limits = { maxVaultsPerUser: 3, createsPerHour: 100 };
    await createVault(d1, "u1", { name: "a" }, { limits, now: NOW });
    await createVault(d1, "u1", { name: "b" }, { limits, now: NOW });
    const err = await createVault(d1, "u1", { name: "c" }, { limits, now: NOW }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(HttpError);
    expect((err as HttpError).status).toBe(403);
    expect((err as HttpError).message).toContain("at most 3 vaults");
    expect(count(d1, `SELECT COUNT(*) AS n FROM vault WHERE owner_id = 'u1'`)).toBe(3);
    // Another account is unaffected.
    seedOwner(d1, "u2", "v2");
    expect((await createVault(d1, "u2", { name: "c" }, { limits, now: NOW })).ownerId).toBe("u2");
  });

  it("refuses past the hourly limit with a 429, counting the owner's vaults created in the window", async () => {
    const d1 = fakeD1();
    seedUser(d1, "u9");
    const limits = { maxVaultsPerUser: 100, createsPerHour: 2 };
    // Created just over an hour ago: outside the window.
    await createVault(d1, "u9", { name: "old" }, { limits, now: new Date(NOW.getTime() - RATE_WINDOW_MS) });
    await createVault(d1, "u9", { name: "a" }, { limits, now: NOW });
    // A refused create (slug clash) does not use up the allowance.
    expect(await status(createVault(d1, "u9", { name: "a" }, { limits, now: NOW }))).toBe(409);
    await createVault(d1, "u9", { name: "b" }, { limits, now: NOW });
    const err = await createVault(d1, "u9", { name: "c" }, { limits, now: NOW }).catch((e: unknown) => e);
    expect((err as HttpError).status).toBe(429);
    expect((err as HttpError).message).toContain("at most 2 per hour");
    expect(count(d1, `SELECT COUNT(*) AS n FROM vault WHERE owner_id = 'u9'`)).toBe(3);
    // An hour later the window has moved on.
    const later = new Date(NOW.getTime() + RATE_WINDOW_MS + 1);
    expect((await createVault(d1, "u9", { name: "c" }, { limits, now: later })).slug).toBe("c");
  });

  it("concurrent creates can't overshoot the hourly limit (the check is inside the batch)", async () => {
    const d1 = fakeD1();
    seedUser(d1, "u9");
    const limits = { maxVaultsPerUser: 100, createsPerHour: 3 };
    const results = await Promise.allSettled(
      Array.from({ length: 6 }, (_, i) => createVault(d1, "u9", { name: `p${i}` }, { limits, now: NOW })),
    );
    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(3);
    expect(count(d1, `SELECT COUNT(*) AS n FROM vault WHERE owner_id = 'u9'`)).toBe(3);
  });

  it("`also` statements land in the same batch, and only when the vault was created", async () => {
    const d1 = setup();
    const also = (vaultId: string) => [
      d1
        .prepare(`INSERT INTO api_key (id, vault_id, name, key_hash, key_prefix, created_at) SELECT ?, ?, 'k', ?, 'bz_x', 0 ${IF_VAULT_CREATED}`)
        .bind(crypto.randomUUID(), vaultId, `hash-${vaultId}`, vaultId),
    ];
    const vault = await createVault(d1, "u1", { name: "keyed" }, { limits: LIMITS, now: NOW, also });
    expect(count(d1, `SELECT COUNT(*) AS n FROM api_key WHERE vault_id = ?`, vault.id)).toBe(1);
    expect(await status(createVault(d1, "u1", { name: "keyed" }, { limits: LIMITS, now: NOW, also }))).toBe(409);
    expect(count(d1, `SELECT COUNT(*) AS n FROM api_key`)).toBe(1);
  });

  it("a failing `also` statement rolls the whole create back", async () => {
    const d1 = setup();
    const also = () => [d1.prepare(`INSERT INTO api_key (id) VALUES (?)`).bind("broken")]; // NOT NULL fails
    await expect(createVault(d1, "u1", { name: "atomic" }, { limits: LIMITS, now: NOW, also })).rejects.toThrow();
    expect(count(d1, `SELECT COUNT(*) AS n FROM vault WHERE slug = 'atomic'`)).toBe(0);
    expect(count(d1, `SELECT COUNT(*) AS n FROM vault_member WHERE user_id = 'u1'`)).toBe(0);
  });
});

describe("vaultLimitsFromEnv", () => {
  it("defaults to 20 vaults and 10 creates per hour, ignoring blank or bad values", () => {
    const defaults = { maxVaultsPerUser: DEFAULT_MAX_VAULTS_PER_USER, createsPerHour: DEFAULT_VAULT_CREATE_RATE_LIMIT };
    expect(defaults).toEqual({ maxVaultsPerUser: 20, createsPerHour: 10 });
    expect(vaultLimitsFromEnv({})).toEqual(defaults);
    expect(vaultLimitsFromEnv({ MAX_VAULTS_PER_USER: " ", VAULT_CREATE_RATE_LIMIT: "-1" })).toEqual(defaults);
    expect(vaultLimitsFromEnv({ MAX_VAULTS_PER_USER: "2.5", VAULT_CREATE_RATE_LIMIT: "abc" })).toEqual(defaults);
    expect(vaultLimitsFromEnv({ MAX_VAULTS_PER_USER: "5", VAULT_CREATE_RATE_LIMIT: "3" })).toEqual({
      maxVaultsPerUser: 5,
      createsPerHour: 3,
    });
  });
});
