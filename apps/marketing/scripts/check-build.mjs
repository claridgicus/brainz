#!/usr/bin/env node
/**
 * Post-build sanity check for the marketing site (run `npm run build` first):
 *   1. every prerendered page links to the app's signup + login URLs;
 *   2. no external http(s) ASSET references anywhere in the build —
 *      scripts, stylesheets, images, fonts, iframes must all be self-hosted.
 *      (Anchor hrefs to the app / GitHub are expected and allowed.)
 */
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, extname } from "node:path";
import { fileURLToPath } from "node:url";

const buildDir = fileURLToPath(new URL("../build", import.meta.url));

function walk(dir) {
	const out = [];
	for (const name of readdirSync(dir)) {
		const p = join(dir, name);
		if (statSync(p).isDirectory()) out.push(...walk(p));
		else out.push(p);
	}
	return out;
}

let files;
try {
	files = walk(buildDir);
} catch {
	console.error(`check-build: ${buildDir} not found — run \`npm run build\` first.`);
	process.exit(1);
}

const htmlFiles = files.filter((f) => extname(f) === ".html");
const cssFiles = files.filter((f) => extname(f) === ".css");
const errors = [];

if (htmlFiles.length === 0) errors.push("no HTML files found in build/");

// --- 1. CTA links present on the prerendered pages -------------------------
const SIGNUP = "https://brain.brownmatter.ai/signup";
const LOGIN = "https://brain.brownmatter.ai/login";
for (const page of ["index.html", "docs.html"]) {
	const file = htmlFiles.find((f) => f.endsWith(`/${page}`) || f.endsWith(`\\${page}`));
	if (!file) {
		errors.push(`expected prerendered page missing: ${page}`);
		continue;
	}
	const html = readFileSync(file, "utf8");
	if (!html.includes(SIGNUP)) errors.push(`${page}: missing signup URL ${SIGNUP}`);
	if (!html.includes(LOGIN)) errors.push(`${page}: missing login URL ${LOGIN}`);
}

// --- 2. no external assets --------------------------------------------------
// HTML: any resource-loading tag whose src/href/srcset points off-origin.
const RESOURCE_TAG =
	/<(script|link|img|source|video|audio|iframe|embed|object)\b[^>]*>/gis;
const EXTERNAL_URL = /(?:src|href|srcset|data)\s*=\s*["'](?:https?:)?\/\//i;
// <link> rels that are pure metadata — the browser never fetches them.
const NON_FETCHING_LINK = /<link\b[^>]*rel\s*=\s*["'](?:canonical|alternate|me|license)["']/i;
for (const file of htmlFiles) {
	const html = readFileSync(file, "utf8");
	for (const [tag] of html.matchAll(RESOURCE_TAG)) {
		if (NON_FETCHING_LINK.test(tag)) continue;
		if (EXTERNAL_URL.test(tag)) {
			errors.push(`${file.slice(buildDir.length + 1)}: external asset reference: ${tag.slice(0, 120)}`);
		}
	}
}

// CSS: url(...) and @import pointing at http(s).
for (const file of cssFiles) {
	const css = readFileSync(file, "utf8");
	if (/url\(\s*["']?(?:https?:)?\/\//i.test(css) || /@import\s+["'(]*\s*(?:https?:)?\/\//i.test(css)) {
		errors.push(`${file.slice(buildDir.length + 1)}: external URL in CSS`);
	}
}

if (errors.length > 0) {
	console.error(`check-build: FAILED (${errors.length} problem${errors.length === 1 ? "" : "s"})`);
	for (const e of errors) console.error(`  - ${e}`);
	process.exit(1);
}

console.log(
	`check-build: OK — ${htmlFiles.length} HTML files, CTA links present, no external asset references.`,
);
