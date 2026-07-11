#!/usr/bin/env node
/**
 * Regenerates build/sitemap.xml from the pages the build actually prerendered,
 * so a new route can never be forgotten. Runs as part of `npm run build`
 * (after `vite build`); check-build.mjs verifies the result stays in sync.
 */
import { readdirSync, statSync, writeFileSync } from "node:fs";
import { join, relative, sep } from "node:path";
import { fileURLToPath } from "node:url";

const SITE_URL = "https://brownmatter.ai";
const buildDir = fileURLToPath(new URL("../build", import.meta.url));

/** Prerendered page paths ("/", "/docs", …) — excludes the 404 fallback shell. */
function pagePaths(dir) {
	const out = [];
	const walk = (d) => {
		for (const name of readdirSync(d)) {
			const p = join(d, name);
			if (statSync(p).isDirectory()) {
				if (name !== "_app") walk(p);
			} else if (name.endsWith(".html") && name !== "404.html") {
				const rel = relative(dir, p).split(sep).join("/");
				out.push(
					rel === "index.html" ? "/" : `/${rel.replace(/\/index\.html$/, "").replace(/\.html$/, "")}`,
				);
			}
		}
	};
	walk(dir);
	return out.sort();
}

let paths;
try {
	paths = pagePaths(buildDir);
} catch {
	console.error(`generate-sitemap: ${buildDir} not found — run \`vite build\` first.`);
	process.exit(1);
}

const lastmod = new Date().toISOString().slice(0, 10);
const xml = `<?xml version="1.0" encoding="UTF-8"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
${paths
	.map((p) => `  <url><loc>${SITE_URL}${p}</loc><lastmod>${lastmod}</lastmod></url>`)
	.join("\n")}
</urlset>
`;
writeFileSync(join(buildDir, "sitemap.xml"), xml);
console.log(`generate-sitemap: wrote sitemap.xml with ${paths.length} URLs (${paths.join(", ")})`);
