/**
 * Test-only: the D1 control plane on better-sqlite3 — every drizzle migration
 * applied, exposed through the `prepare().bind().first()/run()` surface the
 * dream spend helpers use. Not imported by app code.
 */
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import Database from "better-sqlite3";
import type { D1Like } from "./dream-budget";

const MIGRATIONS = join(import.meta.dirname, "../../../drizzle");

export function fakeD1(): D1Like & { db: Database.Database } {
  const db = new Database(":memory:");
  for (const file of readdirSync(MIGRATIONS).filter((f) => f.endsWith(".sql")).sort()) {
    for (const stmt of readFileSync(join(MIGRATIONS, file), "utf8").split("--> statement-breakpoint")) {
      if (stmt.trim()) db.exec(stmt);
    }
  }
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
          };
        },
      };
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
