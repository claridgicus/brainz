import { sveltekit } from "@sveltejs/kit/vite";
import { defineConfig } from "vite";

export default defineConfig({
  plugins: [sveltekit()],
  ssr: {
    // Bundle these with vite (per-importer resolution) instead of leaving
    // them external for wrangler's flat resolve: better-auth depends on
    // zod v4 (nested install) while @brainz/contracts + the MCP SDK use the
    // hoisted zod v3 — wrangler would otherwise resolve both to v3.
    noExternal: ["better-auth", /^@better-auth\//, "zod", "better-call"],
  },
  build: {
    rollupOptions: {
      // `cloudflare:email` is a workerd built-in module (provides EmailMessage
      // for the send_email binding). It has no npm package to resolve — leave
      // it external so the runtime supplies it at execution time.
      external: [/^cloudflare:/],
    },
  },
});
