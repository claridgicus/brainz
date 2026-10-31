<script lang="ts">
	// Force-directed graph — a Svelte port of packages/web/frontend/main.ts.
	// The simulation + SVG management stays imperative (d3-force mutates node
	// objects every tick); Svelte owns the chrome around it.
	//
	// Two layouts, picked by vault size (see SPEC-CLOUD "Graph workspace"):
	//  - flat  (<= FLAT_MAX_NODES concepts): one force simulation over the
	//    type-filtered nodes, clustered by type — the original view.
	//  - tree  (larger vaults): concepts are grouped into clusters (their
	//    `part_of` root); only the cluster discs are simulated, each cluster lays
	//    its members out locally (once, cached) and draws as one bubble until it
	//    is big enough on screen and near the viewport centre to expand, within a
	//    hard budget of rendered nodes.
	// Both share the LOD pass (what is rendered, at what detail), the DOM pools
	// and the edge bundling ("ziptie"), which is computed once per settled
	// layout / render-set change and never per frame.
	import {
		forceCenter,
		forceCollide,
		forceLink,
		forceManyBody,
		forceSimulation,
		forceX,
		forceY,
		type Simulation,
		type SimulationLinkDatum,
		type SimulationNodeDatum,
	} from "d3-force";
	import type { ConceptTypeEntry, Edge, GraphNode, GraphPayload } from "@brainz/contracts";
	import {
		ALL_TYPES,
		adjacency,
		RELATION_COLORS,
		colorForRelation,
		colorForType,
		filterGraph,
		neighborhood,
		typeColorsFromRegistry,
	} from "$lib/graph-data";
	import {
		anchorStorageKey,
		applyAnchors,
		clearAnchorsFromNodes,
		deserializeAnchors,
		focusRevealSet,
		isDimmed,
		isEdgeDimmed,
		radiusForTypeDegree,
		registryView,
		serializeAnchors,
		setAnchor,
		typeClusterCenter,
		typesVisibleAtZoom,
		type AnchorMap,
		type FilterMode,
		type TypeRegistryView,
	} from "$lib/graph-view";
	import {
		DEFAULT_NODE_BUDGET,
		FLAT_MAX_NODES,
		allocateBudget,
		bubbleRadius,
		buildClusters,
		clusterFootprint,
		clusterLinks,
		expandScaleFor,
		expansionCandidates,
		fullDetailIds,
		labelCollideRadius,
		spiralSeed,
		truncateLabel,
		type ClusterGeom,
		type ClusterIndex,
	} from "$lib/graph-lod";
	import { buildBackbone, bundleEdges, straightPath, type Backbone, type BundleEnd, type BundleInput } from "$lib/graph-bundle";

	interface SimNode extends SimulationNodeDatum {
		id: string;
		data: GraphNode;
		r: number;
		/** collision radius (circle + label) */
		cr: number;
	}
	type SimLink = SimulationLinkDatum<SimNode> & { relation: string };
	/** A cluster disc in the tree layout's top-level simulation. */
	interface Unit extends SimulationNodeDatum {
		id: string;
		R: number;
		size: number;
	}
	type UnitLink = SimulationLinkDatum<Unit> & { weight: number };
	type P = { x: number; y: number };

	let {
		graph,
		enabledTypes,
		vaultId,
		registry = [],
		filterMode = "manual",
		focusId = null,
		selectedId = null,
		nodeBudget = DEFAULT_NODE_BUDGET,
		bundling = true,
		onselect,
		onlodchange,
	}: {
		graph: GraphPayload;
		enabledTypes: string[];
		vaultId: string;
		/** The vault's concept-type registry — drives palette colors, semantic-zoom
		 * LOD tiers, and node sizing from per-type WEIGHTS. Empty → built-in defaults. */
		registry?: readonly ConceptTypeEntry[];
		/** "auto" = LOD drives visible types from the zoom scale; "manual" = the
		 * `enabledTypes` chips do. Defaults to manual so nothing regresses if unset. */
		filterMode?: FilterMode;
		focusId?: string | null;
		selectedId?: string | null;
		/** Hard cap on individually rendered nodes in the clustered layout. */
		nodeBudget?: number;
		/** Route edges as bundles ("ziptie"); false = plain straight edges. */
		bundling?: boolean;
		onselect: (id: string) => void;
		/** Fired (auto mode only) when the zoom-driven visible-type set changes, so
		 * the parent can reflect which types the LOD is currently showing. */
		onlodchange?: (types: string[]) => void;
	} = $props();

	// Registry-derived views: `regView` feeds weight-based LOD ranks + node sizing;
	// `colors` maps type key → hex (custom types included). Recomputed only when the
	// registry prop changes. Empty registry → built-in defaults (backward compatible).
	const regView = $derived<TypeRegistryView | null>(
		registry.length > 0 ? registryView(registry as ConceptTypeEntry[]) : null,
	);
	const colors = $derived(typeColorsFromRegistry(registry as ConceptTypeEntry[]));
	/** Type keys the LOD/order logic should iterate (registry order, else palette). */
	const orderedTypes = $derived<readonly string[]>(regView ? [...regView.order, "pending"] : ALL_TYPES);

	const SVG_NS = "http://www.w3.org/2000/svg";
	/** Labels drawn in full for at most this many nodes (nearest the centre). */
	const LABEL_BUDGET = 160;
	/** Edge elements cap (nearest the centre / touching the selection win). */
	const EDGE_BUDGET = 1500;
	/** Render sets with at most this many individual nodes are bundled whole. */
	const WHOLE_BUNDLE_NODES = 120;
	/** An aggregated edge draws at most this many parallel strands. */
	const MAX_STRANDS = 5;
	// Keep off-screen nodes just outside the frame mounted so panning doesn't
	// pop them in at the very edge.
	const CULL_MARGIN = 60;
	/** Minimum ms between LOD passes while panning/zooming/ticking. */
	const LOD_THROTTLE_MS = 100;
	/** Time budget per LOD pass for computing new cluster layouts. */
	const LOCAL_MS_PER_PASS = 10;

	let svg: SVGSVGElement;
	let tooltip = $state({ text: "", x: 0, y: 0, visible: false });
	/** relations on screen → strand colour (the edge legend) */
	let legend = $state<Array<{ rel: string; color: string }>>([]);
	let empty = $state(false);

	// ------------------------------------------------------------ graph state
	let mode: "flat" | "tree" = "flat";
	let nodeById = new Map<string, GraphNode>();
	let adj = new Map<string, Set<string>>();
	let index: ClusterIndex = { clusters: new Map(), clusterOf: new Map() };
	let nodeR = new Map<string, number>(); // circle radius
	let nodeCR = new Map<string, number>(); // collision radius (circle + label)
	/** Concepts that pass the type filter / focus / reveal right now (may render individually). */
	let eligible = new Set<string>();
	let eligibleEdges: Edge[] = [];
	/** Concepts a cluster bubble counts: like `eligible`, but in auto mode every
	 * type counts (zooming in reveals them), so bubbles show their real size. */
	let clusterable = new Set<string>();
	let clusterableEdges: Edge[] = [];
	/** cluster id → clusterable member count */
	let clusterCount = new Map<string, number>();
	/** clusters with at least one eligible (type-visible) member */
	let hasEligible = new Set<string>();
	let builtFor: { graph: GraphPayload | null; registry: readonly ConceptTypeEntry[] | null } = { graph: null, registry: null };

	// flat layout
	const simNodes = new Map<string, SimNode>(); // positions survive re-renders
	let sim: Simulation<SimNode, SimLink> | null = null;
	let simNodeList: SimNode[] = [];

	// tree layout
	let units = new Map<string, Unit>();
	let topSim: Simulation<Unit, UnitLink> | null = null;
	/** cluster id → member id → position relative to the cluster centre (lazy, cached). */
	const local = new Map<string, Map<string, P>>();
	let fitted = false;

	let viewport: SVGGElement;
	let hullsG: SVGGElement;
	let edgesG: SVGGElement;
	let tiesG: SVGGElement;
	/** link-count labels on the backbone trunks (rebuilt with the bundles) */
	let trunkLabels: SVGTextElement[] = [];
	let nodesG: SVGGElement;
	let labelsG: SVGGElement;
	const view = { x: 0, y: 0, k: 1 };

	let hovered: string | null = null; // survives LOD passes so re-mounted nodes re-highlight
	// Sticky click-focus (distinct from transient hover): clicking a node dims all
	// non-neighbors and reveals its 1-hop neighbors across the type filter. Cleared
	// by clicking empty canvas, Escape, clicking the focused node again, or Reset.
	// `focusReveal` caches the reveal set so LOD/dim passes don't recompute it.
	let focused = $state<string | null>(null);
	let focusReveal = new Set<string>();

	// ------------------------------------------------------------ render state
	/** An edge endpoint: a rendered node, a cluster bubble, or a "ghost" — a
	 * concept with a known position whose element isn't mounted (off-screen). */
	type EndRef = { kind: "node" | "ghost" | "bubble"; id: string };
	interface RenderEdge {
		key: string;
		a: EndRef;
		b: EndRef;
		weight: number;
		/** relation for a single concept→concept edge; null when aggregated */
		relation: string | null;
		/** strand colour key: the relation, or an aggregate's most common one */
		rel: string;
		from: string;
		to: string;
	}
	interface Bubble {
		x: number;
		y: number;
		r: number;
		count: number;
		residual: boolean;
	}
	let rNodes = new Set<string>();
	let fullIds = new Set<string>();
	let rBubbles = new Map<string, Bubble>();
	let rHulls = new Map<string, number>(); // expanded cluster id → residual count
	let rEdges = new Map<string, RenderEdge>();
	/** members folded into a partially-expanded cluster's "+N" bubble */
	let residualOf = new Set<string>();
	let expanded = new Set<string>();
	/** clusters the user opened (click) → the zoom they were opened at */
	const manualOpen = new Map<string, number>();

	const nodeEls = new Map<string, SVGGElement>();
	const bubbleEls = new Map<string, SVGGElement>();
	const hullEls = new Map<string, SVGGElement>();
	const edgeEls = new Map<string, { el: SVGPathElement; label: SVGTextElement | null; edge: RenderEdge }>();
	let bundleDirty = true;
	/** aggregated edges for the last render set (see lodPass) */
	let edgeCache: { sig: string; list: RenderEdge[] } = { sig: "", list: [] };
	/** bumped whenever positions change (ticks, drags, relayout) */
	let posVersion = 0;
	/** zoom scale the current bundles were routed at (lane gaps are screen px) */
	let bundleK = 1;
	/** overview backbone (super-group hubs + trunks) for the posVersion it was built at */
	let backbone: Backbone | null = null;
	let backboneVersion = -1;
	/** routes for the whole render set (overview-sized sets; see draw) */
	let bundleCache: { key: string; paths: Map<string, string>; mids: Map<string, P> } | null = null;
	let dragging = false;

	// -------------------------------------------------------- semantic zoom LOD
	// In auto mode the visible-type set is DERIVED from the current zoom scale via
	// typesVisibleAtZoom (furthest out = domains only; zoom in unfolds lower-signal
	// tiers). `lodTypes` caches the last-emitted auto set for hysteresis (so a wiggle
	// at a tier boundary doesn't flicker) and to detect when a zoom crosses a tier
	// (which needs a re-render to add/remove nodes from the sim). In manual mode the
	// `enabledTypes` prop drives everything and LOD is dormant.
	let lodTypes = new Set<string>();
	/** The type set the sim/render should filter by right now. */
	function effectiveTypeSet(): Set<string> {
		return filterMode === "auto" ? lodTypes : new Set(enabledTypes);
	}
	/**
	 * Recompute the auto LOD set for the current zoom (with hysteresis off the last
	 * set). Returns true if the visible-type set CHANGED (a tier was crossed) — the
	 * caller re-renders only then, so plain panning/zooming within a tier is free.
	 * No-op (returns false) outside auto mode.
	 */
	function recomputeLod(): boolean {
		if (filterMode !== "auto") return false;
		const next = typesVisibleAtZoom(view.k, {
			prev: lodTypes,
			view: regView,
			types: orderedTypes,
		});
		const changed = next.size !== lodTypes.size || [...next].some((t) => !lodTypes.has(t));
		if (!changed) return false;
		lodTypes = next;
		onlodchange?.([...next]);
		return true;
	}

	// ------------------------------------------------------------ drag anchors
	// User-dropped nodes are pinned (fx/fy kept) and their position persisted per
	// vault in localStorage, restored on mount so the layout survives reloads.
	// Cluster discs anchor under their `@c:` unit id (never a concept slug).
	let anchors: AnchorMap = {};
	function loadAnchors(): AnchorMap {
		if (typeof localStorage === "undefined") return {};
		try {
			return deserializeAnchors(localStorage.getItem(anchorStorageKey(vaultId)));
		} catch {
			return {};
		}
	}
	function saveAnchors(): void {
		if (typeof localStorage === "undefined") return;
		try {
			localStorage.setItem(anchorStorageKey(vaultId), serializeAnchors(anchors));
		} catch {
			/* storage full/disabled — in-memory anchors still hold for this session */
		}
	}

	// Settled cluster positions are cached per vault so a reload re-opens on the
	// same map with a short, gentle settle instead of a full relayout.
	const layoutKey = (): string => `brainz:graph-layout:${vaultId}`;
	function loadLayout(): Record<string, [number, number]> {
		if (typeof localStorage === "undefined") return {};
		try {
			const raw = JSON.parse(localStorage.getItem(layoutKey()) ?? "{}");
			return raw && typeof raw === "object" && raw.units && typeof raw.units === "object" ? raw.units : {};
		} catch {
			return {};
		}
	}
	function saveLayout(): void {
		if (typeof localStorage === "undefined") return;
		const out: Record<string, [number, number]> = {};
		for (const u of units.values()) out[u.id] = [Math.round(u.x ?? 0), Math.round(u.y ?? 0)];
		try {
			localStorage.setItem(layoutKey(), JSON.stringify({ units: out }));
		} catch {
			/* ignore storage errors */
		}
	}

	function applyView(): void {
		viewport.setAttribute("transform", `translate(${view.x},${view.y}) scale(${view.k})`);
		svg.classList.toggle("labels-hidden", view.k < 0.45);
		scheduleLod();
	}

	// ------------------------------------------------------------ scheduling
	// Pan/zoom and sim ticks both want a fresh LOD pass, but running one on every
	// raw event thrashes: passes are throttled (leading + trailing) to one per
	// LOD_THROTTLE_MS, and position-only redraws are coalesced to one per frame.
	// Each schedule cancels any stale handle (a backgrounded tab pauses rAF — a
	// dropped frame must not wedge scheduling forever).
	let lodRaf = 0;
	let lodTimer: ReturnType<typeof setTimeout> | null = null;
	let lastLod = 0;
	function scheduleLod(): void {
		if (lodTimer) return;
		const wait = Math.max(0, lastLod + LOD_THROTTLE_MS - performance.now());
		lodTimer = setTimeout(() => {
			lodTimer = null;
			if (lodRaf) cancelAnimationFrame(lodRaf);
			lodRaf = requestAnimationFrame(() => {
				lodRaf = 0;
				lastLod = performance.now();
				lodPass();
			});
		}, wait);
	}
	let drawRaf = 0;
	function scheduleDraw(): void {
		if (drawRaf) cancelAnimationFrame(drawRaf);
		drawRaf = requestAnimationFrame(() => {
			drawRaf = 0;
			draw();
		});
	}

	const toGraphCoords = (cx: number, cy: number): [number, number] => {
		const rect = svg.getBoundingClientRect();
		return [(cx - rect.left - view.x) / view.k, (cy - rect.top - view.y) / view.k];
	};

	const layoutHot = (): boolean =>
		dragging ||
		(mode === "flat" ? (sim?.alpha() ?? 0) > (sim?.alphaMin() ?? 0) : (topSim?.alpha() ?? 0) > (topSim?.alphaMin() ?? 0));

	// ------------------------------------------------------------ data
	/** (Re)index the graph: lookups, radii, clusters and the layout mode. */
	function rebuild(): void {
		nodeById = new Map(graph.nodes.map((n) => [n.id, n]));
		adj = adjacency(graph.edges);
		nodeR = new Map();
		nodeCR = new Map();
		for (const n of graph.nodes) {
			const r = radiusForTypeDegree(n.type, n.degree, regView);
			nodeR.set(n.id, r);
			nodeCR.set(n.id, labelCollideRadius(n.title, r));
		}
		index = buildClusters(graph.nodes, graph.edges);
		const nextMode = graph.nodes.length > FLAT_MAX_NODES ? "tree" : "flat";
		if (nextMode !== mode) fitted = false;
		mode = nextMode;
		local.clear();
		builtFor = { graph, registry };
	}

	/** Recompute which concepts/edges pass the type filter, focus and reveal. */
	function refilter(): void {
		const focus = focusId ? neighborhood(graph.edges, focusId, 2) : null;
		// LOD (auto) or the chips (manual) decide the ELIGIBLE type set; the LOD pass
		// then picks which of those eligible nodes are actually in the DOM.
		const filtered = filterGraph(graph, { types: effectiveTypeSet(), focus });
		eligible = new Set(filtered.nodes.map((n) => n.id));
		// Sticky click-focus reveals the focused node's 1-hop neighbors even if
		// their type is toggled off — union those revealed nodes back in.
		let extra = false;
		for (const id of focusReveal) {
			if (nodeById.has(id) && !eligible.has(id)) {
				eligible.add(id);
				extra = true;
			}
		}
		eligibleEdges = extra ? graph.edges.filter((e) => eligible.has(e.from) && eligible.has(e.to)) : filtered.edges;
		if (filterMode === "auto") {
			const all = filterGraph(graph, { focus });
			clusterable = new Set(all.nodes.map((n) => n.id));
			for (const id of eligible) clusterable.add(id);
			clusterableEdges = graph.edges.filter((e) => clusterable.has(e.from) && clusterable.has(e.to));
		} else {
			clusterable = eligible;
			clusterableEdges = eligibleEdges;
		}
		empty = (mode === "tree" ? clusterable : eligible).size === 0;
		clusterCount = new Map();
		hasEligible = new Set();
		for (const id of eligible) {
			const c = index.clusterOf.get(id);
			if (c) hasEligible.add(c);
		}
		for (const id of clusterable) {
			const c = index.clusterOf.get(id);
			if (c) clusterCount.set(c, (clusterCount.get(c) ?? 0) + 1);
		}
	}

	/** Full re-render: re-index if the data changed, refilter, (re)build the layout. */
	function renderGraph(gentle = false): void {
		if (builtFor.graph !== graph || builtFor.registry !== registry) rebuild();
		refilter();
		// Drop hover state that references now-gone nodes.
		if (hovered && !nodeById.has(hovered)) hovered = null;
		// Drop sticky focus if its node vanished from the data (e.g. deleted).
		if (focused && !nodeById.has(focused)) {
			focused = null;
			focusReveal = new Set();
		}
		anchors = loadAnchors();
		if (mode === "flat") buildFlat(gentle);
		else buildTree();
		clearDom();
		lodPass();
	}

	function clearDom(): void {
		posVersion++;
		for (const g of [hullsG, edgesG, tiesG, nodesG, labelsG]) g.innerHTML = "";
		trunkLabels = [];
		nodeEls.clear();
		bubbleEls.clear();
		hullEls.clear();
		edgeEls.clear();
		rNodes = new Set();
		rBubbles = new Map();
		rHulls = new Map();
		rEdges = new Map();
		bundleDirty = true;
	}

	// ------------------------------------------------------------ flat layout
	/**
	 * (Re)build the flat sim over the currently-visible (LOD/manual-filtered) set.
	 * `gentle` = a soft reheat (low alpha) used when a zoom tier crossing adds or
	 * removes a few nodes: kept nodes hold their positions and the layout eases to
	 * a new settle instead of the jarring full relayout a fresh load / Reset does.
	 */
	function buildFlat(gentle: boolean): void {
		topSim?.stop();
		topSim = null;
		units = new Map();
		// Cluster ordering (index → angle around the canvas): registry order when
		// present, else the built-in palette. Mutable copy for typeClusterCenter.
		const clusterOrder: string[] = [...orderedTypes];
		const width = svg.clientWidth || 900;
		const height = svg.clientHeight || 600;

		// New nodes entering on a tier crossing: seed them near the canvas center
		// (with a tiny jitter) so they ease in from the middle rather than flying
		// in from (0,0). Kept nodes already carry their settled positions.
		const nodeList: SimNode[] = [];
		for (const id of eligible) {
			const n = nodeById.get(id)!;
			const r = nodeR.get(id)!;
			let sn = simNodes.get(id);
			if (!sn) {
				sn = { id, data: n, r, cr: nodeCR.get(id)! };
				if (gentle) {
					sn.x = width / 2 + (Math.random() - 0.5) * 40;
					sn.y = height / 2 + (Math.random() - 0.5) * 40;
				}
				simNodes.set(id, sn);
			}
			sn.data = n;
			sn.r = r;
			sn.cr = nodeCR.get(id)!;
			nodeList.push(sn);
		}
		const links: SimLink[] = eligibleEdges.map((e) => ({ source: e.from, target: e.to, relation: e.relation }));

		// Restore saved anchors: pin dropped nodes to their remembered spots so the
		// free nodes lay out around them. Runs before the sim starts.
		applyAnchors(nodeList, anchors);

		sim?.stop();
		simNodeList = nodeList;
		// Layout tuning for visible separation without jitter or blow-up:
		//  - link distance 170, charge -800: edges hold nodes well apart and the
		//    repulsion opens clusters up (room for bundled edges between them).
		//  - collide sized to circle AND label (labelCollideRadius), strength 0.9,
		//    2 iterations: neither circles nor labels overlap at the default zoom.
		// Centering/x-y gravity kept gentle so small graphs don't collapse or fly.
		sim = forceSimulation<SimNode, SimLink>(nodeList)
			.force(
				"link",
				forceLink<SimNode, SimLink>(links)
					.id((d) => d.id)
					.distance(170)
					.strength(0.35),
			)
			.force("charge", forceManyBody().strength(-800).distanceMax(1000))
			.force("center", forceCenter(width / 2, height / 2).strength(0.02))
			// Type clustering: each node is pulled toward its concept type's cluster
			// center (types spread around a circle), so same-type nodes form discrete
			// clouds. Cross-type edges (the link force) pull two clouds to overlap
			// Venn-style — the more connections, the more they merge.
			.force("x", forceX<SimNode>((d) => typeClusterCenter(d.data.type, clusterOrder, width, height).x).strength(0.07))
			.force("y", forceY<SimNode>((d) => typeClusterCenter(d.data.type, clusterOrder, width, height).y).strength(0.07))
			.force(
				"collide",
				forceCollide<SimNode>()
					.radius((d) => d.cr)
					.strength(0.9)
					.iterations(2),
			)
			// Gentle reheat on a tier crossing so anchored/settled nodes barely move;
			// full reheat on a fresh load / Reset.
			.alpha(gentle ? 0.3 : 0.9)
			.alphaDecay(0.035)
			.on("tick", onTick)
			.on("end", onSettled);
	}

	// ------------------------------------------------------------ tree layout
	/** Build (or refresh) the top-level cluster simulation. */
	function buildTree(): void {
		sim?.stop();
		sim = null;
		simNodeList = [];
		const cached = loadLayout();
		const prev = units;
		const list = [...index.clusters.values()];
		const radii = list.map((c) => clusterFootprint(c.members.map((m) => nodeCR.get(m) ?? 20)));
		const seeds = spiralSeed(radii);
		let fresh = 0;
		const next = new Map<string, Unit>();
		list.forEach((c, i) => {
			const old = prev.get(c.id);
			const hit = cached[c.id];
			const u: Unit = { id: c.id, R: radii[i]!, size: c.members.length };
			if (old) {
				u.x = old.x;
				u.y = old.y;
			} else if (hit) {
				u.x = hit[0];
				u.y = hit[1];
			} else {
				u.x = seeds[i]!.x;
				u.y = seeds[i]!.y;
				fresh++;
			}
			next.set(c.id, u);
		});
		units = next;
		const unitList = [...units.values()];
		applyAnchors(unitList, anchors);
		const links: UnitLink[] = clusterLinks(index, graph.edges).map((l) => ({ source: l.a, target: l.b, weight: l.weight }));
		topSim?.stop();
		// Discs never overlap (collide = footprint + a gap wide enough for cable
		// runs to pass between them), linked clusters attract
		// in proportion to how many edges join them, mild repulsion spreads the map.
		topSim = forceSimulation<Unit, UnitLink>(unitList)
			.force(
				"link",
				forceLink<Unit, UnitLink>(links)
					.id((d) => d.id)
					.distance((l) => (l.source as Unit).R + (l.target as Unit).R + 180)
					.strength((l) => Math.min(0.5, 0.03 + 0.025 * Math.sqrt(l.weight))),
			)
			.force("charge", forceManyBody<Unit>().strength((d) => -40 * Math.sqrt(d.size)).distanceMax(3000))
			.force("x", forceX<Unit>(0).strength(0.03))
			.force("y", forceY<Unit>(0).strength(0.03))
			.force(
				"collide",
				forceCollide<Unit>()
					.radius((d) => d.R + 80)
					.strength(1)
					.iterations(3),
			)
			// A map restored from the cache only needs a short, gentle settle.
			.alpha(fresh > unitList.length / 2 ? 1 : 0.15)
			.alphaDecay(0.03)
			.stop();
		// Settle synchronously: a few hundred discs settle in a few ms, so the map
		// opens already laid out (no animated relayout frames). Only a disc drag
		// reheats it live, via the tick/end handlers.
		for (let i = 0; i < 400 && topSim.alpha() > topSim.alphaMin(); i++) topSim.tick();
		topSim.alpha(0);
		backboneVersion = -1;
		topSim.on("tick", onTick).on("end", () => {
			saveLayout();
			onSettled();
		});
		if (fresh > 0) saveLayout();
		if (!fitted) fitView(unitList);
	}

	/** Fit the whole cluster map in the viewport (first open of a large vault). */
	function fitView(list: Unit[]): void {
		if (list.length === 0) return;
		let [x0, y0, x1, y1] = [Infinity, Infinity, -Infinity, -Infinity];
		for (const u of list) {
			x0 = Math.min(x0, (u.x ?? 0) - u.R);
			y0 = Math.min(y0, (u.y ?? 0) - u.R);
			x1 = Math.max(x1, (u.x ?? 0) + u.R);
			y1 = Math.max(y1, (u.y ?? 0) + u.R);
		}
		const w = svg.clientWidth || 900;
		const h = svg.clientHeight || 600;
		const k = Math.min(1, Math.max(0.12, Math.min(w / (x1 - x0), h / (y1 - y0)) * 0.95));
		view.k = k;
		view.x = w / 2 - ((x0 + x1) / 2) * k;
		view.y = h / 2 - ((y0 + y1) / 2) * k;
		fitted = true;
		recomputeLod();
		refilter();
		applyView();
	}

	/**
	 * A cluster's member layout, relative to its centre: computed once on first
	 * need (expansion, a jump to a hidden member) with a short static d3 run over
	 * ALL its members (every type — so type filters never re-layout), then cached.
	 */
	function ensureLocal(cid: string): Map<string, P> {
		let pos = local.get(cid);
		if (pos) return pos;
		const c = index.clusters.get(cid)!;
		const u = units.get(cid);
		const R = u?.R ?? 200;
		pos = new Map();
		if (c.members.length === 1) {
			pos.set(c.members[0]!, { x: 0, y: 0 });
			local.set(cid, pos);
			return pos;
		}
		const memberSet = new Set(c.members);
		const golden = Math.PI * (3 - Math.sqrt(5));
		// Hubs first so they seed near the middle; the head sits at the centre.
		const ordered = [...c.members].sort(
			(a, b) => (a === c.head ? -1 : b === c.head ? 1 : (nodeById.get(b)?.degree ?? 0) - (nodeById.get(a)?.degree ?? 0)),
		);
		const nodes: SimNode[] = ordered.map((id, i) => {
			const d = Math.sqrt(i / ordered.length) * R * 0.8;
			const sn: SimNode = { id, data: nodeById.get(id)!, r: nodeR.get(id)!, cr: nodeCR.get(id)!, x: Math.cos(i * golden) * d, y: Math.sin(i * golden) * d };
			const a = anchors[id];
			if (id === c.head) {
				sn.fx = 0;
				sn.fy = 0;
			} else if (a && u) {
				sn.fx = a.x - (u.x ?? 0);
				sn.fy = a.y - (u.y ?? 0);
			}
			return sn;
		});
		const links: SimLink[] = graph.edges
			.filter((e) => memberSet.has(e.from) && memberSet.has(e.to) && e.from !== e.to)
			.map((e) => ({ source: e.from, target: e.to, relation: e.relation }));
		const contain = (alpha: number): void => {
			for (const n of nodes) {
				const d = Math.hypot(n.x ?? 0, n.y ?? 0);
				const lim = R - n.cr;
				if (d > lim && d > 0) {
					const s = ((d - lim) / d) * alpha;
					n.vx = (n.vx ?? 0) - (n.x ?? 0) * s;
					n.vy = (n.vy ?? 0) - (n.y ?? 0) * s;
				}
			}
		};
		const s = forceSimulation<SimNode, SimLink>(nodes)
			.force("link", forceLink<SimNode, SimLink>(links).id((d) => d.id).distance(110).strength(0.25))
			.force("charge", forceManyBody().strength(-300).distanceMax(500))
			.force("collide", forceCollide<SimNode>().radius((d) => d.cr).strength(0.9).iterations(2))
			.force("x", forceX(0).strength(0.03))
			.force("y", forceY(0).strength(0.03))
			.force("contain", contain)
			.stop();
		const ticks = nodes.length > 200 ? 90 : 150;
		for (let i = 0; i < ticks; i++) s.tick();
		for (const n of nodes) pos.set(n.id, { x: n.x ?? 0, y: n.y ?? 0 });
		local.set(cid, pos);
		return pos;
	}

	/** A concept's current position in graph coords (null when unknown). */
	function posOf(id: string): P | null {
		if (mode === "flat") {
			const sn = simNodes.get(id);
			return sn ? { x: sn.x ?? 0, y: sn.y ?? 0 } : null;
		}
		const cid = index.clusterOf.get(id);
		const u = cid ? units.get(cid) : undefined;
		if (!cid || !u) return null;
		const p = ensureLocal(cid).get(id);
		return p ? { x: (u.x ?? 0) + p.x, y: (u.y ?? 0) + p.y } : null;
	}

	// ------------------------------------------------------------ LOD pass
	/**
	 * Decide what is rendered and at what detail for the current view, then
	 * reconcile the DOM to it. Runs throttled on pan/zoom, on sim ticks, and on
	 * selection / filter / focus changes.
	 *  - Forced: the selected node, its neighbours and the focus reveal set always
	 *    render individually.
	 *  - flat: every eligible node inside the (margined) viewport renders.
	 *  - tree: clusters compete for the node budget (expansionCandidates →
	 *    allocateBudget); the rest draw as bubbles; a partially-opened cluster
	 *    folds its leftovers into a "+N" bubble.
	 *  - Edges map their endpoints to whatever represents them (node, bubble or
	 *    an off-screen ghost) and aggregate duplicates with a weight.
	 */
	function lodPass(): void {
		if (!nodesG) return;
		const t0 = performance.now();
		const width = svg.clientWidth || 900;
		const height = svg.clientHeight || 600;
		const vs = { ...view, width, height };
		const toS = (p: P): P => ({ x: p.x * view.k + view.x, y: p.y * view.k + view.y });
		const onScreen = (p: P, r: number, m = CULL_MARGIN): boolean => {
			const s = toS(p);
			const rad = r * view.k + m;
			return s.x + rad >= 0 && s.x - rad <= width && s.y + rad >= 0 && s.y - rad <= height;
		};

		const forced = new Set<string>();
		if (selectedId && eligible.has(selectedId)) {
			forced.add(selectedId);
			for (const n of adj.get(selectedId) ?? []) if (eligible.has(n)) forced.add(n);
		}
		for (const id of focusReveal) if (eligible.has(id)) forced.add(id);

		const nodes = new Set<string>(forced);
		const bubbles = new Map<string, Bubble>();
		const hulls = new Map<string, number>();
		const residual = new Set<string>();
		const nextExpanded = new Set<string>();

		if (mode === "flat") {
			for (const sn of simNodeList) {
				if (onScreen({ x: sn.x ?? 0, y: sn.y ?? 0 }, sn.r)) nodes.add(sn.id);
			}
		} else {
			const geoms: ClusterGeom[] = [];
			for (const [cid, n] of clusterCount) {
				const u = units.get(cid);
				if (u && n > 0) geoms.push({ id: cid, x: u.x ?? 0, y: u.y ?? 0, R: u.R, size: u.size });
			}
			// New local layouts cost a few ms each: cap them per pass so a big zoom
			// never janks — clusters over the cap stay bubbles until the next pass.
			let deferred = false;
			// A clicked-open cluster lapses once the user zooms well back out.
			// (Not mid-animation: the jump that opened it starts zoomed out.)
			if (!animating) for (const [id, k] of manualOpen) if (view.k < k * 0.6) manualOpen.delete(id);
			const cands = expansionCandidates(geoms, vs, expanded, new Set(manualOpen.keys())).filter((c) => {
				if (local.has(c.id) || performance.now() - t0 < LOCAL_MS_PER_PASS) return true;
				deferred = true;
				return false;
			});
			if (deferred) scheduleLod();
			// For each candidate: its eligible, on-screen, not-forced members, nearest first.
			const inView = new Map<string, string[]>();
			const counts = new Map<string, number>();
			const cx = width / 2;
			const cy = height / 2;
			for (const cand of cands) {
				const c = index.clusters.get(cand.id)!;
				const list: Array<{ id: string; d: number }> = [];
				for (const m of c.members) {
					if (!eligible.has(m) || forced.has(m)) continue;
					const p = posOf(m)!;
					if (!onScreen(p, nodeR.get(m)!)) continue;
					const s = toS(p);
					list.push({ id: m, d: Math.hypot(s.x - cx, s.y - cy) });
				}
				list.sort((a, b) => a.d - b.d);
				inView.set(cand.id, list.map((x) => x.id));
				counts.set(cand.id, list.length);
			}
			const alloc = allocateBudget(cands, counts, nodeBudget - forced.size);
			for (const [cid, n] of clusterCount) {
				const u = units.get(cid)!;
				const centre = { x: u.x ?? 0, y: u.y ?? 0 };
				// A cluster whose members are all hidden by the type LOD stays a bubble.
				const allowed = hasEligible.has(cid) ? alloc.get(cid) : undefined;
				if (u.size === 1) {
					const only = index.clusters.get(cid)!.members[0]!;
					if (allowed && eligible.has(only)) nodes.add(only);
					continue;
				}
				if (allowed === undefined) {
					// Collapsed: one bubble (members not forced out are folded into it).
					bubbles.set(cid, { ...centre, r: bubbleRadius(u.R), count: n, residual: false });
					continue;
				}
				nextExpanded.add(cid);
				const list = inView.get(cid) ?? [];
				for (let i = 0; i < list.length; i++) {
					if (i < allowed) nodes.add(list[i]!);
					else residual.add(list[i]!);
				}
				const left = list.length - allowed;
				hulls.set(cid, Math.max(0, left));
				if (left > 0) {
					bubbles.set(cid, { x: centre.x, y: centre.y - u.R, r: Math.max(16, bubbleRadius(u.R) * 0.5), count: left, residual: true });
				}
			}
			if (!animating) for (const id of manualOpen.keys()) if (!nextExpanded.has(id)) manualOpen.delete(id);
		}

		// --- edges: endpoints → representative, aggregated by rep pair.
		const repOf = (id: string): EndRef | null => {
			if (nodes.has(id)) return { kind: "node", id };
			if (mode === "tree") {
				const cid = index.clusterOf.get(id)!;
				// Folded into a "+N" bubble, or inside a collapsed cluster's bubble.
				if (residual.has(id) || (!nextExpanded.has(cid) && bubbles.has(cid))) return { kind: "bubble", id: cid };
			}
			// Off-screen (known position) — unless the type LOD hides it outright.
			return eligible.has(id) ? { kind: "ghost", id } : null;
		};
		const endPos = (r: EndRef): P | null => (r.kind === "bubble" ? bubbles.get(r.id) ?? null : posOf(r.id));
		// Map every edge to its endpoints' representatives and aggregate — only
		// when the render set changed (panning within it reuses the list, so a pass
		// costs O(rendered edges), not O(vault edges)).
		const sig = `${[...nodes].join(",")}#${[...bubbles.keys()].join(",")}#${[...residual].join(",")}#${eligibleEdges.length}#${clusterableEdges.length}`;
		if (sig !== edgeCache.sig) {
			const all = new Map<string, RenderEdge>();
			const relCounts = new Map<string, Map<string, number>>();
			for (const e of mode === "tree" ? clusterableEdges : eligibleEdges) {
				const a = repOf(e.from);
				const b = repOf(e.to);
				if (!a || !b) continue;
				if (a.kind === "ghost" && b.kind === "ghost") continue;
				if (a.kind === b.kind && a.id === b.id) continue;
				const single = a.kind !== "bubble" && b.kind !== "bubble";
				if (single) {
					const key = `${e.from}|${e.relation}|${e.to}`;
					all.set(key, { key, a, b, weight: 1, relation: e.relation, rel: e.relation, from: e.from, to: e.to });
				} else {
					const ka = `${a.kind}:${a.id}`;
					const kb = `${b.kind}:${b.id}`;
					const key = ka < kb ? `~${ka}|${kb}` : `~${kb}|${ka}`;
					const agg = all.get(key);
					if (agg) agg.weight++;
					else all.set(key, { key, a, b, weight: 1, relation: null, rel: e.relation, from: e.from, to: e.to });
					let rc = relCounts.get(key);
					if (!rc) relCounts.set(key, (rc = new Map()));
					rc.set(e.relation, (rc.get(e.relation) ?? 0) + 1);
				}
			}
			for (const [key, rc] of relCounts) {
				let best = "";
				let bn = 0;
				for (const [r, n] of rc) if (n > bn || (n === bn && r < best)) [best, bn] = [r, n];
				all.get(key)!.rel = best;
			}
			edgeCache = { sig, list: [...all.values()] };
		}
		// At least one drawn end must be on screen.
		const vis = (r: EndRef): boolean => {
			if (r.kind === "ghost") return false;
			const p = endPos(r);
			return p !== null && onScreen(p, r.kind === "bubble" ? bubbles.get(r.id)!.r : nodeR.get(r.id)!);
		};
		const edges = new Map<string, RenderEdge>();
		for (const e of edgeCache.list) if (vis(e.a) || vis(e.b)) edges.set(e.key, e);
		// Edge budget: keep edges touching the selection, then those nearest the centre.
		if (edges.size > EDGE_BUDGET) {
			const cx = width / 2;
			const cy = height / 2;
			const scored = [...edges.values()].map((e) => {
				const pa = endPos(e.a) ?? { x: 0, y: 0 };
				const pb = endPos(e.b) ?? { x: 0, y: 0 };
				const m = toS({ x: (pa.x + pb.x) / 2, y: (pa.y + pb.y) / 2 });
				const sel = forced.has(e.from) && forced.has(e.to) ? -1e9 : 0;
				return { e, s: sel + Math.hypot(m.x - cx, m.y - cy) };
			});
			scored.sort((x, y) => x.s - y.s);
			edges.clear();
			for (const { e } of scored.slice(0, EDGE_BUDGET)) edges.set(e.key, e);
		}

		// --- detail tiers: labels + glow for the nodes nearest the centre.
		const always = new Set<string>(forced);
		if (hovered) always.add(hovered);
		const pts: Array<{ id: string; sx: number; sy: number }> = [];
		for (const id of nodes) {
			const p = posOf(id);
			if (!p) continue;
			const s = toS(p);
			pts.push({ id, sx: s.x, sy: s.y });
		}
		fullIds = nodes.size <= LABEL_BUDGET ? new Set(nodes) : fullDetailIds(pts, vs, LABEL_BUDGET, always);

		expanded = nextExpanded;
		residualOf = residual;
		// Strand gaps and weight labels are sized in screen px: re-route only when
		// the zoom drifted noticeably since the last bundling (not per frame).
		if (Math.abs(Math.log(view.k / bundleK)) > Math.log(1.4)) bundleDirty = true;
		reconcile(nodes, bubbles, hulls, edges);
		svg.dataset["mode"] = mode;
		svg.dataset["rendered"] = String(nodeEls.size);
		svg.dataset["bubbles"] = String(bubbleEls.size);
		svg.dataset["expanded"] = [...expanded].sort().join(",");
		svg.dataset["edges"] = String(edgeEls.size);
		draw();
		svg.dataset["lodMs"] = (performance.now() - t0).toFixed(1);
		if (mode === "tree") schedulePrefetch();
	}

	// Idle-time prefetch: lay out the clusters nearest the viewport centre ahead
	// of need (one per idle slot), so zooming in rarely waits on ensureLocal.
	let prefetchHandle = 0;
	function schedulePrefetch(): void {
		if (prefetchHandle) return;
		const idle = (cb: () => void): number =>
			typeof requestIdleCallback === "function" ? requestIdleCallback(cb, { timeout: 500 }) : (setTimeout(cb, 50) as unknown as number);
		prefetchHandle = idle(() => {
			prefetchHandle = 0;
			if (mode !== "tree" || layoutHot()) return;
			const w = svg.clientWidth || 900;
			const h = svg.clientHeight || 600;
			let best: Unit | null = null;
			let bestD = Infinity;
			for (const u of units.values()) {
				if (u.size < 2 || local.has(u.id)) continue;
				const sx = (u.x ?? 0) * view.k + view.x - w / 2;
				const sy = (u.y ?? 0) * view.k + view.y - h / 2;
				const d = Math.hypot(sx, sy) - u.R * view.k;
				if (d < bestD) {
					bestD = d;
					best = u;
				}
			}
			// Only what could open soon: within a screen of the viewport.
			if (!best || bestD > Math.max(w, h)) return;
			ensureLocal(best.id);
			schedulePrefetch();
		});
	}

	// ------------------------------------------------------------ DOM pools
	function reconcile(nodes: Set<string>, bubbles: Map<string, Bubble>, hulls: Map<string, number>, edges: Map<string, RenderEdge>): void {
		let changed = false;
		// nodes
		for (const [id, el] of nodeEls) {
			if (!nodes.has(id)) {
				el.remove();
				nodeEls.delete(id);
				changed = true;
			}
		}
		for (const id of nodes) {
			let el = nodeEls.get(id);
			if (!el) {
				el = makeNodeEl(id);
				nodesG.append(el);
				nodeEls.set(id, el);
				changed = true;
			}
			el.classList.toggle("far", !fullIds.has(id));
		}
		// bubbles
		for (const [cid, el] of bubbleEls) {
			const b = bubbles.get(cid);
			if (!b || b.residual !== el.classList.contains("residual")) {
				el.remove();
				bubbleEls.delete(cid);
				changed = true;
			}
		}
		for (const [cid, b] of bubbles) {
			let el = bubbleEls.get(cid);
			if (!el) {
				el = makeBubbleEl(cid, b);
				nodesG.prepend(el);
				bubbleEls.set(cid, el);
				changed = true;
			}
			const prevCount = el.dataset["count"];
			if (prevCount !== String(b.count)) {
				el.dataset["count"] = String(b.count);
				const t = el.querySelector("text.count");
				if (t) t.textContent = b.residual ? `+${b.count}` : String(b.count);
				const title = el.querySelector("title");
				const c = index.clusters.get(cid)!;
				if (title) title.textContent = b.residual ? `${b.count} more in ${c.title} — zoom in` : `${c.title}: ${b.count} concepts — click to expand`;
			}
		}
		// hulls
		for (const [cid, el] of hullEls) {
			if (!hulls.has(cid)) {
				el.remove();
				hullEls.delete(cid);
			}
		}
		for (const cid of hulls.keys()) {
			if (!hullEls.has(cid)) {
				const el = makeHullEl(cid);
				hullsG.append(el);
				hullEls.set(cid, el);
			}
		}
		// edges
		for (const [key, entry] of edgeEls) {
			const next = edges.get(key);
			if (!next) {
				entry.el.remove();
				entry.label?.remove();
				edgeEls.delete(key);
				changed = true;
			} else if (next.weight !== entry.edge.weight || next.rel !== entry.edge.rel || next.a.kind !== entry.edge.a.kind || next.b.kind !== entry.edge.b.kind) {
				if (next.rel !== entry.edge.rel) entry.el.style.setProperty("--ec", colorForRelation(next.rel));
				entry.edge = next;
				if (entry.label) {
					entry.label.textContent = String(next.weight);
					entry.label.style.display = next.weight >= 2 ? "" : "none";
				}
				changed = true;
			}
		}
		for (const [key, e] of edges) {
			if (edgeEls.has(key)) continue;
			const el = makeEdgeEl(e);
			edgesG.append(el);
			let label: SVGTextElement | null = null;
			if (e.relation === null) {
				label = document.createElementNS(SVG_NS, "text");
				label.classList.add("weight");
				label.textContent = String(e.weight);
				// Weight shown from 2 links up (a lone link reads as a plain strand).
				label.style.display = e.weight >= 2 ? "" : "none";
				labelsG.append(label);
			}
			edgeEls.set(key, { el, label, edge: e });
			changed = true;
		}
		rNodes = nodes;
		rBubbles = bubbles;
		rHulls = hulls;
		rEdges = edges;
		if (changed) {
			bundleDirty = true;
			updateLegend();
		}
		reapplyHover();
		reapplyFocus();
		reapplySelected();
	}

	// ------------------------------------------------------------ node/edge factories
	function makeNodeEl(id: string): SVGGElement {
		const n = nodeById.get(id)!;
		const r = nodeR.get(id)!;
		const g = document.createElementNS(SVG_NS, "g");
		g.classList.add("node");
		if (n.pending) g.classList.add("pending");
		if (id === selectedId) g.classList.add("selected");
		if (anchors[id]) g.classList.add("pinned");
		g.dataset["id"] = id;

		// Soft halo: a larger translucent disc behind the mark — the Obsidian glow
		// without a per-node SVG filter (filters made every pan frame re-raster).
		const halo = document.createElementNS(SVG_NS, "circle");
		halo.classList.add("halo");
		halo.setAttribute("r", String(r + 3.5));
		halo.setAttribute("fill", colorForType(n.type, colors));

		const circle = document.createElementNS(SVG_NS, "circle");
		circle.classList.add("mark");
		circle.setAttribute("r", String(r));
		circle.setAttribute("fill", colorForType(n.type, colors));

		const label = document.createElementNS(SVG_NS, "text");
		label.textContent = truncateLabel(n.title);
		label.setAttribute("dy", String(r + 13));

		const title = document.createElementNS(SVG_NS, "title");
		title.textContent = `${n.title} (${n.type}${n.pending ? ", pending" : ""})`;

		g.append(halo, circle, label, title);
		attachNodeEvents(g, id);
		return g;
	}

	function makeBubbleEl(cid: string, b: Bubble): SVGGElement {
		const c = index.clusters.get(cid)!;
		const g = document.createElementNS(SVG_NS, "g");
		g.classList.add("cluster");
		if (b.residual) g.classList.add("residual");
		g.dataset["cluster"] = cid;
		g.dataset["count"] = String(b.count);
		const color = colorForType(c.type, colors);
		const circle = document.createElementNS(SVG_NS, "circle");
		circle.setAttribute("r", String(b.r));
		circle.setAttribute("fill", color);
		circle.setAttribute("stroke", color);
		const count = document.createElementNS(SVG_NS, "text");
		count.classList.add("count");
		count.textContent = b.residual ? `+${b.count}` : String(b.count);
		count.setAttribute("font-size", String(Math.max(10, b.r * 0.55)));
		count.setAttribute("dy", "0.35em");
		g.append(circle, count);
		if (!b.residual) {
			const label = document.createElementNS(SVG_NS, "text");
			label.classList.add("ctitle");
			label.textContent = truncateLabel(c.title);
			label.setAttribute("font-size", String(Math.max(11, b.r * 0.42)));
			label.setAttribute("dy", String(b.r + Math.max(11, b.r * 0.42) + 4));
			g.append(label);
		}
		const title = document.createElementNS(SVG_NS, "title");
		title.textContent = b.residual ? `${b.count} more in ${c.title} — zoom in` : `${c.title}: ${b.count} concepts — click to expand`;
		g.append(title);
		attachBubbleEvents(g, cid);
		return g;
	}

	function makeHullEl(cid: string): SVGGElement {
		const c = index.clusters.get(cid)!;
		const u = units.get(cid)!;
		const g = document.createElementNS(SVG_NS, "g");
		g.classList.add("hull");
		g.dataset["cluster"] = cid;
		const circle = document.createElementNS(SVG_NS, "circle");
		circle.setAttribute("r", String(u.R));
		circle.setAttribute("stroke", colorForType(c.type, colors));
		const label = document.createElementNS(SVG_NS, "text");
		label.textContent = truncateLabel(c.title);
		label.setAttribute("font-size", String(Math.max(12, u.R * 0.035)));
		label.setAttribute("y", String(-u.R - 8));
		g.append(circle, label);
		return g;
	}

	function makeEdgeEl(e: RenderEdge): SVGPathElement {
		const path = document.createElementNS(SVG_NS, "path");
		path.classList.add("edge");
		if (e.relation === null) path.classList.add("agg");
		else if (e.relation !== "references") path.classList.add("typed");
		path.dataset["key"] = e.key;
		path.style.setProperty("--ec", colorForRelation(e.rel));
		const text = (): string => {
			const cur = edgeEls.get(e.key)?.edge ?? e;
			return cur.relation ?? `${cur.weight} link${cur.weight === 1 ? "" : "s"}`;
		};
		path.addEventListener("pointerenter", (ev) => {
			path.classList.add("hl");
			edgesG.append(path); // raise the hovered strand above its bundle
			showTooltip(ev, text());
		});
		path.addEventListener("pointermove", (ev) => showTooltip(ev, text()));
		path.addEventListener("pointerleave", () => {
			if (!(hovered && (e.from === hovered || e.to === hovered))) path.classList.remove("hl");
			hideTooltip();
		});
		return path;
	}

	// ------------------------------------------------------------ positions + edges
	/** Endpoint geometry for bundling: position, radius and gate group. */
	function bundleEnd(r: EndRef, groupCentres: Map<string, { x: number; y: number; R: number }> | null): BundleEnd | null {
		const end = bundleEndGeom(r, groupCentres);
		if (end && backbone) end.hub = backbone.hubOf.get(r.kind === "bubble" ? r.id : index.clusterOf.get(r.id)!);
		return end;
	}

	function bundleEndGeom(r: EndRef, groupCentres: Map<string, { x: number; y: number; R: number }> | null): BundleEnd | null {
		if (r.kind === "bubble") {
			const b = rBubbles.get(r.id);
			if (!b) return null;
			const u = units.get(r.id)!;
			if (b.residual) return { x: b.x, y: b.y, r: b.r, group: r.id, gx: u.x ?? 0, gy: u.y ?? 0, gR: u.R };
			return { x: b.x, y: b.y, r: b.r, group: r.id, gx: b.x, gy: b.y, gR: b.r + 10 };
		}
		const p = posOf(r.id);
		if (!p) return null;
		const rad = (nodeR.get(r.id) ?? 6) * (rNodes.has(r.id) && !fullIds.has(r.id) ? 0.7 : 1);
		const cid = index.clusterOf.get(r.id)!;
		if (mode === "flat") {
			const gc = groupCentres?.get(cid);
			if (gc) return { ...p, r: rad, group: cid, gx: gc.x, gy: gc.y, gR: gc.R };
			return { ...p, r: rad, group: r.id, gx: p.x, gy: p.y, gR: rad + 8 };
		}
		const u = units.get(cid)!;
		if (u.size > 1 && expanded.has(cid)) return { ...p, r: rad, group: cid, gx: u.x ?? 0, gy: u.y ?? 0, gR: u.R };
		return { ...p, r: rad, group: r.id, gx: p.x, gy: p.y, gR: rad + 8 };
	}

	/** Flat mode gates: each cluster's member centroid + spread (lone nodes gate on themselves). */
	function flatGroupCentres(): Map<string, { x: number; y: number; R: number }> {
		const acc = new Map<string, { x: number; y: number; n: number; pts: P[] }>();
		for (const sn of simNodeList) {
			const t = index.clusterOf.get(sn.id)!;
			let a = acc.get(t);
			if (!a) acc.set(t, (a = { x: 0, y: 0, n: 0, pts: [] }));
			a.x += sn.x ?? 0;
			a.y += sn.y ?? 0;
			a.n++;
			a.pts.push({ x: sn.x ?? 0, y: sn.y ?? 0 });
		}
		const out = new Map<string, { x: number; y: number; R: number }>();
		for (const [t, a] of acc) {
			if (a.n < 2) continue;
			const cx = a.x / a.n;
			const cy = a.y / a.n;
			let ss = 0;
			for (const p of a.pts) ss += (p.x - cx) ** 2 + (p.y - cy) ** 2;
			out.set(t, { x: cx, y: cy, R: Math.sqrt(ss / a.n) * 0.9 + 10 });
		}
		return out;
	}

	/**
	 * Position every mounted element. Edges draw straight while the layout is
	 * still moving (or a node is being dragged) and are re-routed as bundles once
	 * it settles — bundling runs only when the render set or layout changed.
	 */
	function draw(): void {
		for (const [id, g] of nodeEls) {
			const p = posOf(id);
			if (p) g.setAttribute("transform", `translate(${p.x},${p.y})`);
		}
		for (const [cid, g] of bubbleEls) {
			const b = rBubbles.get(cid);
			if (b) g.setAttribute("transform", `translate(${b.x},${b.y})`);
		}
		for (const [cid, g] of hullEls) {
			const u = units.get(cid);
			if (u) g.setAttribute("transform", `translate(${u.x ?? 0},${u.y ?? 0})`);
		}
		const hot = layoutHot();
		svg.dataset["settled"] = hot ? "0" : "1";
		if (!hot && !bundleDirty) return;
		const groupCentres = mode === "flat" ? flatGroupCentres() : null;
		// Overview backbone over the cluster discs — rebuilt only when they moved.
		if (mode !== "tree" || !bundling || hot) backbone = null;
		else if (!backbone || backboneVersion !== posVersion) {
			backbone = buildBackbone([...units.values()].map((u) => ({ id: u.id, x: u.x ?? 0, y: u.y ?? 0, R: u.R })));
			backboneVersion = posVersion;
		}
		// Overview-sized render sets are bundled whole (mounted or not) and cached
		// per render set + layout + zoom bucket, so panning — which only mounts and
		// unmounts edges — reuses the routes instead of re-bundling.
		const whole = !hot && bundling && edgeCache.list.length <= EDGE_BUDGET && rNodes.size <= WHOLE_BUNDLE_NODES;
		const cacheKey = `${edgeCache.sig}#${posVersion}#${mode}`;
		if (whole && bundleCache?.key === cacheKey && Math.abs(Math.log(view.k / bundleK)) <= Math.log(1.4)) {
			for (const [key, entry] of edgeEls) applyRoute(entry, bundleCache.paths.get(key), bundleCache.mids.get(key));
			bundleDirty = false;
			return;
		}
		bundleCache = null;
		const inputs: BundleInput[] = [];
		const basis = whole ? edgeCache.list.map((e) => [e.key, e] as const) : [...edgeEls].map(([key, { edge }]) => [key, edge] as const);
		for (const [key, edge] of basis) {
			const a = bundleEnd(edge.a, groupCentres);
			const b = bundleEnd(edge.b, groupCentres);
			const arrow = edge.relation !== null && edge.relation !== "references";
			// Overview bubble ↔ bubble edges converge on their super-group's hub.
			const viaHub = edge.a.kind === "bubble" && edge.b.kind === "bubble";
			if (a && b) inputs.push({ key, a, b, strands: Math.min(edge.weight, MAX_STRANDS), arrow, weight: edge.weight, viaHub });
		}
		tiesG.innerHTML = "";
		for (const t of trunkLabels) t.remove();
		trunkLabels = [];
		if (hot || !bundling) {
			for (const inp of inputs) {
				const entry = edgeEls.get(inp.key)!;
				if (!entry) continue;
				entry.el.setAttribute("d", straightPath(inp.a, inp.b, !hot && inp.arrow ? 6 / view.k : 0));
				if (inp.strands > 1) entry.el.style.strokeWidth = `calc(var(--sw, 1px) * ${1 + Math.log2(inp.strands)})`;
				else entry.el.style.removeProperty("stroke-width");
				if (entry.label) {
					entry.label.style.display = entry.edge.weight >= 2 ? "" : "none";
					entry.label.setAttribute("x", String((inp.a.x + inp.b.x) / 2));
					entry.label.setAttribute("y", String((inp.a.y + inp.b.y) / 2));
				}
			}
			svg.dataset["bundles"] = "0";
			setScreenUnits();
			if (!hot) bundleDirty = false;
			return;
		}
		const t0 = performance.now();
		setScreenUnits();
		const res = bundleEdges(inputs, {
			gap: 3.2 / view.k,
			arrowSize: 6 / view.k,
			trunkWidth: 18 / view.k,
			tiePad: 3.5 / view.k,
			backbone,
		});
		for (const [key, entry] of edgeEls) applyRoute(entry, res.paths.get(key), res.mids.get(key));
		if (whole) bundleCache = { key: cacheKey, paths: res.paths, mids: res.mids };
		// Cable-ties: every tie in two paths (dark band + light core), not one
		// element per tie.
		if (res.ties.length > 0) {
			const seg = res.ties.map((t) => `M${t.x1.toFixed(1)},${t.y1.toFixed(1)}L${t.x2.toFixed(1)},${t.y2.toFixed(1)}`).join("");
			for (const cls of ["tie", "tie-core"]) {
				const path = document.createElementNS(SVG_NS, "path");
				path.classList.add(cls);
				path.setAttribute("d", seg);
				tiesG.append(path);
			}
		}
		for (const t of res.trunks) {
			const label = document.createElementNS(SVG_NS, "text");
			label.classList.add("weight", "trunk");
			label.textContent = String(t.count);
			label.setAttribute("x", String(t.x));
			label.setAttribute("y", String(t.y));
			labelsG.append(label);
			trunkLabels.push(label);
		}
		svg.dataset["bundles"] = String(res.bundles);
		svg.dataset["bundleMs"] = (performance.now() - t0).toFixed(1);
		bundleDirty = false;
	}

	function applyRoute(entry: { el: SVGPathElement; label: SVGTextElement | null; edge: RenderEdge }, d: string | undefined, m: P | undefined): void {
		if (d) entry.el.setAttribute("d", d);
		entry.el.style.removeProperty("stroke-width");
		if (entry.label) {
			// Edges riding a backbone trunk are counted on the trunk instead.
			entry.label.style.display = m && entry.edge.weight >= 2 ? "" : "none";
			if (m) {
				entry.label.setAttribute("x", String(m.x));
				entry.label.setAttribute("y", String(m.y));
			}
		}
	}

	/** Screen-px sizing for strokes + weight labels at the current zoom. */
	function setScreenUnits(): void {
		bundleK = view.k;
		viewport.style.setProperty("--sw", `${1 / view.k}px`);
		labelsG.setAttribute("font-size", String(10 / view.k));
	}

	/** Edge legend: the relations of the rendered strands, canonical order first. */
	function updateLegend(): void {
		const rels = new Set<string>();
		for (const e of rEdges.values()) rels.add(e.rel);
		const order = Object.keys(RELATION_COLORS);
		const list = [...rels].sort((a, b) => {
			const ia = order.indexOf(a);
			const ib = order.indexOf(b);
			return (ia < 0 ? 1e3 : ia) - (ib < 0 ? 1e3 : ib) || a.localeCompare(b);
		});
		if (list.join("|") !== legend.map((l) => l.rel).join("|")) legend = list.map((rel) => ({ rel, color: colorForRelation(rel) }));
	}

	function onTick(): void {
		posVersion++;
		bundleDirty = true;
		scheduleDraw();
		// Nodes drift across the viewport boundary as the layout settles — keep the
		// rendered set in sync (throttled).
		scheduleLod();
	}

	function onSettled(): void {
		bundleDirty = true;
		if (mode === "flat" && !fitted) fitFlat();
		scheduleLod();
	}

	/** After the first flat settle: zoom out (not below 0.5, labels stay legible)
	 * if the spread-out layout overflows the viewport. */
	function fitFlat(): void {
		fitted = true;
		if (simNodeList.length === 0) return;
		let [x0, y0, x1, y1] = [Infinity, Infinity, -Infinity, -Infinity];
		for (const sn of simNodeList) {
			x0 = Math.min(x0, (sn.x ?? 0) - sn.cr);
			y0 = Math.min(y0, (sn.y ?? 0) - sn.cr);
			x1 = Math.max(x1, (sn.x ?? 0) + sn.cr);
			y1 = Math.max(y1, (sn.y ?? 0) + sn.cr);
		}
		const w = svg.clientWidth || 900;
		const h = svg.clientHeight || 600;
		const fit = Math.min(w / (x1 - x0), h / (y1 - y0)) * 0.95;
		if (fit >= view.k) return;
		const k = Math.max(0.5, fit);
		animateView(w / 2 - ((x0 + x1) / 2) * k, h / 2 - ((y0 + y1) / 2) * k, k);
	}

	// ----------------------------------------------------- hover / tooltip

	function showTooltip(ev: PointerEvent, text: string): void {
		tooltip = { text, x: ev.clientX + 12, y: ev.clientY + 12, visible: true };
	}
	function hideTooltip(): void {
		tooltip = { ...tooltip, visible: false };
	}

	function setHover(id: string | null): void {
		hovered = id;
		reapplyHover();
	}

	// Apply the current `hovered` highlight to whatever elements are mounted now
	// (called on hover changes AND after each LOD pass, so re-mounted neighbours
	// pick up their highlight classes).
	function reapplyHover(): void {
		if (hovered === null) {
			svg.classList.remove("hovering");
			for (const g of nodeEls.values()) g.classList.remove("active", "nbr");
			for (const { el } of edgeEls.values()) el.classList.remove("hl");
			return;
		}
		svg.classList.add("hovering");
		const nbrs = adj.get(hovered) ?? new Set<string>();
		for (const [nid, g] of nodeEls) {
			g.classList.toggle("active", nid === hovered);
			g.classList.toggle("nbr", nid !== hovered && nbrs.has(nid));
		}
		for (const { el, edge } of edgeEls.values()) {
			const on = edge.relation !== null && (edge.from === hovered || edge.to === hovered);
			el.classList.toggle("hl", on);
			if (on) edgesG.append(el);
		}
	}

	// Selected node: its edges trace through their bundles in the accent colour.
	function reapplySelected(): void {
		for (const [nid, g] of nodeEls) g.classList.toggle("selected", nid === selectedId);
		for (const { el, edge } of edgeEls.values()) {
			const on = selectedId !== null && edge.relation !== null && (edge.from === selectedId || edge.to === selectedId);
			el.classList.toggle("sel", on);
			if (on) edgesG.append(el);
		}
	}

	// ----------------------------------------------------- sticky click focus

	// Apply the sticky-focus dim to whatever elements are mounted now (called on
	// focus changes AND after each LOD pass, so re-mounted neighbours keep the
	// right opacity). Independent of hover — both can be active at once.
	function reapplyFocus(): void {
		if (focused === null) {
			svg.classList.remove("focusing");
			for (const g of nodeEls.values()) g.classList.remove("dim", "focused");
			for (const g of bubbleEls.values()) g.classList.remove("dim");
			for (const { el } of edgeEls.values()) el.classList.remove("dim");
			return;
		}
		svg.classList.add("focusing");
		for (const [nid, g] of nodeEls) {
			g.classList.toggle("dim", isDimmed(nid, focusReveal));
			g.classList.toggle("focused", nid === focused);
		}
		for (const g of bubbleEls.values()) g.classList.add("dim");
		for (const { el, edge } of edgeEls.values()) {
			el.classList.toggle("dim", edge.relation === null || isEdgeDimmed(edge.from, edge.to, focused));
		}
	}

	// Set (or clear) the sticky focus. Recomputes the reveal set, then refilters
	// so newly-revealed off-type neighbors appear, and re-applies the dim.
	// Clicking the already-focused node clears it.
	function setFocus(id: string | null): void {
		const next = id !== null && id === focused ? null : id;
		if (next === focused) return;
		focused = next;
		focusReveal = focusRevealSet(next, graph.edges);
		// Flat: the reveal set changes which nodes belong in the sim, so relayout.
		// Tree: positions are independent of the filter — just refilter + LOD.
		if (mode === "flat") renderGraph();
		else {
			refilter();
			lodPass();
		}
	}

	// ------------------------------------------------- node drag + click

	function attachNodeEvents(g: SVGGElement, id: string): void {
		g.addEventListener("pointerenter", () => setHover(id));
		g.addEventListener("pointerleave", () => setHover(null));

		g.addEventListener("pointerdown", (ev) => {
			ev.stopPropagation();
			g.setPointerCapture(ev.pointerId);
			const start = [ev.clientX, ev.clientY];
			let moved = false;
			let last: P | null = null;

			const onMove = (mv: PointerEvent): void => {
				if (!moved && Math.hypot(mv.clientX - start[0]!, mv.clientY - start[1]!) < 4) return;
				if (!moved) {
					moved = true;
					dragging = true;
					if (mode === "flat") sim?.alphaTarget(0.3).restart();
				}
				const [gx, gy] = toGraphCoords(mv.clientX, mv.clientY);
				last = { x: gx, y: gy };
				if (mode === "flat") {
					const sn = simNodes.get(id);
					if (sn) {
						sn.fx = gx;
						sn.fy = gy;
					}
				} else {
					// Tree: members aren't simulated — move the cached local position.
					const cid = index.clusterOf.get(id)!;
					const u = units.get(cid)!;
					ensureLocal(cid).set(id, { x: gx - (u.x ?? 0), y: gy - (u.y ?? 0) });
					posVersion++;
					bundleDirty = true;
					scheduleDraw();
				}
			};
			const onUp = (): void => {
				g.removeEventListener("pointermove", onMove);
				g.removeEventListener("pointerup", onUp);
				g.removeEventListener("pointercancel", onUp);
				if (moved) {
					dragging = false;
					// ANCHOR: keep the node at its drop point and persist it per-vault.
					let ax = last?.x ?? 0;
					let ay = last?.y ?? 0;
					if (mode === "flat") {
						sim?.alphaTarget(0);
						const sn = simNodes.get(id);
						if (sn) {
							ax = sn.fx ?? sn.x ?? 0;
							ay = sn.fy ?? sn.y ?? 0;
							sn.fx = ax;
							sn.fy = ay;
						}
					}
					anchors = setAnchor(anchors, id, { x: ax, y: ay });
					saveAnchors();
					g.classList.add("pinned");
					bundleDirty = true;
					scheduleDraw();
				} else {
					// A click (no drag): open the concept panel AND toggle sticky focus
					// on this node (clicking the focused node again clears it).
					setFocus(id);
					onselect(id);
				}
			};
			g.addEventListener("pointermove", onMove);
			g.addEventListener("pointerup", onUp);
			g.addEventListener("pointercancel", onUp);
		});
	}

	// A bubble: click expands (zooms in so the cluster opens); drag moves the
	// whole cluster disc (pinned + persisted like a node anchor).
	function attachBubbleEvents(g: SVGGElement, cid: string): void {
		g.addEventListener("pointerdown", (ev) => {
			ev.stopPropagation();
			g.setPointerCapture(ev.pointerId);
			const start = [ev.clientX, ev.clientY];
			const u = units.get(cid)!;
			let moved = false;
			const onMove = (mv: PointerEvent): void => {
				if (!moved && Math.hypot(mv.clientX - start[0]!, mv.clientY - start[1]!) < 4) return;
				if (!moved) {
					moved = true;
					dragging = true;
					topSim?.alphaTarget(0.3).restart();
				}
				const [gx, gy] = toGraphCoords(mv.clientX, mv.clientY);
				const isResidual = rBubbles.get(cid)?.residual ?? false;
				u.fx = gx;
				u.fy = isResidual ? gy + u.R : gy;
			};
			const onUp = (): void => {
				g.removeEventListener("pointermove", onMove);
				g.removeEventListener("pointerup", onUp);
				g.removeEventListener("pointercancel", onUp);
				if (moved) {
					dragging = false;
					topSim?.alphaTarget(0);
					anchors = setAnchor(anchors, cid, { x: u.fx ?? u.x ?? 0, y: u.fy ?? u.y ?? 0 });
					saveAnchors();
				} else {
					expandCluster(cid);
				}
			};
			g.addEventListener("pointermove", onMove);
			g.addEventListener("pointerup", onUp);
			g.addEventListener("pointercancel", onUp);
		});
	}

	/** Open a cluster: it jumps the budget queue and the view zooms in on it. */
	export function expandCluster(cid: string): void {
		const u = units.get(cid);
		if (!u) return;
		const rect = svg.getBoundingClientRect();
		const k = expandScaleFor(u.R, view.k);
		manualOpen.set(cid, k);
		animateView(rect.width / 2 - (u.x ?? 0) * k, rect.height / 2 - (u.y ?? 0) * k, k);
	}

	// ------------------------------------------------------------ pan + zoom

	function onSvgPointerDown(ev: PointerEvent): void {
		if (ev.button !== 0) return;
		svg.classList.add("panning");
		svg.setPointerCapture(ev.pointerId);
		const [sx, sy] = [ev.clientX, ev.clientY];
		let [px, py] = [ev.clientX, ev.clientY];
		let moved = false;
		const onMove = (mv: PointerEvent): void => {
			if (!moved && Math.hypot(mv.clientX - sx, mv.clientY - sy) >= 4) moved = true;
			view.x += mv.clientX - px;
			view.y += mv.clientY - py;
			[px, py] = [mv.clientX, mv.clientY];
			applyView();
		};
		const onUp = (): void => {
			svg.classList.remove("panning");
			svg.removeEventListener("pointermove", onMove);
			svg.removeEventListener("pointerup", onUp);
			svg.removeEventListener("pointercancel", onUp);
			// A click on empty canvas (no pan) clears any sticky focus. Node clicks
			// stopPropagation on pointerdown, so this only fires for the background.
			if (!moved && focused !== null) setFocus(null);
		};
		svg.addEventListener("pointermove", onMove);
		svg.addEventListener("pointerup", onUp);
		svg.addEventListener("pointercancel", onUp);
	}

	function onWheel(ev: WheelEvent): void {
		ev.preventDefault();
		const rect = svg.getBoundingClientRect();
		const cx = ev.clientX - rect.left;
		const cy = ev.clientY - rect.top;
		const k = Math.min(8, Math.max(0.12, view.k * Math.exp(-ev.deltaY * 0.0022)));
		// Keep the point under the cursor fixed.
		view.x = cx - ((cx - view.x) / view.k) * k;
		view.y = cy - ((cy - view.y) / view.k) * k;
		view.k = k;
		applyView();
		onZoomed();
	}

	// Semantic zoom: if this zoom crossed a LOD tier (auto mode), re-include/
	// exclude the affected type(s). Flat: a gentle relayout; tree: positions don't
	// depend on the filter, so only the eligible set changes.
	function onZoomed(): void {
		if (!recomputeLod()) return;
		if (mode === "flat") renderGraph(true);
		else {
			refilter();
			scheduleLod();
		}
	}

	/**
	 * Reset the layout (exported: the "Reset graph" control calls via bind:this).
	 * Clears every persisted anchor (and the cached cluster map) for this vault,
	 * un-pins all nodes so they're free again, then re-runs the layout from
	 * scratch. Type prefs are reset by the parent (+page.svelte) alongside this.
	 */
	export function resetGraph(): void {
		anchors = {};
		if (typeof localStorage !== "undefined") {
			try {
				localStorage.removeItem(anchorStorageKey(vaultId));
				localStorage.removeItem(layoutKey());
			} catch {
				/* ignore storage errors */
			}
		}
		// Un-pin the live sim nodes and drop the pinned cue from mounted elements.
		clearAnchorsFromNodes(simNodeList);
		clearAnchorsFromNodes([...units.values()]);
		for (const g of nodeEls.values()) g.classList.remove("pinned");
		// Clear any sticky focus so the dim + off-type reveal don't survive a reset.
		focused = null;
		focusReveal = new Set();
		manualOpen.clear();
		// Re-layout from scratch.
		units = new Map();
		fitted = false;
		local.clear();
		renderGraph();
	}

	/** Pan/zoom so `id` is centered (exported: parents call via bind:this). In the
	 * clustered layout this also zooms far enough for its cluster to open. */
	export function panTo(id: string): void {
		const p = posOf(id);
		if (!p) return;
		const rect = svg.getBoundingClientRect();
		let targetK = Math.max(view.k, 1);
		if (mode === "tree") {
			const cid = index.clusterOf.get(id);
			const u = cid ? units.get(cid) : undefined;
			if (u && u.size > 1) targetK = Math.max(targetK, expandScaleFor(u.R, view.k));
		}
		const tx = rect.width / 2 - p.x * targetK;
		const ty = rect.height / 2 - p.y * targetK;
		animateView(tx, ty, targetK);
	}

	let animating = false;
	function animateView(tx: number, ty: number, tk: number): void {
		animating = true;
		const from = { ...view };
		const t0 = performance.now();
		const dur = 380;
		const step = (t: number): void => {
			const p = Math.min(1, (t - t0) / dur);
			const e = 1 - (1 - p) ** 3; // ease-out cubic
			view.x = from.x + (tx - from.x) * e;
			view.y = from.y + (ty - from.y) * e;
			view.k = from.k + (tk - from.k) * e;
			applyView();
			if (p < 1) requestAnimationFrame(step);
			else {
				animating = false;
				onZoomed();
			}
		};
		requestAnimationFrame(step);
	}

	// ------------------------------------------------------------ lifecycle

	$effect(() => {
		// One-time SVG scaffolding (defs + viewport groups). The blur glow filter
		// is kept for the few emphasised nodes (selected / hovered / focused);
		// everything else uses the filter-free halo circle. Arrowheads are drawn
		// into each edge's path (chevron), not as markers.
		svg.innerHTML = `
			<defs>
				<filter id="node-glow-strong" x="-150%" y="-150%" width="400%" height="400%">
					<feGaussianBlur in="SourceGraphic" stdDeviation="5.5" result="halo"></feGaussianBlur>
					<feMerge>
						<feMergeNode in="halo"></feMergeNode>
						<feMergeNode in="SourceGraphic"></feMergeNode>
					</feMerge>
				</filter>
			</defs>`;
		viewport = document.createElementNS(SVG_NS, "g");
		hullsG = document.createElementNS(SVG_NS, "g");
		edgesG = document.createElementNS(SVG_NS, "g");
		tiesG = document.createElementNS(SVG_NS, "g");
		nodesG = document.createElementNS(SVG_NS, "g");
		labelsG = document.createElementNS(SVG_NS, "g");
		hullsG.classList.add("hulls");
		edgesG.classList.add("edges");
		tiesG.classList.add("ties");
		labelsG.classList.add("weights");
		viewport.append(hullsG, edgesG, tiesG, nodesG, labelsG);
		svg.append(viewport);
		applyView();

		let resizeTimer: ReturnType<typeof setTimeout> | null = null;
		const onResize = (): void => {
			if (resizeTimer) clearTimeout(resizeTimer);
			resizeTimer = setTimeout(() => (mode === "flat" ? renderGraph() : scheduleLod()), 200);
		};
		window.addEventListener("resize", onResize);
		// Escape clears sticky focus (only when it's active — otherwise let other
		// handlers, e.g. closing the concept panel, own the key).
		const onKeyDown = (ev: KeyboardEvent): void => {
			if (ev.key === "Escape" && focused !== null) setFocus(null);
		};
		window.addEventListener("keydown", onKeyDown);
		return () => {
			window.removeEventListener("resize", onResize);
			window.removeEventListener("keydown", onKeyDown);
			if (lodTimer) clearTimeout(lodTimer);
			sim?.stop();
			topSim?.stop();
		};
	});

	// Re-render whenever the data or filters change. In auto mode, (re)seed the LOD
	// set from the current zoom first so the effective type set is fresh; entering
	// auto (e.g. after Reset) recomputes from scratch. In manual mode the
	// `enabledTypes` chips drive the filter directly.
	$effect(() => {
		void graph;
		void enabledTypes;
		void focusId;
		void filterMode;
		void registry;
		if (filterMode === "auto") {
			// Force a recompute from a cleared cache so switching into auto (or a data
			// change) always re-derives the tier for the current scale.
			lodTypes = new Set();
			recomputeLod();
		}
		const dataChanged = builtFor.graph !== graph || builtFor.registry !== registry;
		// Tree layout + a filter-only change: no relayout, just refilter + LOD.
		if (mode === "tree" && !dataChanged && topSim) {
			refilter();
			lodPass();
		} else renderGraph();
	});

	// Selection: highlight + force the node and its neighbours into the render set.
	$effect(() => {
		void selectedId;
		reapplySelected();
		scheduleLod();
	});

	// Bundling toggled: re-route edges.
	$effect(() => {
		void bundling;
		bundleDirty = true;
		scheduleDraw();
	});
