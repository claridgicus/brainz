<script lang="ts">
	// Force-directed graph — a Svelte port of packages/web/frontend/main.ts.
	// The simulation + SVG management stays imperative (d3-force mutates node
	// objects every tick); Svelte owns the chrome around it.
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
	import type { Edge, GraphNode, GraphPayload } from "@brainz/contracts";
	import { filterGraph, neighborhood, radiusFor, TYPE_COLORS } from "$lib/graph-data";
	import {
		anchorStorageKey,
		applyAnchors,
		clearAnchorsFromNodes,
		deserializeAnchors,
		nodesInViewport,
		planEdges,
		serializeAnchors,
		setAnchor,
		type AnchorMap,
		type EdgeRenderPlan,
		type PositionedNode,
	} from "$lib/graph-view";

	interface SimNode extends SimulationNodeDatum {
		id: string;
		data: GraphNode;
		r: number;
	}
	type SimLink = SimulationLinkDatum<SimNode> & { relation: string };

	let {
		graph,
		enabledTypes,
		vaultId,
		focusId = null,
		selectedId = null,
		onselect,
	}: {
		graph: GraphPayload;
		enabledTypes: string[];
		vaultId: string;
		focusId?: string | null;
		selectedId?: string | null;
		onselect: (id: string) => void;
	} = $props();

	const SVG_NS = "http://www.w3.org/2000/svg";

	let svg: SVGSVGElement;
	let tooltip = $state({ text: "", x: 0, y: 0, visible: false });
	let empty = $state(false);

	// ------------------------------------------------------------ sim state
	const simNodes = new Map<string, SimNode>(); // positions survive re-renders
	let sim: Simulation<SimNode, SimLink> | null = null;
	let viewport: SVGGElement;
	let edgesG: SVGGElement;
	let nodesG: SVGGElement;
	const view = { x: 0, y: 0, k: 1 };

	// The sim runs over the full type-filtered node/edge set (`simNodeList` /
	// `simLinks`); the DOM only holds the *viewport-culled* subset. `nodeEls` and
	// `edgeEls` are keyed by id and pooled — a cull pass adds/removes elements to
	// match what's in view rather than rebuilding everything.
	let simNodeList: SimNode[] = [];
	let simLinks: SimLink[] = [];
	let hovered: string | null = null; // survives cull passes so re-mounted nodes re-highlight
	const nodeEls = new Map<string, SVGGElement>();
	const edgeEls = new Map<string, { el: SVGLineElement; link: SimLink; plan: EdgeRenderPlan }>();

	// ------------------------------------------------------------ drag anchors
	// User-dropped nodes are pinned (fx/fy kept) and their position persisted per
	// vault in localStorage, restored on mount so the layout survives reloads.
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

	// Keep off-screen nodes just outside the frame mounted so panning doesn't
	// pop them in at the very edge.
	const CULL_MARGIN = 60;
	// Unique key for an edge element (matches how planEdges identifies edges).
	const edgeKey = (e: Edge): string => `${e.from}|${e.relation}|${e.to}`;

	function applyView(): void {
		viewport.setAttribute("transform", `translate(${view.x},${view.y}) scale(${view.k})`);
		svg.classList.toggle("labels-hidden", view.k < 0.45);
		scheduleCull();
	}

	// ------------------------------------------------------------ cull scheduling
	// Pan/zoom and each sim tick both want to re-evaluate what's in the viewport,
	// but re-evaluating on every raw event thrashes. Coalesce into one pass per
	// animation frame. We track the pending rAF handle (not a sticky boolean):
	// a dropped frame — e.g. the tab is backgrounded, which pauses rAF — must not
	// wedge scheduling forever, so each call cancels any stale handle and arms a
	// fresh one. The handle is cleared inside the callback.
	let cullRaf = 0;
	function scheduleCull(): void {
		if (cullRaf) cancelAnimationFrame(cullRaf);
		cullRaf = requestAnimationFrame(() => {
			cullRaf = 0;
			cull();
		});
	}

	const toGraphCoords = (cx: number, cy: number): [number, number] => {
		const rect = svg.getBoundingClientRect();
		return [(cx - rect.left - view.x) / view.k, (cy - rect.top - view.y) / view.k];
	};

	// ------------------------------------------------------------ rendering

	function visibleGraph(): GraphPayload {
		const focus = focusId ? neighborhood(graph.edges, focusId, 2) : null;
		return filterGraph(graph, { types: new Set(enabledTypes), focus });
	}

	function renderGraph(): void {
		const { nodes, edges } = visibleGraph();
		empty = nodes.length === 0;

		const width = svg.clientWidth || 900;
		const height = svg.clientHeight || 600;

		const nodeList: SimNode[] = nodes.map((n) => {
			let sn = simNodes.get(n.id);
			if (!sn) {
				sn = { id: n.id, data: n, r: radiusFor(n.degree) };
				simNodes.set(n.id, sn);
			}
			sn.data = n;
			sn.r = radiusFor(n.degree);
			return sn;
		});
		const links: SimLink[] = edges.map((e) => ({
			source: e.from,
			target: e.to,
			relation: e.relation,
		}));

		// Restore saved anchors: pin dropped nodes to their remembered spots so the
		// free nodes lay out around them. Runs before the sim starts.
		anchors = loadAnchors();
		applyAnchors(nodeList, anchors);

		sim?.stop();
		simNodeList = nodeList;
		simLinks = links;
		// Layout tuning for visible separation without jitter or blow-up:
		//  - link distance 130 (was 85): edges hold nodes further apart.
		//  - charge -520 (was -320): stronger mutual repulsion opens up clusters.
		//  - collide r + 14 padding (was +6), strength 0.9, 2 iterations: a hard
		//    non-overlap constraint so circles never sit on top of each other.
		// Centering/x-y gravity kept gentle so small graphs don't collapse or fly.
		sim = forceSimulation<SimNode, SimLink>(nodeList)
			.force(
				"link",
				forceLink<SimNode, SimLink>(links)
					.id((d) => d.id)
					.distance(130)
					.strength(0.4),
			)
			.force("charge", forceManyBody().strength(-520).distanceMax(900))
			.force("center", forceCenter(width / 2, height / 2).strength(0.06))
			.force("x", forceX(width / 2).strength(0.045))
			.force("y", forceY(height / 2).strength(0.045))
			.force(
				"collide",
				forceCollide<SimNode>()
					.radius((d) => d.r + 14)
					.strength(0.9)
					.iterations(2),
			)
			.alpha(0.9)
			.alphaDecay(0.035)
			.on("tick", tick);

		// Reset the DOM pools; cull() (re)mounts only the in-view subset.
		edgesG.innerHTML = "";
		nodesG.innerHTML = "";
		nodeEls.clear();
		edgeEls.clear();
		// Drop hover state that references now-gone nodes.
		if (hovered && !simNodes.has(hovered)) hovered = null;
		cull();
	}

	const linkId = (end: SimLink["source"]): string =>
		typeof end === "object" ? end.id : String(end);

	// ------------------------------------------------------------ node/edge factories
	function makeNodeEl(sn: SimNode): SVGGElement {
		const g = document.createElementNS(SVG_NS, "g");
		g.classList.add("node");
		if (sn.data.pending) g.classList.add("pending");
		if (sn.id === selectedId) g.classList.add("selected");
		if (anchors[sn.id]) g.classList.add("pinned");
		g.dataset["id"] = sn.id;

		const circle = document.createElementNS(SVG_NS, "circle");
		circle.setAttribute("r", String(sn.r));
		circle.setAttribute("fill", TYPE_COLORS[sn.data.type] ?? TYPE_COLORS["pending"]!);

		const label = document.createElementNS(SVG_NS, "text");
		label.textContent = sn.data.title;
		label.setAttribute("dy", String(sn.r + 13));

		const title = document.createElementNS(SVG_NS, "title");
		title.textContent = `${sn.data.title} (${sn.data.type}${sn.data.pending ? ", pending" : ""})`;

		g.append(circle, label, title);
		attachNodeEvents(g, sn);
		return g;
	}

	function makeEdgeEl(link: SimLink): SVGLineElement {
		const line = document.createElementNS(SVG_NS, "line");
		if (link.relation !== "references") line.classList.add("typed");
		line.addEventListener("pointerenter", (ev) => showTooltip(ev, link.relation));
		line.addEventListener("pointermove", (ev) => showTooltip(ev, link.relation));
		line.addEventListener("pointerleave", hideTooltip);
		return line;
	}

	// ------------------------------------------------------------ viewport culling
	// Reconcile the DOM (nodeEls / edgeEls) so it holds exactly the nodes whose
	// current post-force position is inside the viewport, plus the edges among
	// them and "stub" edges pointing off-screen. Off-screen node elements and
	// off-to-off edges are REMOVED from the DOM entirely (not CSS-hidden).
	function cull(): void {
		if (!nodesG || !edgesG) return;
		const rect = svg.getBoundingClientRect();
		const positioned: PositionedNode[] = simNodeList.map((sn) => ({
			id: sn.id,
			x: sn.x ?? 0,
			y: sn.y ?? 0,
			r: sn.r,
		}));
		const visibleIds = nodesInViewport(positioned, view, rect, CULL_MARGIN);
		const allIds = new Set(simNodeList.map((sn) => sn.id));

		// --- nodes: mount newly-visible, drop newly-hidden.
		for (const sn of simNodeList) {
			const inView = visibleIds.has(sn.id);
			const el = nodeEls.get(sn.id);
			if (inView && !el) {
				const g = makeNodeEl(sn);
				nodesG.append(g);
				nodeEls.set(sn.id, g);
			} else if (!inView && el) {
				el.remove();
				nodeEls.delete(sn.id);
			}
		}

		// --- edges: full (both in view) or stub (anchor in view, points off).
		const edgeList: Edge[] = simLinks.map((l) => ({
			from: linkId(l.source),
			to: linkId(l.target),
			relation: l.relation,
		}));
		const plans = planEdges(edgeList, visibleIds, allIds);
		const wanted = new Set(plans.map((p) => edgeKey(p.edge)));

		for (const [key, entry] of edgeEls) {
			if (!wanted.has(key)) {
				entry.el.remove();
				edgeEls.delete(key);
			}
		}
		// simLinks and edgeList share indices (edgeList is a 1:1 map of simLinks);
		// build a key→SimLink lookup so a plan can recover its source SimLink.
		const linkByKey = new Map<string, SimLink>();
		for (let i = 0; i < simLinks.length; i++) linkByKey.set(edgeKey(edgeList[i]!), simLinks[i]!);

		for (const plan of plans) {
			const key = edgeKey(plan.edge);
			let entry = edgeEls.get(key);
			if (!entry) {
				const src = linkByKey.get(key);
				if (!src) continue;
				const el = makeEdgeEl(src);
				edgesG.append(el);
				entry = { el, link: src, plan };
				edgeEls.set(key, entry);
			} else {
				entry.plan = plan;
			}
			entry.el.classList.toggle("stub", plan.stub);
		}

		reapplyHover();
		positionElements();
	}

	function positionElements(): void {
		for (const { el, link, plan } of edgeEls.values()) {
			const s = link.source as SimNode;
			const t = link.target as SimNode;
			if (typeof s !== "object" || typeof t !== "object") continue;
			// Orient the line from the on-screen anchor toward the other end. For a
			// stub the "toward" end is off-screen; we keep the real geometry but the
			// visible-node end is trimmed to its circle border.
			const sx = s.x ?? 0;
			const sy = s.y ?? 0;
			const tx = t.x ?? 0;
			const ty = t.y ?? 0;
			const dx = tx - sx;
			const dy = ty - sy;
			const dist = Math.hypot(dx, dy) || 1;
			const ux = dx / dist;
			const uy = dy / dist;
			// Trim ends so lines meet circle borders and arrowheads stay visible.
			// A stub's off-screen end isn't drawn to the node border (its node is
			// gone) — but trimming by that node's radius is still correct geometry.
			el.setAttribute("x1", String(sx + ux * (s.r + 1)));
			el.setAttribute("y1", String(sy + uy * (s.r + 1)));
			el.setAttribute("x2", String(tx - ux * (t.r + 3)));
			el.setAttribute("y2", String(ty - uy * (t.r + 3)));
			void plan;
		}
		for (const [id, g] of nodeEls) {
			const sn = simNodes.get(id);
			if (sn) g.setAttribute("transform", `translate(${sn.x ?? 0},${sn.y ?? 0})`);
		}
	}

	function tick(): void {
		positionElements();
		// Nodes drift across the viewport boundary as the layout settles — keep the
		// mounted set in sync (throttled to one pass per frame).
		scheduleCull();
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
	// (called on hover changes AND after each cull, so re-mounted neighbours
	// pick up their highlight classes).
	function reapplyHover(): void {
		if (hovered === null) {
			svg.classList.remove("hovering");
			for (const g of nodeEls.values()) g.classList.remove("active", "nbr");
			for (const { el } of edgeEls.values()) el.classList.remove("hl");
			return;
		}
		svg.classList.add("hovering");
		const nbrs = neighborhood(graph.edges, hovered, 1);
		for (const [nid, g] of nodeEls) {
			g.classList.toggle("active", nid === hovered);
			g.classList.toggle("nbr", nid !== hovered && nbrs.has(nid));
		}
		for (const { el, link } of edgeEls.values()) {
			el.classList.toggle("hl", linkId(link.source) === hovered || linkId(link.target) === hovered);
		}
	}

	// ------------------------------------------------- node drag + click

	function attachNodeEvents(g: SVGGElement, sn: SimNode): void {
		g.addEventListener("pointerenter", () => setHover(sn.id));
		g.addEventListener("pointerleave", () => setHover(null));

		g.addEventListener("pointerdown", (ev) => {
			ev.stopPropagation();
			g.setPointerCapture(ev.pointerId);
			const start = [ev.clientX, ev.clientY];
			let moved = false;

			const onMove = (mv: PointerEvent): void => {
				if (!moved && Math.hypot(mv.clientX - start[0]!, mv.clientY - start[1]!) < 4) return;
				if (!moved) {
					moved = true;
					sim?.alphaTarget(0.3).restart();
				}
				const [gx, gy] = toGraphCoords(mv.clientX, mv.clientY);
				sn.fx = gx;
				sn.fy = gy;
			};
			const onUp = (): void => {
				g.removeEventListener("pointermove", onMove);
				g.removeEventListener("pointerup", onUp);
				g.removeEventListener("pointercancel", onUp);
				if (moved) {
					sim?.alphaTarget(0);
					// ANCHOR: keep fx/fy set (do NOT clear) so the node stays pinned
					// at its drop point, then persist it per-vault.
					const ax = sn.fx ?? sn.x ?? 0;
					const ay = sn.fy ?? sn.y ?? 0;
					sn.fx = ax;
					sn.fy = ay;
					anchors = setAnchor(anchors, sn.id, { x: ax, y: ay });
					saveAnchors();
					g.classList.add("pinned");
				} else {
					onselect(sn.id);
				}
			};
			g.addEventListener("pointermove", onMove);
			g.addEventListener("pointerup", onUp);
			g.addEventListener("pointercancel", onUp);
		});
	}

	// ------------------------------------------------------------ pan + zoom

	function onSvgPointerDown(ev: PointerEvent): void {
		if (ev.button !== 0) return;
		svg.classList.add("panning");
		svg.setPointerCapture(ev.pointerId);
		let [px, py] = [ev.clientX, ev.clientY];
		const onMove = (mv: PointerEvent): void => {
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
	}

	/**
	 * Reset the layout (exported: the "Reset graph" control calls via bind:this).
	 * Clears every persisted anchor for this vault, un-pins all nodes (fx/fy) so
	 * they're free again, then re-runs the force sim from scratch. Type prefs are
	 * reset by the parent (+page.svelte) alongside this.
	 */
	export function resetGraph(): void {
		anchors = {};
		if (typeof localStorage !== "undefined") {
			try {
				localStorage.removeItem(anchorStorageKey(vaultId));
			} catch {
				/* ignore storage errors */
			}
		}
		// Un-pin the live sim nodes and drop the pinned cue from mounted elements.
		clearAnchorsFromNodes(simNodeList);
		for (const g of nodeEls.values()) g.classList.remove("pinned");
		// Re-layout from scratch.
		renderGraph();
	}

	/** Pan/zoom so `id` is centered (exported: parents call via bind:this). */
	export function panTo(id: string): void {
		const sn = simNodes.get(id);
		if (!sn) return;
		const rect = svg.getBoundingClientRect();
		const targetK = Math.max(view.k, 1);
		const tx = rect.width / 2 - (sn.x ?? 0) * targetK;
		const ty = rect.height / 2 - (sn.y ?? 0) * targetK;
		animateView(tx, ty, targetK);
	}

	function animateView(tx: number, ty: number, tk: number): void {
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
		};
		requestAnimationFrame(step);
	}

	// ------------------------------------------------------------ lifecycle

	$effect(() => {
		// One-time SVG scaffolding (defs + viewport groups).
		// Obsidian-style glow: each circle blurs a copy of itself in its own
		// fill color (feGaussianBlur on SourceGraphic), so every node type
		// halos in its palette hue with no per-color filter plumbing.
		svg.innerHTML = `
			<defs>
				<marker id="arrow" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse">
					<path d="M0,1 L9,5 L0,9 Z" fill="#3a3a44"></path>
				</marker>
				<marker id="arrow-hl" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse">
					<path d="M0,1 L9,5 L0,9 Z" fill="#a78bfa"></path>
				</marker>
				<filter id="node-glow" x="-80%" y="-80%" width="260%" height="260%">
					<feGaussianBlur in="SourceGraphic" stdDeviation="2.2" result="halo"></feGaussianBlur>
					<feComponentTransfer in="halo" result="softHalo">
						<feFuncA type="linear" slope="0.55"></feFuncA>
					</feComponentTransfer>
					<feMerge>
						<feMergeNode in="softHalo"></feMergeNode>
						<feMergeNode in="SourceGraphic"></feMergeNode>
					</feMerge>
				</filter>
				<filter id="node-glow-strong" x="-150%" y="-150%" width="400%" height="400%">
					<feGaussianBlur in="SourceGraphic" stdDeviation="5.5" result="halo"></feGaussianBlur>
					<feMerge>
						<feMergeNode in="halo"></feMergeNode>
						<feMergeNode in="SourceGraphic"></feMergeNode>
					</feMerge>
				</filter>
			</defs>`;
		viewport = document.createElementNS(SVG_NS, "g");
		edgesG = document.createElementNS(SVG_NS, "g");
		nodesG = document.createElementNS(SVG_NS, "g");
		viewport.append(edgesG, nodesG);
		svg.append(viewport);
		applyView();

		let resizeTimer: ReturnType<typeof setTimeout> | null = null;
		const onResize = (): void => {
			if (resizeTimer) clearTimeout(resizeTimer);
			resizeTimer = setTimeout(renderGraph, 200);
		};
		window.addEventListener("resize", onResize);
		return () => {
			window.removeEventListener("resize", onResize);
			sim?.stop();
		};
	});

	// Re-render whenever the data or filters change.
	$effect(() => {
		void graph;
		void enabledTypes;
		void focusId;
		renderGraph();
	});

	// Selection highlight only (no relayout).
	$effect(() => {
		for (const [nid, g] of nodeEls) g.classList.toggle("selected", nid === selectedId);
	});
</script>

<div class="wrap">
	<svg bind:this={svg} onpointerdown={onSvgPointerDown} onwheel={onWheel} role="application" aria-label="Concept graph"></svg>
	{#if empty}
		<div class="empty-hint">No nodes match the current filters.</div>
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
	svg :global(line) {
		stroke: var(--edge);
		stroke-width: 1;
		stroke-linecap: round;
		opacity: 0.85;
	}
	svg :global(line.typed) {
		marker-end: url(#arrow);
	}
	svg :global(line.hl) {
		stroke: var(--accent);
		stroke-width: 1.6;
	}
	svg :global(line.typed.hl) {
		marker-end: url(#arrow-hl);
	}

	svg :global(g.node) {
		cursor: pointer;
	}
	svg :global(g.node circle) {
		stroke: rgb(255 255 255 / 0.12);
		stroke-width: 1;
		filter: url(#node-glow);
		transition: opacity 120ms ease;
	}
	svg :global(g.node.pending circle) {
		fill-opacity: 0.3;
		stroke: var(--node-pending, #6b7280);
		stroke-dasharray: 3 3;
		filter: none;
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
	svg :global(g.node.selected circle) {
		stroke: var(--accent);
		stroke-width: 2;
		filter: url(#node-glow-strong);
	}
	svg :global(g.node.selected text) {
		fill: var(--text);
	}

	/* Pinned (anchored) nodes read as fixed: a subtle dashed ring in the accent
	   hue that doesn't overpower the selected/hover states. */
	svg :global(g.node.pinned circle) {
		stroke: var(--accent);
		stroke-width: 1.5;
		stroke-dasharray: 2 2;
	}

	/* Hover: halo the hovered node, dim everything outside its neighborhood. */
	svg :global(g.node.active circle) {
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
	svg:global(.hovering) :global(line) {
		opacity: 0.12;
	}
	svg:global(.hovering) :global(line.hl) {
		opacity: 1;
	}
</style>
