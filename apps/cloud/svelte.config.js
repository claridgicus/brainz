import adapter from "@sveltejs/adapter-cloudflare";
import { vitePreprocess } from "@sveltejs/vite-plugin-svelte";

/** @type {import('@sveltejs/kit').Config} */
const config = {
  preprocess: vitePreprocess(),
  kit: {
    adapter: adapter({
      config: "wrangler.jsonc",
      platformProxy: {
        // vite dev emulates bindings from a dev-only config WITHOUT the
        // Workers AI binding — AI is remote-only and would require a
        // Cloudflare login just to boot vite (see wrangler.dev.jsonc).
        configPath: "wrangler.dev.jsonc",
      },
    }),
    csrf: {
      // SvelteKit's origin check runs BEFORE hooks and can't exempt a path,
      // but the OAuth token/revoke endpoints take cross-origin form POSTs
      // (RFC 6749) with no Origin. hooks.server.ts re-applies the identical
      // check to every other path (isCrossSiteFormPost in $lib/server/oauth).
      trustedOrigins: ["*"],
    },
  },
};

export default config;
