#!/usr/bin/env node
/**
 * Graph-view perf check: builds the bench harness (bench/graph — the real
 * Graph.svelte over deterministic synthetic vaults, no stack needed), opens it
 * in headless Chrome over CDP and prints fps for each synthetic vault size:
 *
 *   load  — the first 3s after mount (layout settling + first paint)
 *   pan   — 3s of continuous drag-panning once settled (initial view)
 *   zoom  — 3s of wheel zoom in/out at the viewport centre (crosses the
 *           cluster expand/collapse thresholds)
 *   panIn — 3s of panning zoomed in (k≈1), where clusters are open and the
 *           node budget is in play
 *
 * For each phase it reports fps, p95 frame time, main-thread split per second
 * (script / style+layout / other ≈ paint+composite, from Performance.getMetrics)
 * and how many node elements are in the DOM.
 *
 * Modes: auto (semantic-zoom type LOD, the default view), all (every type
 * shown), all-flat-edges (every type, edge bundling off — the bundling cost).
 *
 * Run: node scripts/graph-perf.mjs [--sizes 500,2000,5000]
 *      [--modes auto,all,all-flat-edges] [--json out.json] [--headed]
 *      [--software] [--dist dir]   (GRAPH_PERF_SKIP_BUILD=1 reuses a build)
 *
 * Headless Chrome rasterizes on the GPU (ANGLE over Vulkan) unless --software
 * is given — SwiftShader's CPU raster makes paint costs look many times worse
 * than a desktop Chrome. Check the "renderer" line it prints.
 */
import { spawnSync } from "node:child_process";
import { writeFileSync } from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { launch, serveDir } from "../bench/graph/cdp.mjs";

const appDir = path.resolve(fileURLToPath(new URL("..", import.meta.url)));
const benchDir = path.join(appDir, "bench", "graph");
const argv = process.argv.slice(2);
const arg = (name, dflt) => {
	const i = argv.indexOf(`--${name}`);
	return i >= 0 ? argv[i + 1] : dflt;
};
const sizes = arg("sizes", "500,2000,5000").split(",").map(Number);
const modes = arg("modes", "auto,all,all-flat-edges").split(",");
const jsonOut = arg("json", null);
const headed = argv.includes("--headed");
const software = argv.includes("--software");
const dist = arg("dist", path.join(benchDir, "dist"));
if (!software && !process.env.CHROME_FLAGS) {
	process.env.CHROME_FLAGS = "--ignore-gpu-blocklist --use-angle=vulkan --enable-features=Vulkan --enable-gpu-rasterization";
}
const PHASE_MS = 3000;

