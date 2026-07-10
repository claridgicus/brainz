import * as path from "node:path";
import { defineConfig } from "vitest/config";

// Pure-server-helper tests run in Node (no Cloudflare runtime): key hashing,
// password hashing, wire-shape compaction, keyword fallback, MCP handler map
// (via the SDK's InMemoryTransport). The Durable Object itself is exercised
// by the live wrangler-dev E2E journey (scripts/e2e.mjs).
export default defineConfig({
  resolve: {
    alias: {
      $lib: path.resolve(import.meta.dirname, "src/lib"),
    },
  },
  test: {
    include: ["src/**/*.test.ts"],
    environment: "node",
  },
});
