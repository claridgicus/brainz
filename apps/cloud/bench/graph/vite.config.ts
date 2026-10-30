// Standalone build of the graph bench harness (never shipped with the Worker):
//   vite build --config bench/graph/vite.config.ts  → bench/graph/dist
import * as path from "node:path";
import { svelte } from "@sveltejs/vite-plugin-svelte";
import { defineConfig } from "vite";

const appDir = path.resolve(import.meta.dirname, "../..");

export default defineConfig({
	root: import.meta.dirname,
	base: "./",
	plugins: [svelte({ configFile: path.join(import.meta.dirname, "svelte.config.js") })],
	resolve: { alias: { $lib: path.join(appDir, "src/lib") } },
	build: { outDir: path.join(import.meta.dirname, "dist"), emptyOutDir: true },
	logLevel: "warn",
});
