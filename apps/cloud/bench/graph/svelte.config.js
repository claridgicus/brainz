// Svelte config for the graph bench harness (vite-plugin-svelte reads it from
// the bench root; svelte-check also finds it for Bench.svelte).
import { vitePreprocess } from "@sveltejs/vite-plugin-svelte";

export default { preprocess: vitePreprocess() };
