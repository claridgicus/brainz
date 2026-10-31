// Graph bench harness: mounts the real Graph.svelte over a synthetic vault so
// scripts/graph-perf.mjs (fps) and scripts/e2e-graph.mjs (LOD/cluster UI) can
// drive it in headless Chrome without a wrangler stack.
// URL params: n (concept count, default 2000), mode=auto|all (auto = semantic
// zoom LOD, all = every type shown), bundle=0 (straight edges), budget (node cap),
// flatmax (flat-layout threshold override), dsize (concepts per domain, default 40;
// ~14 mimics a real product vault with many small domains), keep=1 (keep localStorage),
// orphans (share of concepts with no part_of parent, e.g. 0.5).
import { mount } from "svelte";
import "../../src/app.css";
import Bench from "./Bench.svelte";
import { syntheticGraph } from "./synthetic";

const params = new URLSearchParams(location.search);
const n = Number(params.get("n") ?? 2000);
const mode = params.get("mode") === "all" ? "all" : "auto";
// No persisted anchors / layout / expand policy between runs (keep=1 keeps them:
// the e2e reloads with it to check per-vault persistence).
if (params.get("keep") !== "1") localStorage.clear();
const graph = syntheticGraph(n, 42, params.has("dsize") ? Number(params.get("dsize")) : undefined, Number(params.get("orphans") ?? 0));
const bundling = params.get("bundle") !== "0";
const budget = params.has("budget") ? Number(params.get("budget")) : undefined;
const flatMax = params.has("flatmax") ? Number(params.get("flatmax")) : undefined;
mount(Bench, { target: document.getElementById("app")!, props: { graph, mode, bundling, budget, flatMax } });
