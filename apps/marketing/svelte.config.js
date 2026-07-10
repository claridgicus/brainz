import adapter from "@sveltejs/adapter-static";
import { vitePreprocess } from "@sveltejs/vite-plugin-svelte";

/** @type {import('@sveltejs/kit').Config} */
const config = {
  preprocess: vitePreprocess(),
  kit: {
    adapter: adapter({
      pages: "build",
      assets: "build",
      // Served by Cloudflare assets `not_found_handling: "404-page"` — renders +error.svelte client-side.
      fallback: "404.html",
      precompress: false,
      strict: true,
    }),
  },
};

export default config;
