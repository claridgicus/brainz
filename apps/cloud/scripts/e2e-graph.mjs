#!/usr/bin/env node
/**
 * Graph workspace UI E2E — level of detail, clusters and edge bundling, driven
 * in headless Chrome over CDP against the bench harness (bench/graph: the real
 * Graph.svelte over deterministic synthetic vaults; no wrangler stack needed).
 *
 * Covers: the clustered overview (one bubble per cluster with its size), click
 * to expand, collapse on zoom-out, the hard node budget (partial expansion with
 * a "+N" bubble), distance-based detail tiers, jumping to a concept hidden in a
 * collapsed cluster (search/select path), selection keeps its neighbours
 * rendered, click-focus, bundled edges with cable-ties + edge hover highlight,
 * the flat layout for small vaults, mid-size vaults showing individual nodes at
 * the default zoom (flat up to FLAT_MAX_NODES, auto-expanded clusters above), the
 * Expand all / Collapse all control (budget-aware, remembered per vault) and
 * link-community clusters (no "Unfiled <type>" buckets).
 *
 * Run: node scripts/e2e-graph.mjs   (E2E_GRAPH_SKIP_BUILD=1 reuses a build)
 */
import { spawnSync } from "node:child_process";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { findChrome, launch, serveDir } from "../bench/graph/cdp.mjs";

const appDir = path.resolve(fileURLToPath(new URL("..", import.meta.url)));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let passed = 0;
let failed = 0;
function step(name, ok, detail = "") {
	console.log(`  [${ok ? "PASS" : "FAIL"}] ${name}${detail ? ` — ${detail}` : ""}`);
	if (ok) passed++;
	else {
		failed++;
		process.exitCode = 1;
	}
}

if (!findChrome()) {
	console.log("e2e-graph: no Chrome/Chromium found (set CHROME_BIN) — skipped");
	process.exit(0);
}
if (!process.env.E2E_GRAPH_SKIP_BUILD) {
	const res = spawnSync("npx", ["vite", "build", "--config", "bench/graph/vite.config.ts"], { cwd: appDir, stdio: "inherit" });
	if (res.status !== 0) process.exit(res.status ?? 1);
}

const server = await serveDir(path.join(appDir, "bench", "graph", "dist"));
const page = await launch({ width: 1400, height: 900 });
const errors = [];
page.on("Runtime.exceptionThrown", (p) => errors.push(p.exceptionDetails.exception?.description ?? p.exceptionDetails.text));

const SVG = `document.querySelector('svg[aria-label="Concept graph"]')`;
const stats = () => page.evaluate(`({ ...${SVG}.dataset })`);
const scale = () => page.evaluate(`parseFloat(${SVG}.querySelector('g').getAttribute('transform').split('scale(')[1])`);
/** Wheel at the viewport centre: steps < 0 zooms in. */
const wheel = (steps) =>
	page.evaluate(`(() => {
		const svg = ${SVG};
		for (let i = 0; i < ${Math.abs(steps)}; i++) svg.dispatchEvent(new WheelEvent('wheel', { deltaY: ${steps < 0 ? -60 : 60}, clientX: innerWidth / 2, clientY: innerHeight / 2, bubbles: true, cancelable: true }));
	})()`);
/** Zoom to (about) scale k around the centre. */
async function zoomTo(k) {
	const cur = await scale();
	const steps = Math.round(Math.log(k / cur) / 0.0022 / 60);
	await wheel(-steps);
	await sleep(700); // trailing throttled LOD pass
}
/** Click a button of the cluster expand control by its label, then let the LOD pass run. */
async function clickCtl(label) {
	const pt = await page.evaluate(`(() => { const b = [...document.querySelectorAll('.expand-ctl button')].find((x) => x.textContent.trim() === ${JSON.stringify(label)}); if (!b) return null; const r = b.getBoundingClientRect(); return { x: r.x + r.width / 2, y: r.y + r.height / 2 }; })()`);
	if (!pt) throw new Error(`no expand control button "${label}"`);
	await page.click(pt.x, pt.y);
	await sleep(900);
}
async function open(query) {
	await page.navigate(`${server.url}/?${query}`);
	// The flat layout animates its settle (~4s at 300 concepts) before it fits the view.
	for (let i = 0; i < 150; i++) {
		if ((await page.evaluate(`${SVG}?.dataset.settled === '1'`)) === true) break;
		await sleep(100);
	}
	await sleep(400);
}

