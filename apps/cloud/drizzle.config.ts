import { defineConfig } from "drizzle-kit";

// Generates SQL migrations into ./drizzle, which doubles as wrangler's D1
// migrations_dir — apply with `npm run db:migrate:local` / `db:migrate:remote`.
export default defineConfig({
  schema: "./src/lib/server/schema.ts",
  out: "./drizzle",
  dialect: "sqlite",
});