if (!process.env.GRAPH_PERF_SKIP_BUILD && !argv.includes("--dist")) {
	const res = spawnSync("npx", ["vite", "build", "--config", "bench/graph/vite.config.ts"], { cwd: appDir, stdio: "inherit" });
	if (res.status !== 0) process.exit(res.status ?? 1);
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// In-page frame meter: rAF deltas between start() and stop().
const METER = `(() => {
	if (window.__meter) return;
	let frames = [], last = 0, on = false;
	const loop = (t) => { if (on) { if (last) frames.push(t - last); last = t; requestAnimationFrame(loop); } };
	window.__meter = {
		start() { frames = []; last = 0; on = true; requestAnimationFrame(loop); },
		stop() {
			on = false;
			const sorted = [...frames].sort((a, b) => a - b);
			const total = frames.reduce((a, b) => a + b, 0);
			return {
				fps: total > 0 ? (frames.length * 1000) / total : 0,
				p95: sorted[Math.floor(sorted.length * 0.95)] ?? 0,
				max: sorted[sorted.length - 1] ?? 0,
			};
		},
	};
})()`;

async function phase(page, name, drive) {
	await page.evaluate("window.__meter.start()");
	const m0 = await page.metrics();
	const t0 = Date.now();
	await drive();
	const secs = (Date.now() - t0) / 1000;
	const m1 = await page.metrics();
	const frame = await page.evaluate("window.__meter.stop()");
	const d = (k) => ((m1[k] ?? 0) - (m0[k] ?? 0)) / secs;
	const script = d("ScriptDuration") * 1000;
	const styleLayout = (d("RecalcStyleDuration") + d("LayoutDuration")) * 1000;
	const task = d("TaskDuration") * 1000;
	const dom = await page.evaluate(
		"({ nodes: document.querySelectorAll('svg g.node').length, clusters: document.querySelectorAll('svg g.cluster').length, edges: document.querySelectorAll('svg > g line:not(.tie), svg path.edge').length })",
	);
	return {
		phase: name,
		fps: +frame.fps.toFixed(1),
		p95ms: +frame.p95.toFixed(1),
		maxms: +frame.max.toFixed(1),
		scriptMsPerS: Math.round(script),
		styleLayoutMsPerS: Math.round(styleLayout),
		otherMsPerS: Math.round(Math.max(0, task - script - styleLayout)),
		...dom,
	};
}

// A point on empty canvas near the centre (dragging a node or bubble would move
// it instead of panning).
async function emptyPoint(page) {
	return page.evaluate(`(() => {
		const svg = document.querySelector('svg[aria-label="Concept graph"]');
		for (let r = 0; r < 400; r += 12) for (let a = 0; a < 6.28; a += 0.5) {
			const x = innerWidth / 2 + Math.cos(a) * r, y = innerHeight / 2 + Math.sin(a) * r;
			const el = document.elementFromPoint(x, y);
			if (el === svg || (el && el.closest('g.hull'))) return [x, y];
		}
		return [innerWidth / 2, innerHeight / 2];
	})()`);
}

async function pan(page) {
	const [cx, cy] = await emptyPoint(page);
	await page.mouse("mouseMoved", cx, cy, { buttons: 0 });
	await page.mouse("mousePressed", cx, cy);
	const t0 = Date.now();
	while (Date.now() - t0 < PHASE_MS) {
		const a = (Date.now() - t0) / 400;
		await page.mouse("mouseMoved", cx + Math.cos(a) * 260, cy + Math.sin(a) * 180);
		await sleep(8);
	}
	await page.mouse("mouseReleased", cx, cy);
}

async function zoom(page) {
	const cx = page.width / 2;
	const cy = page.height / 2;
	const t0 = Date.now();
	let i = 0;
	while (Date.now() - t0 < PHASE_MS) {
		// 1.5s in, 1.5s out
		await page.wheel(cx, cy, (Date.now() - t0) % 3000 < 1500 ? -40 : 40);
		await sleep(12);
		i++;
	}
}

const server = await serveDir(dist);
const page = await launch({ headless: !headed });
console.log(
	"renderer:",
	await page.evaluate(
		"(() => { const c = document.createElement('canvas').getContext('webgl'); const d = c && c.getExtension('WEBGL_debug_renderer_info'); return d ? c.getParameter(d.UNMASKED_RENDERER_WEBGL) : 'unknown'; })()",
	),
);
const rows = [];
try {
	for (const mode of modes) {
		for (const n of sizes) {
			const query = mode === "all-flat-edges" ? "mode=all&bundle=0" : `mode=${mode}`;
			await page.navigate(`${server.url}/?n=${n}&${query}`);
			await page.evaluate(METER);
			const load = await phase(page, "load", () => sleep(PHASE_MS));
			// Let the layout settle (new impl reports it; otherwise cap the wait).
			const settleStart = Date.now();
			while (Date.now() - settleStart < 15_000) {
				const settled = await page.evaluate("document.querySelector('svg[aria-label=\"Concept graph\"]')?.dataset.settled === '1'");
				if (settled) break;
				await sleep(250);
			}
			const settleMs = Date.now() - settleStart + PHASE_MS;
			const bundleMs = await page.evaluate("Number(document.querySelector('svg[aria-label=\"Concept graph\"]')?.dataset.bundleMs ?? 0)");
			const p = await phase(page, "pan", () => pan(page));
			const z = await phase(page, "zoom", () => zoom(page));
			// Fresh load, zoom in to k≈1 around the centre, let the LOD settle, then
			// pan there (a fresh page so earlier phases can't skew this one).
			await page.navigate(`${server.url}/?n=${n}&${query}`);
			await page.evaluate(METER);
			await sleep(3500);
			await page.evaluate(`(() => {
				const svg = document.querySelector('svg[aria-label="Concept graph"]');
				const m = /scale\\(([\\d.]+)\\)/.exec(svg.querySelector('g').getAttribute('transform'));
				const k = m ? Number(m[1]) : 1;
				const steps = Math.max(0, Math.round(Math.log(1 / k) / 0.0022 / 60));
				for (let i = 0; i < steps; i++) svg.dispatchEvent(new WheelEvent('wheel', { deltaY: -60, clientX: innerWidth / 2, clientY: innerHeight / 2, bubbles: true, cancelable: true }));
			})()`);
			await sleep(1500);
			const pi = await phase(page, "panIn", () => pan(page));
			for (const r of [load, p, z, pi]) rows.push({ n, mode, ...r, ...(r.phase === "load" ? { settleMs, bundleMs } : {}) });
			console.log(
				`n=${String(n).padStart(5)} ${mode.padEnd(14)} settle ${String(settleMs).padStart(5)}ms bundle ${bundleMs}ms  ` +
					[load, p, z, pi]
						.map((r) => `${r.phase} ${String(r.fps).padStart(5)}fps p95 ${String(r.p95ms).padStart(6)}ms [js ${r.scriptMsPerS} sl ${r.styleLayoutMsPerS} other ${r.otherMsPerS} ms/s, ${r.nodes}n ${r.clusters}c ${r.edges}e]`)
						.join("  |  "),
			);
		}
	}
} finally {
	await page.close();
	server.close();
}
if (jsonOut) writeFileSync(jsonOut, JSON.stringify(rows, null, 2));
