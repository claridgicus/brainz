<script lang="ts">
	// Feature tree: the project's state as one top-down node tree, domain →
	// epic → feature (→ sub-feature) → task, each node coloured by the roll-up
	// of the tasks under it (SPEC-CLOUD.md "Feature tree"). The model, layout
	// and culling are pure ($lib/feature-tree); this component renders the
	// on-screen part as SVG, pans/zooms it and polls like the board.
	import type { ApiConcept, GraphNode, GraphPayload, TaskMeta } from "@brainz/contracts";
	import { ApiError, createApi } from "$lib/api";
	import { TYPE_COLORS } from "$lib/graph-data";
	import { vaultTabLinks } from "$lib/nav";
	import {
		DEFAULT_LAYOUT,
		type Orientation,
		type PlacedNode,
		type TreeNode,
		UNPLACED,
		boardHrefFor,
		buildFeatureTree,
		clip,
		cullLayout,
		defaultExpanded,
		expandableIds,
		layoutTree,
		linkPath,
	} from "$lib/feature-tree";
	import ConceptPanel from "$lib/components/ConceptPanel.svelte";
	import Mark from "$lib/components/Mark.svelte";
	import { onMount } from "svelte";
	import { hasTaskMiss, titleForIn } from "../board/board-lanes";

	let { data } = $props();
	const api = createApi(fetch);
	const vault = $derived(data.vault);

	// svelte-ignore state_referenced_locally
	let tasks = $state<TaskMeta[]>(data.tasks);
	// svelte-ignore state_referenced_locally
	let graph = $state<GraphPayload>(data.graph);
	$effect(() => {
		tasks = data.tasks;
		graph = data.graph;
	});
	const titleFor = (id: string): string => titleForIn(graph, id);

	// ------------------------------------------------------------ the tree
	const tree = $derived(buildFeatureTree(graph, tasks));
	let orientation = $state<Orientation>("tb");
	// Deep levels start collapsed so a big vault opens small; nodes that
	// appear later start collapsed too.
	// svelte-ignore state_referenced_locally
	let expanded = $state<Set<string>>(defaultExpanded(buildFeatureTree(data.graph, data.tasks)));
	const opts = $derived({ ...DEFAULT_LAYOUT, orientation });
	const layout = $derived(layoutTree(tree, expanded, opts));
	const placedById = $derived(new Map(layout.nodes.map((n) => [n.id, n])));

	function toggle(id: string) {
		const next = new Set(expanded);
		if (next.has(id)) next.delete(id);
		else next.add(id);
		expanded = next;
	}
	function expandAll() {
		expanded = expandableIds(tree);
	}
	function collapseAll() {
		expanded = new Set();
	}

	const taskTotals = $derived.by(() => {
		let done = 0;
		for (const t of tasks) if ((t.taskStatus ?? "open") === "done") done++;
		return { done, total: tasks.length };
	});

	// ------------------------------------------------------- pan, zoom, cull
	// Server render has no viewport, so it lays out against a typical one.
	let vw = $state(1200);
	let vh = $state(720);
	let k = $state(1);
	let tx = $state(24);
	let ty = $state(24);
	const PAD = 24;
	const MIN_K = 0.08;
	const MAX_K = 2.5;
	/** Below this zoom nodes drop their text (level of detail). */
	const LOD_K = 0.45;
	// Cull against the viewport in tree coordinates, with a margin so panning
	// doesn't pop nodes in at the edge.
	const view = $derived({
		x: -tx / k - 200,
		y: -ty / k - 200,
		w: vw / k + 400,
		h: vh / k + 400,
	});
	const culled = $derived(cullLayout(layout, view, opts));

	/**
	 * Frame the tree. The Fit button shows all of it however small; the first
	 * paint and an orientation switch (`readable`) keep the text legible and
	 * start at the top-left when it doesn't fit.
	 */
	function fit(readable = false) {
		if (layout.width === 0 || layout.height === 0) return;
		const z = Math.min((vw - 2 * PAD) / layout.width, (vh - 2 * PAD) / layout.height);
		k = Math.max(readable ? 0.6 : MIN_K, Math.min(1, z));
		tx = Math.max(PAD, (vw - layout.width * k) / 2);
		ty = orientation === "lr" ? Math.max(PAD, (vh - layout.height * k) / 2) : PAD;
	}
	function setOrientation(o: Orientation) {
		orientation = o;
		fit(true);
	}
	function zoomAt(px: number, py: number, factor: number) {
		const nk = Math.max(MIN_K, Math.min(MAX_K, k * factor));
		tx = px - ((px - tx) * nk) / k;
		ty = py - ((py - ty) * nk) / k;
		k = nk;
	}

	let svgEl = $state<SVGSVGElement | null>(null);
	let drag: { x: number; y: number; tx: number; ty: number; id: number; captured: boolean } | null = null;
	/** True when the last pointer gesture panned, so its click is not a node click. */
	let panned = false;
	function onPointerDown(e: PointerEvent) {
		if (e.button !== 0) return;
		drag = { x: e.clientX, y: e.clientY, tx, ty, id: e.pointerId, captured: false };
		panned = false;
	}
	function onPointerMove(e: PointerEvent) {
		if (!drag || e.pointerId !== drag.id) return;
		const dx = e.clientX - drag.x;
		const dy = e.clientY - drag.y;
		if (!drag.captured) {
			if (Math.hypot(dx, dy) < 4) return;
			// Capture only once it is a pan, so a plain click still reaches the node.
			svgEl?.setPointerCapture(e.pointerId);
			drag.captured = true;
			panned = true;
		}
		tx = drag.tx + dx;
		ty = drag.ty + dy;
	}
	function onPointerUp(e: PointerEvent) {
		if (drag?.captured) svgEl?.releasePointerCapture(e.pointerId);
		drag = null;
	}

	// ----------------------------------------------------------- real-time
	// The board's cadence (pattern-optimistic-poll): tasks every 4s, the graph
	// every 6 ticks, or at once when a task isn't in the graph yet.
	const POLL_MS = 4000;
	const GRAPH_EVERY = 6;
	let tick = 0;
	let graphInFlight = false;
	async function refreshGraph() {
		if (graphInFlight) return;
		graphInFlight = true;
		try {
			const next = await api.graph(vault.id);
			if (JSON.stringify(next) !== JSON.stringify(graph)) graph = next;
		} catch {
			/* keep the last good graph */
		} finally {
			graphInFlight = false;
		}
	}
	async function poll() {
		try {
			const next = await api.listTasks(vault.id);
			if (JSON.stringify(next) !== JSON.stringify(tasks)) tasks = next;
		} catch {
			/* keep the last good pile */
		}
		tick++;
		if (tick % GRAPH_EVERY === 0 || hasTaskMiss(tasks, graph)) void refreshGraph();
	}

	let hydrated = $state(false);
	onMount(() => {
		hydrated = true;
		fit(true);
		// Wheel zoom needs a non-passive listener to stop the page scrolling.
		const onWheel = (e: WheelEvent) => {
			e.preventDefault();
			const r = svgEl!.getBoundingClientRect();
			zoomAt(e.clientX - r.left, e.clientY - r.top, Math.exp(-e.deltaY * 0.0015));
		};
		svgEl?.addEventListener("wheel", onWheel, { passive: false });
		const timer = setInterval(poll, POLL_MS);
		return () => {
			clearInterval(timer);
			svgEl?.removeEventListener("wheel", onWheel);
		};
	});

	// ------------------------------------------------------- side panel
	let selectedId = $state<string | null>(null);
	let hoverId = $state<string | null>(null);
	let concept = $state<ApiConcept | null>(null);
	let conceptLoading = $state(false);
	let conceptError = $state<string | null>(null);

	const selectedNode = $derived.by((): GraphNode | null => {
		if (!selectedId) return null;
		const g = graph.nodes.find((n) => n.id === selectedId);
		if (g) return g;
		const t = tasks.find((x) => x.id === selectedId);
		return t ? { id: t.id, title: t.title, type: "task", tags: t.tags, degree: 0 } : null;
	});
	const selectedEdges = $derived({
		outgoing: selectedId ? graph.edges.filter((e) => e.from === selectedId) : [],
		incoming: selectedId ? graph.edges.filter((e) => e.to === selectedId) : [],
	});

	async function openNode(id: string) {
		if (id === UNPLACED) {
			toggle(id);
			return;
		}
		selectedId = id;
		concept = null;
		conceptError = null;
		conceptLoading = true;
		try {
			const loaded = await api.getConcept(vault.id, id);
			if (selectedId === id) concept = loaded;
		} catch (err) {
			if (selectedId === id)
				conceptError = err instanceof ApiError ? err.message : "Failed to load the concept.";
		} finally {
			if (selectedId === id) conceptLoading = false;
		}
	}
	function closePanel() {
		selectedId = null;
		concept = null;
	}
	function gotoGraph(id: string) {
		window.location.href = `/v/${vault.slug}?focus=${encodeURIComponent(id)}`;
	}

	// Ghost edges: the hovered (else selected) node's other parents.
	const ghosts = $derived.by((): { from: PlacedNode; to: PlacedNode }[] => {
		const id = hoverId ?? selectedId;
		const at = id ? placedById.get(id) : undefined;
		const node = id ? tree.nodes.get(id) : undefined;
		if (!at || !node) return [];
		return node.otherParents
			.map((p) => placedById.get(p))
			.filter((p): p is PlacedNode => p !== undefined)
			.map((p) => ({ from: p, to: at }));
	});

	const STATE_LABEL: Record<TreeNode["state"], string> = {
		empty: "No tasks",
		"not-started": "Not started",
		"in-progress": "In progress",
		done: "Done",
		blocked: "Blocked",
	};
	const LEGEND: TreeNode["state"][] = ["not-started", "in-progress", "done", "blocked", "empty"];
	function metaLine(n: TreeNode): string {
		if (n.task) {
			const parts: string[] = [n.task.status];
			if (n.task.takenBy && n.task.status !== "open") parts.push(n.task.takenBy);
			if (n.task.blocked) parts.push("blocked");
			return parts.join(" · ");
		}
		const r = n.rollup;
		if (r.total === 0) return `${n.type === "unplaced" ? "orphans" : n.type} · no tasks`;
		let s = `${n.type === "unplaced" ? "orphans" : n.type} · ${r.done}/${r.total} done`;
		if (r.taken > 0) s += ` · ${r.taken} taken`;
		if (r.blocked > 0) s += ` · ${r.blocked} blocked`;
		return s;
	}
	const typeColor = (type: string): string => TYPE_COLORS[type] ?? "var(--text-dim)";
	const W = DEFAULT_LAYOUT.nodeW;
	const H = DEFAULT_LAYOUT.nodeH;
	const BAR = W - 24;