try {
	console.log("clustered overview (2000 concepts, all types)");
	await open("n=2000&mode=all");
	let s = await stats();
	step("large vault uses the clustered layout", s.mode === "tree", `mode=${s.mode}`);
	step("the 2k overview (too far out for nodes to read) stays one counted bubble per cluster", s.rendered === "0" && s.bubbles === s.clusters, `rendered=${s.rendered} bubbles=${s.bubbles}/${s.clusters}`);
	const titles = await page.evaluate(`[...document.querySelectorAll('g.cluster:not(.residual) text:not(.count)')].map((t) => t.textContent)`);
	step("clusters are link communities named after a concept, never 'Unfiled <type>'", titles.length > 0 && titles.every((t) => !/^Unfiled /.test(t)), titles.slice(0, 4).join(", "));
	await clickCtl("Collapse all");
	s = await stats();
	step("Collapse all: one bubble per cluster and no individual nodes", s.expandPolicy === "none" && s.bubbles === s.clusters && s.rendered === "0", `bubbles=${s.bubbles}/${s.clusters} rendered=${s.rendered}`);
	const sizes = await page.evaluate(`[...document.querySelectorAll('g.cluster text.count')].map((t) => Number(t.textContent))`);
	step("bubbles show their cluster size (sizes sum to the vault)", sizes.reduce((a, b) => a + b, 0) === 2000, `sum=${sizes.reduce((a, b) => a + b, 0)}`);
	step("edges between clusters are aggregated with weights", (await page.evaluate(`[...document.querySelectorAll('text.weight')].some((t) => t.style.display !== 'none' && Number(t.textContent) >= 2)`)) === true);
	step("edges are bundled through gates, with cable-ties", Number(s.bundles) > 0 && (await page.evaluate(`document.querySelectorAll('path.tie').length`)) > 0, `bundles=${s.bundles}`);
	step("bundled edges are curves", (await page.evaluate(`[...document.querySelectorAll('path.edge')].every((p) => (p.getAttribute('d') || '').includes('C'))`)) === true);

	console.log("expand on click, collapse on zoom out");
	const target = await page.evaluate(`(() => {
		const g = [...document.querySelectorAll('g.cluster:not(.residual)')].map((el) => ({ el, r: el.querySelector('circle').getBoundingClientRect() }))
			.sort((a, b) => Math.hypot(a.r.x + a.r.width / 2 - innerWidth / 2, a.r.y + a.r.height / 2 - innerHeight / 2) - Math.hypot(b.r.x + b.r.width / 2 - innerWidth / 2, b.r.y + b.r.height / 2 - innerHeight / 2))[0];
		return { id: g.el.dataset.cluster, x: g.r.x + g.r.width / 2, y: g.r.y + g.r.height / 2 };
	})()`);
	await page.click(target.x, target.y);
	await sleep(1200);
	s = await stats();
	step("clicking a bubble expands that cluster", s.expanded.split(",").includes(target.id), `expanded=${s.expanded}`);
	const members = await page.evaluate(`[...document.querySelectorAll('g.node')].map((g) => g.dataset.id)`);
	const domainId = target.id.replace("@c:", "");
	step("its members render individually", members.length > 0 && members.includes(domainId), `${members.length} nodes`);
	step("an expanded cluster draws its hull", (await page.evaluate(`!!document.querySelector('g.hull[data-cluster="${target.id}"]')`)) === true);
	step("rendered nodes stay within the budget", Number(s.rendered) <= 400, `rendered=${s.rendered}`);
	await wheel(25);
	await sleep(800);
	s = await stats();
	step("zooming out collapses clicked clusters again", s.expanded === "" && s.rendered === "0", `expanded=${s.expanded || "∅"} rendered=${s.rendered}`);

	console.log("Expand all / Collapse all (budget-aware, remembered per vault)");
	await clickCtl("Expand all");
	s = await stats();
	step("Expand all opens clusters at any size, up to the node budget", s.expandPolicy === "all" && Number(s.rendered) > 300 && Number(s.rendered) <= 400, `rendered=${s.rendered} policy=${s.expandPolicy}`);
	step("the active button is pressed", (await page.evaluate(`document.querySelector('.expand-ctl button[aria-pressed="true"]')?.textContent.trim()`)) === "Expand all");
	await page.navigate(`${server.url}/?n=2000&mode=all&keep=1`);
	await sleep(1500);
	s = await stats();
	step("the choice survives a reload (per vault)", s.expandPolicy === "all" && Number(s.rendered) > 300, `policy=${s.expandPolicy} rendered=${s.rendered}`);
	await clickCtl("Expand all");
	s = await stats();
	step("clicking the active button returns to automatic", s.expandPolicy === "auto", `policy=${s.expandPolicy}`);

	console.log("hard node budget (budget=60)");
	await open("n=2000&mode=all&budget=60");
	await zoomTo(0.9);
	s = await stats();
	const nodeCount = Number(s.rendered);
	step("never more than the budget of individual nodes", nodeCount <= 60 && nodeCount > 20, `rendered=${nodeCount}`);
	step("clusters beyond the budget stay bubbles or fold into '+N'", Number(s.bubbles) > 0, `bubbles=${s.bubbles}`);
	// pan around: the cap holds and nothing thrashes.
	const counts = [];
	for (let i = 0; i < 6; i++) {
		await page.mouse("mouseMoved", 300, 300, { buttons: 0 });
		await page.mouse("mousePressed", 300, 300);
		await page.mouse("mouseMoved", 300 + 120, 300 + 40 * (i % 2 ? -1 : 1));
		await page.mouse("mouseReleased", 420, 300);
		await sleep(250);
		counts.push(Number((await stats()).rendered));
	}
	step("cap holds while panning", counts.every((n) => n <= 60), counts.join(","));
	const before = (await stats()).expanded;
	await sleep(600);
	step("no thrash: the expanded set is stable when the view is still", (await stats()).expanded === before);

	console.log("detail tiers (default budget, zoomed in)");
	await open("n=2000&mode=all");
	await zoomTo(0.6);
	s = await stats();
	const tiers = await page.evaluate(`(() => {
		const els = [...document.querySelectorAll('g.node')];
		const d = (g) => { const r = g.querySelector('circle.mark').getBoundingClientRect(); return Math.hypot(r.x + r.width / 2 - innerWidth / 2, r.y + r.height / 2 - innerHeight / 2); };
		const far = els.filter((g) => g.classList.contains('far')).map(d);
		const full = els.filter((g) => !g.classList.contains('far')).map(d);
		return { far: far.length, full: full.length, maxFull: Math.max(0, ...full), minFar: Math.min(1e9, ...far) };
	})()`);
	step("many nodes in view: at most 160 drawn in full detail", tiers.full <= 160 + 10 && tiers.far > 0, `full=${tiers.full} far=${tiers.far} rendered=${s.rendered}`);
	step("full detail is nearest the centre, simplified marks further out", tiers.maxFull <= tiers.minFar + 1, `maxFull=${tiers.maxFull.toFixed(0)} minFar=${tiers.minFar.toFixed(0)}`);

	console.log("jump to a concept hidden in a collapsed cluster (search / select)");
	await open("n=2000&mode=all");
	const hidden = await page.evaluate(`(() => {
		const g = window.__bench.graph();
		const n = g.nodes.find((x) => x.type === 'story' && x.degree >= 3 && !document.querySelector('g.node[data-id="' + x.id + '"]'));
		const nbrs = g.edges.filter((e) => e.from === n.id || e.to === n.id).map((e) => (e.from === n.id ? e.to : e.from));
		return { id: n.id, nbrs };
	})()`);
	step("target starts hidden", (await page.evaluate(`!!document.querySelector('g.node[data-id="${hidden.id}"]')`)) === false);
	await page.evaluate(`window.__bench.select(${JSON.stringify(hidden.id)})`);
	await sleep(1200);
	const sel = await page.evaluate(`(() => {
		const el = document.querySelector('g.node[data-id="${hidden.id}"]');
		const r = el?.getBoundingClientRect();
		return { present: !!el, selected: el?.classList.contains('selected') ?? false, cx: r ? r.x + r.width / 2 : -1, cy: r ? r.y + r.height / 2 : -1 };
	})()`);
	step("selecting it renders it, selected, near the centre", sel.present && sel.selected && Math.hypot(sel.cx - 700, sel.cy - 450) < 120, JSON.stringify(sel));
	const nbrPresent = await page.evaluate(`${JSON.stringify(hidden.nbrs)}.every((id) => !!document.querySelector('g.node[data-id="' + id + '"]'))`);
	step("its neighbours are always rendered", nbrPresent === true, `${hidden.nbrs.length} neighbours`);
	step("its edges trace through their bundles (highlighted)", (await page.evaluate(`document.querySelectorAll('path.edge.sel').length`)) > 0);

	console.log("click focus + edge hover");
	const nodePt = await page.evaluate(`(() => { const r = document.querySelector('g.node[data-id="${hidden.id}"] circle.mark').getBoundingClientRect(); return { x: r.x + r.width / 2, y: r.y + r.height / 2 }; })()`);
	await page.click(nodePt.x, nodePt.y);
	await sleep(400);
	step("clicking a node focuses it (dims the rest)", (await page.evaluate(`${SVG}.classList.contains('focusing')`)) === true);
	await page.click(1380, 20); // empty top-right corner (the expand control sits top-left)
	await sleep(300);
	step("clicking empty canvas clears focus", (await page.evaluate(`${SVG}.classList.contains('focusing')`)) === false);
	const hl = await page.evaluate(`(() => {
		const p = document.querySelector('path.edge');
		p.dispatchEvent(new PointerEvent('pointerenter', { clientX: 10, clientY: 10 }));
		const on = p.classList.contains('hl') && p === p.parentNode.lastElementChild;
		p.dispatchEvent(new PointerEvent('pointerleave'));
		return on;
	})()`);
	step("hovering an edge highlights it and raises it above its bundle", hl === true);

	console.log("auto (semantic zoom) mode");
	await open("n=2000&mode=auto");
	s = await stats();
	step("auto mode at 2k opens on the counted cluster overview (domains-only tier stays bubbles)", s.mode === "tree" && Number(s.bubbles) >= Number(s.clusters) - 4, `bubbles=${s.bubbles}/${s.clusters} rendered=${s.rendered}`);

	console.log("mid-size vaults show individual nodes at the default zoom");
	for (const [q, min] of [["n=300&dsize=14&mode=all", 200], ["n=300&dsize=14&mode=auto", 60], ["n=301&dsize=14&mode=auto", 60], ["n=600&dsize=14&mode=auto", 60], ["n=1000&mode=auto", 60]]) {
		await open(q);
		s = await stats();
		step(`${q}: ${s.mode} layout renders ≥${min} concept nodes on load`, Number(s.rendered) >= min && Number(s.rendered) <= 400, `mode=${s.mode} rendered=${s.rendered} bubbles=${s.bubbles} k=${(await scale()).toFixed(2)}`);
	}

	console.log("small vault keeps the flat layout");
	await open("n=100&mode=all");
	s = await stats();
	step("flat layout, every node rendered, no bubbles", s.mode === "flat" && s.bubbles === "0" && Number(s.rendered) > 50, `mode=${s.mode} rendered=${s.rendered}`);
	const overlaps = await page.evaluate(`(() => {
		const r = [...document.querySelectorAll('g.node:not(.far) circle.mark')].map((c) => c.getBoundingClientRect());
		let n = 0;
		for (let i = 0; i < r.length; i++) for (let j = i + 1; j < r.length; j++) {
			const a = r[i], b = r[j];
			const d = Math.hypot(a.x + a.width / 2 - b.x - b.width / 2, a.y + a.height / 2 - b.y - b.height / 2);
			if (d < (a.width + b.width) / 2) n++;
		}
		return n;
	})()`);
	step("spread-out layout: node circles don't overlap", overlaps === 0, `${overlaps} overlapping pairs`);

	step("no uncaught page errors", errors.length === 0, errors.slice(0, 3).join(" | "));
} finally {
	await page.close();
	server.close();
}
console.log(`\ne2e-graph: ${passed} passed, ${failed} failed`);
