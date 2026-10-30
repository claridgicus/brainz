// Graph bench harness: mounts the real Graph.svelte over a synthetic vault so
// scripts/graph-perf.mjs (fps) and scripts/e2e-graph.mjs (LOD/cluster UI) can
// drive it in headless Chrome without a wrangler stack.
// URL params: n (concept count, default 2000), mode=auto|all (auto = semantic
// zoom LOD, all = every type shown), bundle=0 (straight edges), budget (node cap).
import { mount } from "svelte";
import "../../src/app.css";
import Bench from "./Bench.svelte";
import { syntheticGraph } from "./synthetic";

const params = new URLSearchParams(location.search);
const n = Number(params.get("n") ?? 2000);
const mode = params.get("mode") === "all" ? "all" : "auto";
localStorage.clear(); // no persisted anchors / filter state between runs
const graph = syntheticGraph(n);
const bundling = params.get("bundle") !== "0";
const budget = params.has("budget") ? Number(params.get("budget")) : undefined;
mount(Bench, { target: document.getElementById("app")!, props: { graph, mode, bundling, budget } });
