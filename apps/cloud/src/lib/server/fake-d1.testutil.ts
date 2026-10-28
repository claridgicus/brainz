/**
 * Test-only: the D1 control plane on better-sqlite3 — every drizzle migration
 * applied (or those up to `through`), exposed through the
 * `prepare().bind().first()/run()` + `batch()` surface the server helpers use.
 * Not imported by app code.
 */
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import Database from "better-sqlite3";
import type { D1Like } from "./dream-budget";

const MIGRATIONS = join(import.meta.dirname, "../../../drizzle");

/** The migration files in apply order, optionally only those numbered <= `through`. */
function migrationFiles(through?: number): string[] {
  return readdirSync(MIGRATIONS)
    .filter((f) => f.endsWith(".sql"))
    .sort()
    .filter((f) => through === undefined || Number(f.slice(0, 4)) <= through);
}

function execMigration(db: Database.Database, file: string): void {
  for (const stmt of readFileSync(join(MIGRATIONS, file), "utf8").split("--> statement-breakpoint")) {
    if (stmt.trim()) db.exec(stmt);
  }
}

/**
 * Apply ONE migration (by its 4-digit number) the way D1 does: atomically, in
 * one transaction, with foreign keys enforced.
 */
export function applyMigration(d1: { db: Database.Database }, number: number): void {
  const file = migrationFiles().find((f) => Number(f.slice(0, 4)) === number);
  if (!file) throw new Error(`no migration ${number}`);
  d1.db.transaction(() => execMigration(d1.db, file))();
}

/**
 * The migrated control plane. `through` stops after that migration number, so
 * a test can populate an older schema and then applyMigration() the next one.
 */
export function fakeD1(opts: { through?: number } = {}): D1Like & {
  db: Database.Database;
  batch(statements: readonly { run(): Promise<unknown> }[]): Promise<unknown[]>;
} {
  const db = new Database(":memory:");
  db.pragma("foreign_keys = ON");
  for (const file of migrationFiles(opts.through)) execMigration(db, file);
  return {
    db,
    prepare(query: string) {
      return {
        bind(...values: unknown[]) {
          const stmt = db.prepare(query);
          return {
            async first<T>() {
              return ((stmt.get(...values) as T | undefined) ?? null) as T | null;
            },
            async run() {
              return stmt.run(...values);
            },
            /** Synchronous run, for batch(). */
            runSync() {
              return stmt.run(...values);
            },
          };
        },
      };
    },
    /** D1 batch semantics: every statement in one transaction, all or nothing. */
    async batch(statements) {
      return db.transaction(() =>
        statements.map((s) => (s as unknown as { runSync(): unknown }).runSync()),
      )();
    },
  };
}

/** Seed a user who owns vault `vaultId`. */
export function seedOwner(d1: { db: Database.Database }, userId = "u1", vaultId = "v1"): void {
  const now = Date.now();
  d1.db
    .prepare(`INSERT INTO user (id, name, email, email_verified, created_at, updated_at) VALUES (?, ?, ?, 0, ?, ?)`)
    .run(userId, userId, `${userId}@example.com`, now, now);
  d1.db
    .prepare(`INSERT INTO vault (id, owner_id, slug, name, created_at) VALUES (?, ?, ?, ?, ?)`)
    .run(vaultId, userId, vaultId, vaultId, now);
}
