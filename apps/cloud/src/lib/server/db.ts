import type { D1Database } from "@cloudflare/workers-types";
import { drizzle } from "drizzle-orm/d1";
import * as schema from "./schema";

export type Db = ReturnType<typeof createDb>;

/** Drizzle over the request's D1 binding (bindings are per-request on Workers). */
export function createDb(d1: D1Database) {
  return drizzle(d1, { schema });
}

export { schema };