</script>

<div class="wrap">
	<svg bind:this={svg} onpointerdown={onSvgPointerDown} onwheel={onWheel} role="application" aria-label="Concept graph"></svg>
	{#if empty}
		<div class="empty-hint">No nodes match the current filters.</div>
	{/if}
	{#if legend.length > 0}
		<ul class="edge-legend" aria-label="Edge colours by relation">
			{#each legend as l (l.rel)}
				<li><span class="swatch" style="background:{l.color}"></span>{l.rel.replaceAll("_", " ")}</li>
			{/each}
		</ul>
	{/if}
	{#if tooltip.visible}
		<div class="tooltip" style="left:{tooltip.x}px;top:{tooltip.y}px">{tooltip.text}</div>
	{/if}
</div>

<style>
	.wrap {
		position: relative;
		width: 100%;
		height: 100%;
	}
	svg {
		width: 100%;
		height: 100%;
		display: block;
		cursor: grab;
		touch-action: none;
		/* Obsidian graph view: nodes float on a recessed near-black canvas
		   with the faintest violet breath at the center. */
		background:
			radial-gradient(ellipse 90% 70% at 50% 45%, rgb(124 58 237 / 0.05), transparent 70%),
			var(--bg-deep);
	}
	svg:global(.panning) {
		cursor: grabbing;
	}

	.empty-hint {
		position: absolute;
		inset: 0;
		display: flex;
		align-items: center;
		justify-content: center;
		color: var(--text-dim);
		pointer-events: none;
		font-size: 14px;
	}

	.edge-legend {
		position: absolute;
		right: 12px;
		bottom: 12px;
		margin: 0;
		padding: 6px 10px;
		list-style: none;
		display: flex;
		flex-direction: column;
		gap: 3px;
		font-size: 11px;
		color: var(--text-dim);
		background: rgb(10 10 13 / 0.72);
		border: 1px solid var(--border);
		border-radius: 6px;
		pointer-events: none;
	}
	.edge-legend li {
		display: flex;
		align-items: center;
		gap: 7px;
	}
	.edge-legend .swatch {
		width: 14px;
		height: 3px;
		border-radius: 2px;
	}

	.tooltip {
		position: fixed;
		z-index: 50;
		background: var(--bg-overlay);
		border: 1px solid var(--border-strong);
		border-radius: 6px;
		padding: 3px 9px;
		font-size: 12px;
		color: var(--text);
		pointer-events: none;
		box-shadow: 0 4px 14px rgb(0 0 0 / 0.5);
	}

	/* Imperative SVG children need :global selectors. */
	/* Strokes in screen px: --sw = 1/zoom, refreshed when the zoom drifts (not
	   per frame — vector-effect: non-scaling-stroke made every pan re-raster). */
	/* Strands: tinted by relation (--ec, see the legend), wide and opaque
	   enough to read as parallel cables inside a bundle. */
	svg :global(path.edge) {
		fill: none;
		stroke: var(--ec, var(--edge));
		stroke-width: calc(var(--sw, 1px) * 1.35);
		stroke-linecap: round;
		opacity: 0.72;
	}
	svg :global(path.edge.agg) {
		opacity: 0.62;
	}
	svg :global(path.edge.hl),
	svg :global(path.edge.sel) {
		stroke: var(--accent);
		stroke-width: calc(var(--sw, 1px) * 1.6);
		opacity: 1;
	}
	/* Cable-ties where a bundle pinches together: a dark band with a light
	   core, drawn across the strands. */
	svg :global(path.tie),
	svg :global(path.tie-core) {
		fill: none;
		stroke-linecap: round;
		pointer-events: none;
	}
	svg :global(path.tie) {
		stroke: rgb(10 10 13 / 0.9);
		stroke-width: calc(var(--sw, 1px) * 7);
	}
	svg :global(path.tie-core) {
		stroke: #c9d2e3;
		stroke-width: calc(var(--sw, 1px) * 3.5);
	}
	svg :global(text.weight.trunk) {
		fill: var(--text);
		font-weight: 600;
	}
	svg :global(text.weight) {
		fill: var(--text-dim);
		text-anchor: middle;
		dominant-baseline: middle;
		pointer-events: none;
		paint-order: stroke;
		stroke: rgb(10 10 13 / 0.9);
		stroke-width: 3px;
	}

	svg :global(g.node) {
		cursor: pointer;
	}
	svg :global(g.node circle.mark) {
		stroke: rgb(255 255 255 / 0.12);
		stroke-width: 1;
		transition: opacity 120ms ease;
	}
	svg :global(g.node circle.halo) {
		fill-opacity: 0.22;
		pointer-events: none;
	}
	svg :global(g.node.pending circle.mark) {
		fill-opacity: 0.3;
		stroke: var(--node-pending, #6b7280);
		stroke-dasharray: 3 3;
	}
	svg :global(g.node.pending circle.halo) {
		display: none;
	}
	svg :global(g.node text) {
		fill: var(--text-dim);
		font-size: 11px;
		text-anchor: middle;
		pointer-events: none;
		user-select: none;
		paint-order: stroke;
		stroke: rgb(10 10 13 / 0.8);
		stroke-width: 3px;
	}
	svg:global(.labels-hidden) :global(g.node text) {
		display: none;
	}
	/* Far from the viewport centre: simplified mark — smaller, no glow, no label. */
	svg :global(g.node.far circle.mark) {
		transform: scale(0.7);
	}
	svg :global(g.node.far circle.halo) {
		display: none;
	}
	svg :global(g.node.far text) {
		display: none;
	}
	svg :global(g.node.selected circle.mark) {
		stroke: var(--accent);
		stroke-width: 2;
		filter: url(#node-glow-strong);
	}
	svg :global(g.node.selected text) {
		fill: var(--text);
	}

	/* Pinned (anchored) nodes read as fixed: a subtle dashed ring in the accent
	   hue that doesn't overpower the selected/hover states. */
	svg :global(g.node.pinned circle.mark) {
		stroke: var(--accent);
		stroke-width: 1.5;
		stroke-dasharray: 2 2;
	}

	/* Cluster bubbles (collapsed clusters) and hulls (expanded ones). */
	svg :global(g.cluster) {
		cursor: zoom-in;
	}
	svg :global(g.cluster circle) {
		fill-opacity: 0.22;
		stroke-width: calc(var(--sw, 1px) * 1.5);
		stroke-opacity: 0.8;
	}
	svg :global(g.cluster.residual circle) {
		fill-opacity: 0.1;
		stroke-dasharray: 4 3;
	}
	svg :global(g.cluster text) {
		text-anchor: middle;
		pointer-events: none;
		user-select: none;
		paint-order: stroke;
		stroke: rgb(10 10 13 / 0.85);
		stroke-width: 3px;
	}
	svg :global(g.cluster text.count) {
		fill: var(--text);
		font-weight: 600;
	}
	svg :global(g.cluster text.ctitle) {
		fill: var(--text-dim);
	}
	svg :global(g.cluster.dim) {
		opacity: 0.25;
	}
	svg :global(g.hull circle) {
		fill: none;
		stroke-opacity: 0.22;
		stroke-width: calc(var(--sw, 1px) * 1.2);
		stroke-dasharray: 6 6;
		pointer-events: none;
	}
	svg :global(g.hull text) {
		fill: var(--text-dim);
		opacity: 0.7;
		text-anchor: middle;
		pointer-events: none;
		user-select: none;
	}

	/* Hover: halo the hovered node, dim everything outside its neighborhood. */
	svg :global(g.node.active circle.mark) {
		stroke: rgb(255 255 255 / 0.35);
		filter: url(#node-glow-strong);
	}
	svg:global(.hovering) :global(g.node) {
		opacity: 0.2;
	}
	svg:global(.hovering) :global(g.node.active),
	svg:global(.hovering) :global(g.node.nbr) {
		opacity: 1;
	}
	svg:global(.hovering) :global(g.node.active text) {
		fill: var(--text);
	}
	svg:global(.hovering) :global(path.edge) {
		opacity: 0.12;
	}
	svg:global(.hovering) :global(path.edge.hl) {
		opacity: 1;
	}

	/* Sticky click-focus: spotlight the focused node + its 1-hop neighbors,
	   dropping everything else (nodes AND edges tagged .dim) to a low opacity.
	   Independent of hover — a transient hover highlight still applies on top. */
	svg:global(.focusing) :global(g.node.dim) {
		opacity: 0.12;
	}
	svg:global(.focusing) :global(path.edge.dim) {
		opacity: 0.08;
	}
	/* The focused node reads as selected already; give it a touch more presence. */
	svg:global(.focusing) :global(g.node.focused circle.mark) {
		stroke: var(--accent);
		stroke-width: 2;
		filter: url(#node-glow-strong);
	}
	svg:global(.focusing) :global(g.node.focused text) {
		fill: var(--text);
	}
</style>
