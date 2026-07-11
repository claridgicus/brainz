#!/usr/bin/env node
/**
 * Renders the committed social-card sources in assets/ to PNGs in static/:
 *   assets/og.html         → static/og.png              (1200×630)
 *   assets/touch-icon.html → static/apple-touch-icon.png (180×180)
 *
 * Uses headless Chrome (CHROME_BIN overrides the binary path). This is a
 * design-time tool, not part of the build — the PNGs are committed; re-run
 * only when a card source changes, then commit the result.
 */
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath, pathToFileURL } from "node:url";
import { join } from "node:path";

const root = fileURLToPath(new URL("..", import.meta.url));

const CHROME_CANDIDATES = [
	process.env.CHROME_BIN,
	"/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
	"/usr/bin/google-chrome",
	"/usr/bin/chromium",
	"/usr/bin/chromium-browser",
].filter(Boolean);
const chrome = CHROME_CANDIDATES.find((p) => existsSync(p));
if (!chrome) {
	console.error("generate-og: no Chrome binary found — set CHROME_BIN.");
	process.exit(1);
}

const SHOTS = [
	{ src: "assets/og.html", out: "static/og.png", width: 1200, height: 630 },
	{ src: "assets/touch-icon.html", out: "static/apple-touch-icon.png", width: 180, height: 180 },
];

/** Width/height from a PNG's IHDR chunk (bytes 16-23). */
function pngSize(path) {
	const buf = readFileSync(path);
	return { width: buf.readUInt32BE(16), height: buf.readUInt32BE(20) };
}

for (const { src, out, width, height } of SHOTS) {
	const outPath = join(root, out);
	execFileSync(
		chrome,
		[
			"--headless=new",
			"--disable-gpu",
			"--hide-scrollbars",
			"--force-device-scale-factor=1",
			`--window-size=${width},${height}`,
			`--screenshot=${outPath}`,
			"--virtual-time-budget=5000",
			pathToFileURL(join(root, src)).href,
		],
		{ stdio: "pipe" },
	);
	const got = pngSize(outPath);
	if (got.width !== width || got.height !== height) {
		console.error(`generate-og: ${out} is ${got.width}×${got.height}, expected ${width}×${height}`);
		process.exit(1);
	}
	console.log(`generate-og: wrote ${out} (${width}×${height})`);
}