</script>

<svelte:head><title>Features — {vault.name} — Brainz</title></svelte:head>

<div class="ft-page" data-hydrated={hydrated ? "true" : "false"}>
	<div class="toolbar">
		<div class="left">
			<h1>{vault.name} · Features</h1>
			{#each vaultTabLinks(vault.slug, "features") as link (link.href)}
				<a class="btn btn-ghost btn-sm" href={link.href}>{link.label}</a>
			{/each}
		</div>
		<div class="controls" role="group" aria-label="Tree layout">
			<button
				type="button"
				class="chip"
				class:on={orientation === "tb"}
				aria-pressed={orientation === "tb"}
				disabled={!hydrated}
				onclick={() => setOrientation("tb")}>Top-down</button
			>
			<button
				type="button"
				class="chip"
				class:on={orientation === "lr"}
				aria-pressed={orientation === "lr"}
				disabled={!hydrated}
				onclick={() => setOrientation("lr")}>Left-right</button
			>
			<button type="button" class="chip" disabled={!hydrated} onclick={expandAll}>Expand all</button>
			<button type="button" class="chip" disabled={!hydrated} onclick={collapseAll}>Collapse all</button>
			<button type="button" class="chip" disabled={!hydrated} onclick={() => fit()}>Fit</button>
		</div>
		<ul class="legend" aria-label="Node states">
			{#each LEGEND as st (st)}
				<li><span class="swatch st-{st}"></span>{STATE_LABEL[st]}</li>
			{/each}
		</ul>
		<div class="right">
			<span class="count" data-testid="ft-count"
				>{taskTotals.done}/{taskTotals.total} tasks done</span
			>
			<span class="live" title="Live — polling every 4s">● live</span>
		</div>
	</div>

	{#if tree.roots.length === 0}
		<div class="empty">
			<div class="mark" aria-hidden="true"><Mark size={40} /></div>
			<h2>Nothing to chart yet</h2>
			<p class="muted">
				The tree grows from domains, epics, features and tasks linked with <code>part_of</code> /
				<code>realizes</code>. Onboard the codebase or file tasks with <code>create_task</code> and
				they appear here.
			</p>
		</div>
	{:else}
		<div class="canvas" bind:clientWidth={vw} bind:clientHeight={vh}>
			<svg
				bind:this={svgEl}
				class="tree"
				class:lod={k < LOD_K}
				role="tree"
				tabindex="-1"
				aria-label="Feature tree"
				onpointerdown={onPointerDown}
				onpointermove={onPointerMove}
				onpointerup={onPointerUp}
				onpointercancel={onPointerUp}
			>
				<g transform="translate({tx},{ty}) scale({k})">
					<g class="links">
						{#each culled.links as l (l.from.id + ">" + l.to.id)}
							<path d={linkPath(l.from, l.to, opts)} />
						{/each}
					</g>
					<g class="ghosts">
						{#each ghosts as g (g.from.id)}
							<line x1={g.from.x} y1={g.from.y} x2={g.to.x} y2={g.to.y} />
						{/each}
					</g>
					{#each culled.nodes as p (p.id)}
						{@const n = tree.nodes.get(p.id)!}
						{@const open = expanded.has(n.id)}
						{@const r = n.rollup}
						<g
							class="node st-{n.state}"
							class:selected={selectedId === n.id}
							class:task={n.type === "task"}
							class:unplaced={n.id === UNPLACED}
							transform="translate({p.x - W / 2},{p.y - H / 2})"
							data-id={n.id}
							data-state={n.state}
							role="treeitem"
							aria-selected={selectedId === n.id}
							aria-expanded={n.children.length > 0 ? open : undefined}
							aria-label="{n.title}: {STATE_LABEL[n.state]}, {metaLine(n)}"
							tabindex="0"
							onclick={() => !panned && void openNode(n.id)}
							onkeydown={(e) => {
								if (e.key === "Enter") void openNode(n.id);
								else if (e.key === " " && n.children.length > 0) {
									e.preventDefault();
									toggle(n.id);
								}
							}}
							onpointerenter={() => (hoverId = n.id)}
							onpointerleave={() => hoverId === n.id && (hoverId = null)}
						>
							<title>{n.title}</title>
							<rect class="box" width={W} height={H} rx="8" />
							<rect class="stripe" width="4" height={H} rx="2" fill={typeColor(n.type)} />
							{#if k >= LOD_K}
								<text class="title" x="14" y="22">{clip(n.title, n.task ? 24 : 27)}</text>
								<text class="meta" x="14" y="40">{clip(metaLine(n), 34)}</text>
								{#if !n.task}
									<rect class="bar-bg" x="12" y={H - 13} width={BAR} height="4" rx="2" />
									{#if r.total > 0}
										<rect class="bar-done" x="12" y={H - 13} width={(r.done / r.total) * BAR} height="4" rx="2" />
										<rect
											class="bar-taken"
											x={12 + (r.done / r.total) * BAR}
											y={H - 13}
											width={(r.taken / r.total) * BAR}
											height="4"
										/>
									{/if}
								{:else}
									<circle class="status-dot s-{n.task.status}" cx={W - 16} cy="20" r="5" />
								{/if}
								{#if n.otherParents.length > 0}
									<g class="badge" transform="translate({W - 34},{H - 24})">
										<title>Also under: {n.otherParents.map(titleFor).join(", ")}</title>
										<rect width="26" height="15" rx="7" />
										<text x="13" y="11">+{n.otherParents.length}</text>
									</g>
								{/if}
							{/if}
							{#if n.children.length > 0}
								<g
									class="toggle"
									transform={orientation === "tb" ? `translate(${W / 2},${H})` : `translate(${W},${H / 2})`}
									role="button"
									tabindex="-1"
									aria-label="{open ? 'Collapse' : 'Expand'} {n.title}"
									onclick={(e) => {
										e.stopPropagation();
										if (!panned) toggle(n.id);
									}}
									onkeydown={() => {}}
								>
									<circle r="10" />
									<text y="3.5">{open ? "−" : n.children.length > 99 ? "99+" : n.children.length}</text>
								</g>
							{/if}
						</g>
					{/each}
				</g>
			</svg>
			<p class="hint muted">Drag to pan · scroll to zoom · click a node for details</p>
		</div>
	{/if}
</div>

{#if selectedNode}
	<div class="panel-overlay" role="dialog" aria-modal="true">
		<button class="panel-scrim" aria-label="Close" onclick={closePanel}></button>
		<div class="panel-host">
			<div class="panel-actions">
				<a class="btn btn-sm" href={boardHrefFor(vault.slug, selectedNode.id)}>Show on board</a>
				<a class="btn btn-ghost btn-sm" href="/v/{vault.slug}?focus={encodeURIComponent(selectedNode.id)}"
					>Open in graph</a
				>
			</div>
			<ConceptPanel
				node={selectedNode}
				{concept}
				loading={conceptLoading}
				error={conceptError}
				edges={selectedEdges}
				{titleFor}
				readonly={true}
				focused={false}
				onfocustoggle={() => {}}
				onnavigate={(id) => void openNode(id)}
				onedit={() => gotoGraph(selectedNode.id)}
				ondelete={() => {}}
				onclose={closePanel}
			/>
		</div>
	</div>
{/if}

<style>
	.ft-page {
		--st-empty: #3f3f46;
		--st-not-started: #8b8b97;
		--st-in-progress: #60a5fa;
		--st-done: #34d399;
		--st-blocked: #f87171;
		display: flex;
		flex-direction: column;
		height: 100%;
		padding: 16px 20px 20px;
		overflow: hidden;
	}
	.toolbar {
		display: flex;
		align-items: center;
		gap: 14px;
		flex-wrap: wrap;
		margin-bottom: 12px;
	}
	.left {
		display: flex;
		align-items: center;
		gap: 10px;
	}
	.left h1 {
		font-size: 18px;
		margin: 0;
	}
	.controls {
		display: flex;
		gap: 6px;
		flex-wrap: wrap;
	}
	.chip {
		font-size: 12px;
		padding: 4px 10px;
		border-radius: 999px;
		border: 1px solid var(--border-strong);
		background: transparent;
		color: var(--text-dim);
		cursor: pointer;
	}
	.chip.on {
		background: var(--accent-soft);
		border-color: var(--accent);
		color: var(--text);
	}
	.chip:disabled {
		opacity: 0.5;
		cursor: default;
	}
	.legend {
		display: flex;
		gap: 12px;
		list-style: none;
		margin: 0;
		padding: 0;
		font-size: 12px;
		color: var(--text-dim);
		flex-wrap: wrap;
	}
	.legend li {
		display: inline-flex;
		align-items: center;
		gap: 5px;
	}
	.swatch {
		width: 10px;
		height: 10px;
		border-radius: 3px;
		border: 2px solid var(--st);
	}
	.right {
		margin-left: auto;
		display: flex;
		gap: 12px;
		font-size: 12px;
		color: var(--text-dim);
	}
	.canvas {
		position: relative;
		flex: 1;
		min-height: 0;
		background: var(--bg-deep);
		border: 1px solid var(--border);
		border-radius: 10px;
		overflow: hidden;
	}
	.tree {
		display: block;
		width: 100%;
		height: 100%;
		cursor: grab;
		touch-action: none;
		user-select: none;
	}
	.tree:active {
		cursor: grabbing;
	}
	.links path {
		fill: none;
		stroke: var(--border-strong);
		stroke-width: 1.5;
	}
	.ghosts line {
		stroke: var(--accent);
		stroke-width: 1.5;
		stroke-dasharray: 5 5;
		opacity: 0.8;
	}
	.st-empty {
		--st: var(--st-empty);
	}
	.st-not-started {
		--st: var(--st-not-started);
	}
	.st-in-progress {
		--st: var(--st-in-progress);
	}
	.st-done {
		--st: var(--st-done);
	}
	.st-blocked {
		--st: var(--st-blocked);
	}
	.node {
		cursor: pointer;
		outline: none;
	}
	.node .box {
		fill: var(--bg-raised);
		stroke: var(--st);
		stroke-width: 1.5;
	}
	.node.unplaced .box {
		stroke-dasharray: 6 4;
	}
	.node:hover .box,
	.node:focus-visible .box {
		fill: var(--bg-overlay);
	}
	.node.selected .box {
		stroke: var(--accent);
		stroke-width: 2.5;
	}
	.tree.lod .node .box {
		fill: color-mix(in srgb, var(--st) 35%, var(--bg-raised));
	}
	/* Text never takes the pointer: clicks land on the box or the toggle. */
	.node text {
		pointer-events: none;
	}
	.node .title {
		fill: var(--text);
		font-size: 13px;
		font-weight: 600;
	}
	.node .meta {
		fill: var(--text-dim);
		font-size: 11px;
	}
	.bar-bg {
		fill: var(--border);
	}
	.bar-done {
		fill: var(--st-done);
	}
	.bar-taken {
		fill: var(--st-in-progress);
	}
	.status-dot.s-open {
		fill: #f59e0b;
	}
	.status-dot.s-taken {
		fill: var(--st-in-progress);
	}
	.status-dot.s-done {
		fill: var(--st-done);
	}
	.badge rect {
		fill: var(--accent-soft);
		stroke: var(--accent);
	}
	.badge text {
		fill: var(--text);
		font-size: 10px;
		text-anchor: middle;
	}
	.toggle circle {
		fill: var(--bg-overlay);
		stroke: var(--border-strong);
	}
	.toggle:hover circle {
		stroke: var(--accent);
	}
	.toggle text {
		fill: var(--text);
		font-size: 10px;
		text-anchor: middle;
	}
	.hint {
		position: absolute;
		left: 12px;
		bottom: 8px;
		margin: 0;
		font-size: 11.5px;
		pointer-events: none;
	}
	.empty {
		margin: 60px auto;
		max-width: 460px;
		text-align: center;
	}
	.panel-overlay {
		position: fixed;
		inset: 0;
		z-index: 40;
		display: flex;
		justify-content: flex-end;
	}
	.panel-scrim {
		position: absolute;
		inset: 0;
		background: rgba(0, 0, 0, 0.45);
		border: none;
		cursor: pointer;
	}
	.panel-host {
		position: relative;
		width: min(420px, 92vw);
		height: 100%;
		display: flex;
		flex-direction: column;
	}
	.panel-actions {
		display: flex;
		gap: 8px;
		padding: 10px 14px;
		background: var(--bg-raised);
		border-left: 1px solid var(--border);
		border-bottom: 1px solid var(--border);
	}
	.panel-host :global(.panel) {
		flex: 1;
		min-height: 0;
	}
	@media (max-width: 720px) {
		.ft-page {
			padding: 12px 16px;
		}
		.legend {
			display: none;
		}
	}
</style>
