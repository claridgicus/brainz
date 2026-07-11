<script lang="ts">
	// Real-time Kanban board over the vault's task-type concepts.
	// Columns Open · Taken · Done (or swimlanes when grouped by concept /
	// priority / owner). Polls GET /tasks every 4s and diff-animates; card
	// moves issue take/complete/reopen mutations with an optimistic update.
	import type { ApiConcept, GraphNode, GraphPayload, TaskMeta } from "@brainz/contracts";
	import { ApiError, createApi, roleOf } from "$lib/api";
	import { TYPE_COLORS } from "$lib/graph-data";
	import ConceptPanel from "$lib/components/ConceptPanel.svelte";
	import { onMount } from "svelte";
	import {
		type GroupBy,
		type Lane,
		type Status,
		computeLanes,
		hasLaneMiss,
		statusOf as laneStatusOf,
		titleForIn,
	} from "./board-lanes";

	let { data } = $props();
	const api = createApi(fetch);
	const vault = $derived(data.vault);
	/** Viewers watch the board live but can't move cards (server enforces too). */
	const canEdit = $derived(roleOf(data.vault) !== "viewer");

	// svelte-ignore state_referenced_locally
	let tasks = $state<TaskMeta[]>(data.tasks);
	// svelte-ignore state_referenced_locally
	let graph = $state<GraphPayload>(data.graph);
	$effect(() => {
		tasks = data.tasks;
		graph = data.graph;
	});

	const statusOf = laneStatusOf;
	const titleFor = (id: string): string => titleForIn(graph, id);

	// ------------------------------------------------------------- grouping
	// Grouping/lane derivation is pure (./board-lanes) so it can be unit-tested.
	let groupBy = $state<GroupBy>("status");
	const lanes = $derived.by((): Lane[] => computeLanes(tasks, graph, groupBy));

	// ------------------------------------------------------------ real-time
	// Tasks poll fast (4s) for a live pile; the concept graph — the source of
	// lane labels and card-detail titles — is refreshed on a much lower cadence
	// (every GRAPH_EVERY task ticks ≈ 24s) so a renamed concept surfaces without
	// a full reload, without thrashing. A "lane miss" (a task references a
	// concept id absent from the current graph) forces an immediate refresh.
	const POLL_MS = 4000;
	const GRAPH_EVERY = 6; // 6 × 4s = 24s graph cadence
	let polling = $state(true);
	let tick = 0;
	let graphInFlight = false;

	async function refreshGraph() {
		if (graphInFlight) return;
		graphInFlight = true;
		try {
			const next = await api.graph(vault.id);
			// Only reassign on an actual change so the lanes/cards don't re-render
			// needlessly (labels/titles read straight off this reactive state).
			if (JSON.stringify(next) !== JSON.stringify(graph)) graph = next;
		} catch {
			/* keep the last good graph */
		} finally {
			graphInFlight = false;
		}
	}

	async function poll() {
		if (!polling) return;
		try {
			const next = await api.listTasks(vault.id);
			// Only replace when something actually changed (avoids re-anim churn).
			if (JSON.stringify(next) !== JSON.stringify(tasks)) tasks = next;
		} catch {
			/* keep the last good pile */
		}
		// Low-cadence graph refresh, or immediately if the pile now references a
		// concept the current graph doesn't know about (stale lane labels). SSR
		// already loaded the graph, so count first — the first periodic refresh
		// lands at GRAPH_EVERY ticks, not on the very next poll.
		tick++;
		if (tick % GRAPH_EVERY === 0 || hasLaneMiss(tasks, graph)) void refreshGraph();
	}
	onMount(() => {
		const timer = setInterval(poll, POLL_MS);
		return () => clearInterval(timer);
	});

	// ------------------------------------------------------------ mutations
	let error = $state<string | null>(null);
	let busyId = $state<string | null>(null);

	function applyOptimistic(id: string, patch: Partial<TaskMeta>) {
		tasks = tasks.map((t) => (t.id === id ? { ...t, ...patch } : t));
	}

	async function moveTo(task: TaskMeta, target: Status) {
		if (!canEdit) return;
		const from = statusOf(task);
		if (from === target) return;
		busyId = task.id;
		error = null;
		const snapshot = tasks;
		try {
			if (target === "taken") {
				applyOptimistic(task.id, { taskStatus: "taken", takenBy: "board" });
				const saved = await api.moveTask(vault.id, task.id, { action: "take" });
				applyOptimistic(task.id, saved);
			} else if (target === "done") {
				const outcome = window.prompt("Outcome — what got done?", "Completed from the board.");
				if (outcome === null) {
					busyId = null;
					return;
				}
				applyOptimistic(task.id, { taskStatus: "done" });
				const saved = await api.moveTask(vault.id, task.id, { action: "complete", outcome });
				applyOptimistic(task.id, saved);
			} else {
				applyOptimistic(task.id, { taskStatus: "open", takenBy: undefined });
				const saved = await api.moveTask(vault.id, task.id, { action: "reopen" });
				applyOptimistic(task.id, saved);
			}
		} catch (err) {
			tasks = snapshot; // roll back
			error = err instanceof ApiError ? err.message : "Move failed.";
		} finally {
			busyId = null;
		}
	}

	// ------------------------------------------------------- drag and drop
	let dragId = $state<string | null>(null);
	function onDrop(target: Status) {
		const id = dragId;
		dragId = null;
		if (!id) return;
		const task = tasks.find((t) => t.id === id);
		if (task) void moveTo(task, target);
	}

	// --------------------------------------------------------- card detail
	let selectedId = $state<string | null>(null);
	let concept = $state<ApiConcept | null>(null);
	let conceptLoading = $state(false);
	let conceptError = $state<string | null>(null);

	const selectedNode = $derived.by((): GraphNode | null => {
		if (!selectedId) return null;
		const t = tasks.find((x) => x.id === selectedId);
		const g = graph.nodes.find((n) => n.id === selectedId);
		if (g) return g;
		if (!t) return null;
		return { id: t.id, title: t.title, type: "task", tags: t.tags, degree: 0 };
	});
	const selectedEdges = $derived({
		outgoing: selectedId ? graph.edges.filter((e) => e.from === selectedId) : [],
		incoming: selectedId ? graph.edges.filter((e) => e.to === selectedId) : [],
	});

	async function openCard(id: string) {
		selectedId = id;
		concept = null;
		conceptError = null;
		conceptLoading = true;
		try {
			const loaded = await api.getConcept(vault.id, id);
			if (selectedId === id) concept = loaded;
		} catch (err) {
			if (selectedId === id)
				conceptError = err instanceof ApiError ? err.message : "Failed to load task.";
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

	const nextStatus: Record<Status, Status | null> = { open: "taken", taken: "done", done: null };
	const prevStatus: Record<Status, Status | null> = { open: null, taken: "open", done: "taken" };
</script>

<svelte:head><title>Board — {vault.name} — Brainz</title></svelte:head>

<div class="board-page">
	<div class="toolbar">
		<div class="left">
			<h1>{vault.name} · Board</h1>
			<a class="btn btn-ghost btn-sm" href="/v/{vault.slug}">Graph</a>
		</div>
		<div class="group-control" role="group" aria-label="Group by">
			<span class="glabel">Group by</span>
			{#each [["status", "Status"], ["concept", "Concept"], ["priority", "Priority"], ["takenBy", "Owner"]] as [val, label] (val)}
				<button
					type="button"
					class="chip"
					class:on={groupBy === val}
					onclick={() => (groupBy = val as GroupBy)}
				>
					{label}
				</button>
			{/each}
		</div>
		<div class="right">
			<span class="count">{tasks.length} {tasks.length === 1 ? "task" : "tasks"}</span>
			<span class="live" class:on={polling} title="Live — polling every 4s">● live</span>
		</div>
	</div>

	{#if error}<p class="error-text banner" role="alert">{error}</p>{/if}

	{#if tasks.length === 0}
		<div class="empty">
			<div class="mark" aria-hidden="true">&#x1F4A9;</div>
			<h2>No tasks yet</h2>
			<p class="muted">
				Tasks appear here when an agent files them (create_task over MCP) or takes work off the pile.
				Give your fleet the vault's MCP key and watch the board fill up.
			</p>
		</div>
	{:else}
		<div class="columns" class:swimlanes={groupBy !== "status"}>
			{#each lanes as lane (lane.id)}
				<section
					class="column"
					role="group"
					aria-label={lane.label}
					ondragover={(e) => lane.status && e.preventDefault()}
					ondrop={() => lane.status && onDrop(lane.status)}
					class:drop-target={lane.status && dragId !== null}
				>
					<header class="col-head">
						<span class="col-title status-{lane.status ?? 'group'}">{lane.label}</span>
						<span class="col-count">{lane.tasks.length}</span>
					</header>
					<div class="cards">
						{#each lane.tasks as task (task.id)}
							{@const st = statusOf(task)}
							<div
								class="card task-card status-{st}"
								class:busy={busyId === task.id}
								draggable={true}
								ondragstart={() => (dragId = task.id)}
								ondragend={() => (dragId = null)}
								role="button"
								tabindex="0"
								onclick={() => openCard(task.id)}
								onkeydown={(e) => (e.key === "Enter" ? openCard(task.id) : null)}
							>
								<div class="card-top">
									<span class="dot" style="background:{TYPE_COLORS.task}"></span>
									<h3>{task.title}</h3>
								</div>
								<div class="card-tags">
									{#each task.tags as tag (tag)}<span class="tag">#{tag}</span>{/each}
								</div>
								<div class="card-foot">
									{#if st === "taken" && task.takenBy}
										<span class="owner">{task.takenBy}</span>
									{/if}
									{#if task.codeAreas && task.codeAreas.length > 0}
										<span class="areas" title={task.codeAreas.join('\n')}>
											{task.codeAreas.length} code {task.codeAreas.length === 1 ? "area" : "areas"}
										</span>
									{/if}
								</div>
								<div class="card-moves">
									{#if prevStatus[st]}
										<button
											type="button"
											class="move-btn"
											onclick={(e) => {
												e.stopPropagation();
												void moveTo(task, prevStatus[st]!);
											}}
											title="Move to {prevStatus[st]}"
										>
											← {prevStatus[st]}
										</button>
									{/if}
									{#if nextStatus[st]}
										<button
											type="button"
											class="move-btn"
											onclick={(e) => {
												e.stopPropagation();
												void moveTo(task, nextStatus[st]!);
											}}
											title="Move to {nextStatus[st]}"
										>
											{nextStatus[st]} →
										</button>
									{/if}
								</div>
							</div>
						{/each}
						{#if lane.tasks.length === 0}
							<p class="lane-empty muted">—</p>
						{/if}
					</div>
				</section>
			{/each}
		</div>
	{/if}
</div>

{#if selectedNode}
	<div class="panel-overlay" role="dialog" aria-modal="true">
		<button class="panel-scrim" aria-label="Close" onclick={closePanel}></button>
		<div class="panel-host">
			<ConceptPanel
				node={selectedNode}
				{concept}
				loading={conceptLoading}
				error={conceptError}
				edges={selectedEdges}
				{titleFor}
				focused={false}
				onfocustoggle={() => {}}
				onnavigate={gotoGraph}
				onedit={() => gotoGraph(selectedNode.id)}
				ondelete={() => {}}
				onclose={closePanel}
			/>
		</div>
	</div>
{/if}

<style>
	.board-page {
		display: flex;
		flex-direction: column;
		height: 100%;
		padding: 16px 20px 24px;
		overflow: hidden;
	}
	.toolbar {
		display: flex;
		align-items: center;
		gap: 16px;
		flex-wrap: wrap;
		margin-bottom: 14px;
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
	.group-control {
		display: flex;
		align-items: center;
		gap: 4px;
	}
	.glabel {
		font-size: 12px;
		color: var(--text-dim);
		margin-right: 4px;
	}
	.chip {
		font-size: 12.5px;
		padding: 3px 10px;
		border-radius: 999px;
		border: 1px solid var(--border);
		background: var(--bg-raised);
		color: var(--text-dim);
		cursor: pointer;
	}
	.chip.on {
		color: var(--text);
		border-color: var(--accent);
		background: color-mix(in srgb, var(--accent) 16%, transparent);
	}
	.right {
		margin-left: auto;
		display: flex;
		align-items: center;
		gap: 12px;
		font-size: 12.5px;
		color: var(--text-dim);
	}
	.live {
		color: var(--text-dim);
	}
	.live.on {
		color: #34d399;
	}
	.banner {
		margin: 0 0 10px;
	}
	.columns {
		display: grid;
		grid-template-columns: repeat(3, 1fr);
		gap: 14px;
		flex: 1;
		min-height: 0;
		overflow-y: auto;
	}
	.columns.swimlanes {
		grid-template-columns: repeat(auto-fill, minmax(260px, 1fr));
	}
	.column {
		background: var(--bg-raised);
		border: 1px solid var(--border);
		border-radius: 10px;
		padding: 10px;
		display: flex;
		flex-direction: column;
		min-height: 120px;
	}
	.column.drop-target {
		border-color: var(--accent);
		box-shadow: var(--glow);
	}
	.col-head {
		display: flex;
		align-items: center;
		justify-content: space-between;
		margin-bottom: 8px;
		padding: 0 2px;
	}
	.col-title {
		font-size: 12px;
		text-transform: uppercase;
		letter-spacing: 0.06em;
		font-weight: 700;
		color: var(--text-dim);
	}
	.status-open {
		color: #f59e0b;
	}
	.status-taken {
		color: #60a5fa;
	}
	.status-done {
		color: #34d399;
	}
	.col-count {
		font-size: 11.5px;
		color: var(--text-dim);
		background: var(--bg);
		border-radius: 999px;
		padding: 1px 8px;
	}
	.cards {
		display: flex;
		flex-direction: column;
		gap: 8px;
		overflow-y: auto;
	}
	.task-card {
		background: var(--bg);
		border: 1px solid var(--border);
		border-left: 3px solid var(--border);
		border-radius: 8px;
		padding: 9px 11px;
		cursor: pointer;
		transition:
			border-color 120ms ease,
			transform 120ms ease,
			box-shadow 120ms ease;
	}
	.task-card:hover {
		border-color: var(--accent);
		transform: translateY(-1px);
	}
	.task-card.status-open {
		border-left-color: #f59e0b;
	}
	.task-card.status-taken {
		border-left-color: #60a5fa;
	}
	.task-card.status-done {
		border-left-color: #34d399;
		opacity: 0.78;
	}
	.task-card.busy {
		opacity: 0.5;
		pointer-events: none;
	}
	.card-top {
		display: flex;
		align-items: baseline;
		gap: 7px;
	}
	.card-top h3 {
		font-size: 13.5px;
		font-weight: 600;
		margin: 0;
		line-height: 1.3;
	}
	.dot {
		width: 8px;
		height: 8px;
		border-radius: 50%;
		flex: none;
		display: inline-block;
		transform: translateY(-1px);
	}
	.card-tags {
		display: flex;
		flex-wrap: wrap;
		gap: 4px;
		margin-top: 6px;
	}
	.tag {
		font-size: 10.5px;
		color: var(--text-dim);
		background: var(--bg-raised);
		border: 1px solid var(--border);
		border-radius: 5px;
		padding: 1px 6px;
	}
	.card-foot {
		display: flex;
		flex-wrap: wrap;
		gap: 8px;
		margin-top: 7px;
		font-size: 11px;
		color: var(--text-dim);
	}
	.owner {
		color: #60a5fa;
		font-weight: 600;
	}
	.card-moves {
		display: flex;
		justify-content: space-between;
		gap: 6px;
		margin-top: 8px;
	}
	.move-btn {
		font-size: 11px;
		color: var(--text-dim);
		background: none;
		border: 1px solid var(--border);
		border-radius: 6px;
		padding: 2px 8px;
		cursor: pointer;
	}
	.move-btn:hover {
		color: var(--text);
		border-color: var(--accent);
	}
	.lane-empty {
		text-align: center;
		font-size: 12px;
		padding: 8px 0;
	}
	.empty {
		text-align: center;
		max-width: 460px;
		margin: 48px auto;
	}
	.empty .mark {
		font-size: 40px;
		margin-bottom: 10px;
	}
	.empty h2 {
		font-size: 18px;
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
	}
</style>
