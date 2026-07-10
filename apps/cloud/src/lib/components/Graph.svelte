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
	import type { GraphNode, GraphPayload } from "@brainz/contracts";
	import { filterGraph, neighborhood, radiusFor, TYPE_COLORS } from "$lib/graph-data";

	interface SimNode extends SimulationNodeDatum {
		id: string;
		data: GraphNode;
		r: number;
	}
	type SimLink = SimulationLinkDatum<SimNode> & { relation: string };

	let {
		graph,
		enabledTypes,
		focusId = null,
		selectedId = null,
		onselect,
	}: {
		graph: GraphPayload;
		enabledTypes: string[];
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
	const nodeEls = new Map<string, SVGGElement>();
	const lineEls: { el: SVGLineElement; link: SimLink }[] = [];
	const view = { x: 0, y: 0, k: 1 };

	function applyView(): void {
		viewport.setAttribute("transform", `translate(${view.x},${view.y}) scale(${view.k})`);
		svg.classList.toggle("labels-hidden", view.k < 0.45);
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

		sim?.stop();
		sim = forceSimulation<SimNode, SimLink>(nodeList)
			.force(
				"link",
				forceLink<SimNode, SimLink>(links)
					.id((d) => d.id)
					.distance(85)
					.strength(0.4),
			)
			.force("charge", forceManyBody().strength(-320))
			.force("center", forceCenter(width / 2, height / 2).strength(0.06))
			.force("x", forceX(width / 2).strength(0.045))
			.force("y", forceY(height / 2).strength(0.045))
			.force("collide", forceCollide<SimNode>().radius((d) => d.r + 6))
			.alpha(0.9)
			.alphaDecay(0.035)
			.on("tick", tick);

		edgesG.innerHTML = "";
		nodesG.innerHTML = "";
		nodeEls.clear();
		lineEls.length = 0;

		for (const link of links) {
			const line = document.createElementNS(SVG_NS, "line");
			if (link.relation !== "references") line.classList.add("typed");
			line.addEventListener("pointerenter", (ev) => showTooltip(ev, link.relation));
			line.addEventListener("pointermove", (ev) => showTooltip(ev, link.relation));
			line.addEventListener("pointerleave", hideTooltip);
			edgesG.append(line);
			lineEls.push({ el: line, link });
		}

		for (const sn of nodeList) {
			const g = document.createElementNS(SVG_NS, "g");
			g.classList.add("node");
			if (sn.data.pending) g.classList.add("pending");
			if (sn.id === selectedId) g.classList.add("selected");
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
			nodesG.append(g);
			nodeEls.set(sn.id, g);
		}
		tick();
	}

	const linkId = (end: SimLink["source"]): string =>
		typeof end === "object" ? end.id : String(end);

	function tick(): void {
		for (const { el, link } of lineEls) {
			const s = link.source as SimNode;
			const t = link.target as SimNode;
			if (typeof s !== "object" || typeof t !== "object") continue;
			const dx = (t.x ?? 0) - (s.x ?? 0);
			const dy = (t.y ?? 0) - (s.y ?? 0);
			const dist = Math.hypot(dx, dy) || 1;
			const ux = dx / dist;
			const uy = dy / dist;
			// Trim ends so lines meet circle borders and arrowheads stay visible.
			el.setAttribute("x1", String((s.x ?? 0) + ux * (s.r + 1)));
			el.setAttribute("y1", String((s.y ?? 0) + uy * (s.r + 1)));
			el.setAttribute("x2", String((t.x ?? 0) - ux * (t.r + 3)));
			el.setAttribute("y2", String((t.y ?? 0) - uy * (t.r + 3)));
		}
		for (const [id, g] of nodeEls) {
			const sn = simNodes.get(id);
			if (sn) g.setAttribute("transform", `translate(${sn.x ?? 0},${sn.y ?? 0})`);
		}
	}

	// ----------------------------------------------------- hover / tooltip

	function showTooltip(ev: PointerEvent, text: string): void {
		tooltip = { text, x: ev.clientX + 12, y: ev.clientY + 12, visible: true };
	}
	function hideTooltip(): void {
		tooltip = { ...tooltip, visible: false };
	}

	function setHover(id: string | null): void {
		if (id === null) {
			svg.classList.remove("hovering");
			for (const g of nodeEls.values()) g.classList.remove("active", "nbr");
			for (const { el } of lineEls) el.classList.remove("hl");
			return;
		}
		svg.classList.add("hovering");
		const nbrs = neighborhood(graph.edges, id, 1);
		for (const [nid, g] of nodeEls) {
			g.classList.toggle("active", nid === id);
			g.classList.toggle("nbr", nid !== id && nbrs.has(nid));
		}
		for (const { el, link } of lineEls) {
			el.classList.toggle("hl", linkId(link.source) === id || linkId(link.target) === id);
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
					sn.fx = null;
					sn.fy = null;
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
		svg.innerHTML = `
			<defs>
				<marker id="arrow" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse">
					<path d="M0,1 L9,5 L0,9 Z" fill="#3a4557"></path>
				</marker>
				<marker id="arrow-hl" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse">
					<path d="M0,1 L9,5 L0,9 Z" fill="#7fb4fb"></path>
				</marker>
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
		border: 1px solid var(--border);
		border-radius: 6px;
		padding: 3px 9px;
		font-size: 12px;
		color: var(--text);
		pointer-events: none;
		box-shadow: 0 4px 14px rgb(0 0 0 / 0.4);
	}

	/* Imperative SVG children need :global selectors. */
	svg :global(line) {
		stroke: var(--edge);
		stroke-width: 1.2;
	}
	svg :global(line.typed) {
		marker-end: url(#arrow);
	}
	svg :global(line.hl) {
		stroke: #7fb4fb;
		stroke-width: 1.8;
	}
	svg :global(line.typed.hl) {
		marker-end: url(#arrow-hl);
	}

	svg :global(g.node) {
		cursor: pointer;
	}
	svg :global(g.node circle) {
		stroke: rgb(255 255 255 / 0.18);
		stroke-width: 1;
		transition: opacity 120ms ease;
	}
	svg :global(g.node.pending circle) {
		fill-opacity: 0.35;
		stroke: #6b7280;
		stroke-dasharray: 3 3;
	}
	svg :global(g.node text) {
		fill: var(--text-dim);
		font-size: 11px;
		text-anchor: middle;
		pointer-events: none;
		user-select: none;
	}
	svg:global(.labels-hidden) :global(g.node text) {
		display: none;
	}
	svg :global(g.node.selected circle) {
		stroke: #fff;
		stroke-width: 2;
	}

	/* Hover: dim everything but the hovered node's neighborhood. */
	svg:global(.hovering) :global(g.node) {
		opacity: 0.25;
	}
	svg:global(.hovering) :global(g.node.active),
	svg:global(.hovering) :global(g.node.nbr) {
		opacity: 1;
	}
	svg:global(.hovering) :global(g.node.active text) {
		fill: var(--text);
	}
	svg:global(.hovering) :global(line) {
		opacity: 0.15;
	}
	svg:global(.hovering) :global(line.hl) {
		opacity: 1;
	}
</style>
