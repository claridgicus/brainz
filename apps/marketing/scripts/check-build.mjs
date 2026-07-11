#!/usr/bin/env node
/**
 * Post-build sanity check for the marketing site (run `npm run build` first):
 *   1. every prerendered page links to the app's signup + login URLs;
 *   2. no external http(s) ASSET references anywhere in the build —
 *      scripts, stylesheets, images, fonts, iframes must all be self-hosted.
 *      (Anchor hrefs to the app / GitHub are expected and allowed.)
 *   3. SEO head is complete on every prerendered page (canonical, OG tags,
 *      og:image, large twitter card, JSON-LD), the social-card PNGs exist at
 *      their expected dimensions, and sitemap.xml covers exactly the
 *      prerendered pages.
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
const SIGNUP = "https://brainz.brownmatter.ai/signup";
const LOGIN = "https://brainz.brownmatter.ai/login";
for (const page of ["index.html", "docs.html"]) {
	const file = htmlFiles.find((f) => f.endsWith(`/${page}`) || f.endsWith(`\\${page}`));
	if (!file) {
		errors.push(`expected prerendered page missing: ${page}`);
		continue;
	}
	const html = readFileSync(file, "utf8");
	if (!html.includes(SIGNUP)) errors.push(`${page}: missing signup URL ${SIGNUP}`);
	if (!html.includes(LOGIN)) errors.push(`${page}: missing login URL ${LOGIN}`);
	// Brand model: Brownmatter is the company, Brainz the product. The footer
	// (rendered on every page) must carry the attribution line, and the retired
	// brain.* host must never appear.
	if (!html.includes("Brainz is a Brownmatter product")) {
		errors.push(`${page}: missing the "Brainz is a Brownmatter product" footer line`);
	}
	if (/https?:\/\/brain\.brownmatter\.ai/.test(html)) {
		errors.push(`${page}: references the retired brain.brownmatter.ai host`);
	}
}

// --- 1b. agent-driven signup is visible ------------------------------------
// Landing page carries the self-provisioning feature card; docs carry the
// agent-signup section (anchor target of the landing-page link). The retired
// Wave G copy (signup returning a loginUrl) must never resurface: signup
// returns { apiKey, vaultSlug, expiresAt, claimEmailSent } — no URL of any
// kind; the claim approval link is only ever EMAILED to the human.
{
	const index = htmlFiles.find((f) => f.endsWith("/index.html") || f.endsWith("\\index.html"));
	const docs = htmlFiles.find((f) => f.endsWith("/docs.html") || f.endsWith("\\docs.html"));
	if (index) {
		const html = readFileSync(index, "utf8");
		if (!html.includes("No signup form required")) {
			errors.push("index.html: missing the agent self-provisioning feature card");
		}
		if (!/tools\/call signup/.test(html)) {
			errors.push("index.html: missing the signup tool transcript snippet");
		}
	}
	if (docs) {
		const html = readFileSync(docs, "utf8");
		if (!html.includes('id="agent-signup"')) {
			errors.push("docs.html: missing the #agent-signup section");
		}
	}
	for (const [file, name] of [[index, "index.html"], [docs, "docs.html"]]) {
		if (!file) continue;
		const html = readFileSync(file, "utf8");
		if (html.includes("loginUrl")) {
			errors.push(`${name}: mentions "loginUrl" — retired Wave G copy; signup returns no URL of any kind`);
		}
	}
}

// --- 1c. onboarding, the task queue, and teams are documented ----------------
// Docs carry the "Onboard your product" section, list the onboard + task tools
// in the thirteen-tool table, and document vault membership.
{
	const docs = htmlFiles.find((f) => f.endsWith("/docs.html") || f.endsWith("\\docs.html"));
	if (docs) {
		const html = readFileSync(docs, "utf8");
		if (!html.includes('id="onboard"')) {
			errors.push("docs.html: missing the #onboard section");
		}
		if (!html.includes("Onboard this vault")) {
			errors.push("docs.html: onboard tool missing from the tools table");
		}
		if (!html.includes("thirteen MCP tools")) {
			errors.push("docs.html: tools section heading should say thirteen MCP tools");
		}
		if (!html.includes("take_task")) {
			errors.push("docs.html: missing take_task — the task tools must be documented");
		}
		if (!html.includes('id="teams"')) {
			errors.push("docs.html: missing the #teams (vault membership) section");
		}
	}
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

// --- 3. SEO head on every prerendered page ----------------------------------
// 404.html is the client-rendered fallback shell — its head is empty by design.
const SITE_URL = "https://brownmatter.ai";
const OG_IMAGE = `${SITE_URL}/og.png`;
const prerendered = htmlFiles.filter((f) => !f.endsWith("404.html"));
for (const file of prerendered) {
	const name = file.slice(buildDir.length + 1);
	const html = readFileSync(file, "utf8");
	const required = [
		['<link rel="canonical"', "canonical link"],
		['property="og:title"', "og:title"],
		['property="og:description"', "og:description"],
		[`property="og:image" content="${OG_IMAGE}"`, `og:image pointing at ${OG_IMAGE}`],
		['name="twitter:card" content="summary_large_image"', "twitter:card summary_large_image"],
		['<script type="application/ld+json">', "JSON-LD structured data"],
		['<meta name="description"', "meta description"],
	];
	for (const [needle, label] of required) {
		if (!html.includes(needle)) errors.push(`${name}: missing ${label}`);
	}
	// Every canonical/og:url must be a SITE_URL page, never a *.pages.dev or localhost.
	const canonical = html.match(/<link rel="canonical" href="([^"]*)"/)?.[1];
	if (canonical && !canonical.startsWith(SITE_URL)) {
		errors.push(`${name}: canonical points off-site: ${canonical}`);
	}
}

// --- 4. social-card PNGs exist at the expected dimensions --------------------
function pngSize(path) {
	const buf = readFileSync(path);
	return { width: buf.readUInt32BE(16), height: buf.readUInt32BE(20) };
}
for (const [file, width, height] of [
	["og.png", 1200, 630],
	["apple-touch-icon.png", 180, 180],
]) {
	try {
		const got = pngSize(join(buildDir, file));
		if (got.width !== width || got.height !== height) {
			errors.push(`${file}: is ${got.width}×${got.height}, expected ${width}×${height}`);
		}
	} catch {
		errors.push(`${file}: missing from build/ — run \`node scripts/generate-og.mjs\` and commit`);
	}
}

// --- 5. sitemap.xml covers exactly the prerendered pages ---------------------
{
	const expected = prerendered
		.map((f) => {
			const rel = f.slice(buildDir.length + 1).replaceAll("\\", "/");
			if (rel === "index.html") return `${SITE_URL}/`;
			return `${SITE_URL}/${rel.replace(/\/index\.html$/, "").replace(/\.html$/, "")}`;
		})
		.sort();
	let inSitemap = [];
	try {
		const xml = readFileSync(join(buildDir, "sitemap.xml"), "utf8");
		inSitemap = [...xml.matchAll(/<loc>([^<]*)<\/loc>/g)].map((m) => m[1]).sort();
	} catch {
		errors.push("sitemap.xml: missing from build/ — `npm run build` generates it");
	}
	if (inSitemap.length > 0 && JSON.stringify(inSitemap) !== JSON.stringify(expected)) {
		errors.push(
			`sitemap.xml out of sync — has [${inSitemap.join(", ")}], pages are [${expected.join(", ")}]`,
		);
	}
	try {
		const robots = readFileSync(join(buildDir, "robots.txt"), "utf8");
		if (!robots.includes(`Sitemap: ${SITE_URL}/sitemap.xml`)) {
			errors.push("robots.txt: missing the Sitemap directive");
		}
	} catch {
		errors.push("robots.txt: missing from build/");
	}
}

if (errors.length > 0) {
	console.error(`check-build: FAILED (${errors.length} problem${errors.length === 1 ? "" : "s"})`);
	for (const e of errors) console.error(`  - ${e}`);
	process.exit(1);
}

console.log(
	`check-build: OK — ${htmlFiles.length} HTML files, CTA links present, no external asset references, SEO head + social cards + sitemap verified.`,
);
