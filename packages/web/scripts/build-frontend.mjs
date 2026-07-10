// Bundle the frontend (TS + deps, no runtime CDN) into dist/public.
import { build } from "esbuild";
import { copyFileSync, mkdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import * as path from "node:path";

const pkgRoot = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const outDir = path.join(pkgRoot, "dist", "public");
mkdirSync(outDir, { recursive: true });

await build({
  entryPoints: [path.join(pkgRoot, "frontend", "main.ts")],
  bundle: true,
  format: "iife",
  target: "es2022",
  minify: true,
  sourcemap: false,
  outfile: path.join(outDir, "app.js"),
  logLevel: "info",
});

copyFileSync(path.join(pkgRoot, "frontend", "index.html"), path.join(outDir, "index.html"));
copyFileSync(path.join(pkgRoot, "frontend", "styles.css"), path.join(outDir, "app.css"));
