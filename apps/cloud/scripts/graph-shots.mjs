#!/usr/bin/env node
/**
 * Graph-view screenshots over the bench harness (bench/graph — the real
 * Graph.svelte over deterministic synthetic vaults, never real vault data), for
 * eyeballing the edge bundling before/after a visual change:
 *
 *   <prefix>-<n>-<mode>-overview.png  settled initial view (cluster overview)
 *   <prefix>-<n>-<mode>-zoomed.png    zoomed in to k≈0.5 (clusters opening)
 *   <prefix>-<n>-<mode>-close.png     zoomed in to k≈1.2 (concepts + strands)
 *
 * Run: node scripts/graph-shots.mjs [--out dir] [--prefix after]
 *      [--shots 2000:auto,5000:all,150:all]   (GRAPH_SHOTS_SKIP_BUILD=1 reuses a build)
 */
import { spawnSync } from "node:child_process";
import { mkdirSync } from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { launch, serveDir } from "../bench/graph/cdp.mjs";

const appDir = path.resolve(fileURLToPath(new URL("..", import.meta.url)));
const argv = process.argv.slice(2);
const arg = (name, dflt) => {
	const i = argv.indexOf(`--${name}`);
	return i >= 0 ? argv[i + 1] : dflt;
};
const out = path.resolve(arg("out", "graph-shots"));
const prefix = arg("prefix", "shot");
const shots = arg("shots", "2000:auto,5000:all,150:all")
	.split(",")
	.map((s) => {
		const [n, mode] = s.split(":");
		return { n: Number(n), mode: mode ?? "auto" };
	});
mkdirSync(out, { recursive: true });
if (!process.env.CHROME_FLAGS) {
	process.env.CHROME_FLAGS = "--ignore-gpu-blocklist --use-angle=vulkan --enable-features=Vulkan --enable-gpu-rasterization";
}
if (!process.env.GRAPH_SHOTS_SKIP_BUILD) {
	const res = spawnSync("npx", ["vite", "build", "--config", "bench/graph/vite.config.ts"], { cwd: appDir, stdio: "inherit" });
	if (res.status !== 0) process.exit(res.status ?? 1);
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const SVG = `document.querySelector('svg[aria-label="Concept graph"]')`;

const server = await serveDir(path.join(appDir, "bench", "graph", "dist"));
const page = await launch({ width: 1600, height: 1000 });
async function settle() {
	const t0 = Date.now();
	while (Date.now() - t0 < 15_000) {
		if (await page.evaluate(`${SVG}?.dataset.settled === '1'`)) break;
		await sleep(200);
	}
	await sleep(600);
}
async function zoomTo(k) {
	const cur = await page.evaluate(`parseFloat(${SVG}.querySelector('g').getAttribute('transform').split('scale(')[1])`);
	const steps = Math.round(Math.log(k / cur) / 0.0022 / 60);
	await page.evaluate(`(() => {
		const svg = ${SVG};
		for (let i = 0; i < ${Math.abs(steps)}; i++) svg.dispatchEvent(new WheelEvent('wheel', { deltaY: ${steps < 0 ? 60 : -60}, clientX: innerWidth / 2, clientY: innerHeight / 2, bubbles: true, cancelable: true }));
	})()`);
	await sleep(1200);
	await settle();
}
try {
	for (const { n, mode } of shots) {
		await page.navigate(`${server.url}/?n=${n}&mode=${mode}`);
		await sleep(1000);
		await settle();
		const base = path.join(out, `${prefix}-${n}-${mode}`);
		await page.screenshot(`${base}-overview.png`);
		if (n > 250) {
			await zoomTo(0.5);
			await page.screenshot(`${base}-zoomed.png`);
		}
		await zoomTo(1.2);
		await page.screenshot(`${base}-close.png`);
		console.log(`${base}-*.png`, JSON.stringify(await page.evaluate(`({ ...${SVG}.dataset })`)));
	}
} finally {
	await page.close();
	server.close();
}
