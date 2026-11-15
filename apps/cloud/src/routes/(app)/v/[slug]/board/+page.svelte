<script lang="ts">
	// Real-time Kanban board over the vault's task-type concepts.
	// Columns Open · Taken · Done (or swimlanes when grouped by concept /
	// priority / owner; grouped by epic, each epic swimlane keeps the three
	// status columns). Polls GET /tasks every 4s and diff-animates; card
	// moves issue take/complete/reopen mutations with an optimistic update.
	import type { ApiConcept, GraphNode, GraphPayload, TaskMeta } from "@brainz/contracts";
	import { ApiError, createApi, roleOf } from "$lib/api";
	import { TYPE_COLORS } from "$lib/graph-data";
	import { vaultTabLinks } from "$lib/nav";
	import ConceptPanel from "$lib/components/ConceptPanel.svelte";
	import Mark from "$lib/components/Mark.svelte";
	import { onMount } from "svelte";
	import {
		type EpicLane,
		type GroupBy,
		type Lane,
		type Status,
		NO_EPIC,
		STATUSES,
		collapsedStorageKey,
		computeEpicLanes,
		computeLanes,
		epicIdsIn,
		hasLaneMiss,
		hasTaskMiss,
		nearestEpicOf,
		parseCollapsed,
		planEpicReparent,
		scopeTasks,
		serializeCollapsed,
		statusOf as laneStatusOf,
		titleForIn,
		toggleCollapsed,
		withEpicReparent,
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
	const GROUPS: [GroupBy, string][] = [
		["status", "Status"],
		["epic", "Epic"],
		["concept", "Concept"],
		["priority", "Priority"],
		["takenBy", "Owner"],
	];
	// `?group=epic` (etc.) opens the board pre-grouped, so other views can link here.
	// svelte-ignore state_referenced_locally
	let groupBy = $state<GroupBy>(
		GROUPS.find(([g]) => g === data.group)?.[0] ?? "status",
	);
	// `?scope=<id>` (the feature tree's "Show on board") narrows the board to
	// that concept's subtree; moves still act on the full pile.
	const scope = $derived(data.scope ?? null);
	const shown = $derived.by((): TaskMeta[] => scopeTasks(tasks, graph, scope));
	const lanes = $derived.by((): Lane[] => computeLanes(shown, graph, groupBy));
	// Scoped, empty epic lanes outside the subtree are noise: keep the lanes
	// with tasks (and the scope's own lane, if it is an epic).
	const epicLanes = $derived.by((): EpicLane[] =>
		groupBy === "epic"
			? computeEpicLanes(shown, graph).filter(
					(l) => !scope || l.rollup.total > 0 || l.id === scope,
				)
			: [],
	);

	// Collapsed epic lanes, remembered per vault in this browser (a per-viewer
	// convenience: storage can be unavailable, so every access is guarded).
	let collapsed = $state<Set<string>>(new Set());
	function toggleLane(id: string) {
		collapsed = toggleCollapsed(collapsed, id);
		try {
			localStorage.setItem(collapsedStorageKey(vault.id), serializeCollapsed(collapsed));
		} catch {
			/* not persisted; still collapsed for this page */
		}
	}

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
		// The epic lanes need each task's edges, so a task the graph hasn't seen
		// yet (just created) is a miss there too.
		if (
			tick % GRAPH_EVERY === 0 ||
			hasLaneMiss(tasks, graph) ||
			(groupBy === "epic" && hasTaskMiss(tasks, graph))
		)
			void refreshGraph();
	}
	// The iteration and epic pickers need JS: disabled until hydrated so an
	// early change is never silently dropped.
	let hydrated = $state(false);
	onMount(() => {
		hydrated = true;
		try {
			collapsed = parseCollapsed(localStorage.getItem(collapsedStorageKey(vault.id)));
		} catch {
			/* storage unavailable: every lane starts expanded */
		}
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

	// ---------------------------------------------------- iteration assign
	// Iterations are ordinary concepts (type "iteration"); a task is in one
	// through a part_of edge. The server swaps it atomically
	// (POST /concepts/:id/membership) from the stored relations, so links an
	// agent added since this page last refreshed its graph are kept.
	const iterations = $derived(
		graph.nodes
			.filter((n) => n.type === "iteration" && !n.pending)
			.sort((a, b) => a.title.localeCompare(b.title)),
	);
	const iterationIds = $derived(new Set(iterations.map((n) => n.id)));
	function iterationOf(taskId: string): string {
		return (
			graph.edges.find(
				(e) => e.from === taskId && e.relation === "part_of" && iterationIds.has(e.to),
			)?.to ?? ""
		);
	}
	async function assignIteration(task: TaskMeta, iterationId: string) {
		if (!canEdit) return;
		busyId = task.id;
		error = null;
		try {
			await api.setMembership(vault.id, task.id, {
				type: "iteration",
				target: iterationId || null,
			});
			// Reflect it locally; the next graph refresh brings the server's view.
			graph = {
				...graph,
				edges: [
					...graph.edges.filter(
						(e) => !(e.from === task.id && e.relation === "part_of" && iterationIds.has(e.to)),
					),
					...(iterationId ? [{ from: task.id, to: iterationId, relation: "part_of" }] : []),
				],
			};
		} catch (err) {
			error = err instanceof ApiError ? err.message : "Could not change the iteration.";
		} finally {
			busyId = null;
		}
	}

	// ------------------------------------------------------------ epic move
	const epicOptions = $derived(
		graph.nodes
			.filter((n) => n.type === "epic" && !n.pending)
			.sort((a, b) => a.title.localeCompare(b.title)),
	);
	// Dropping a card on another epic's lane re-parents it in ONE atomic
	// server-side membership change (POST /concepts/:id/membership, relation
	// "any", type "epic"): the server drops every epic link it has STORED and
	// refuses "No epic" (409) while an epic is still inherited, so a link an
	// agent added since this page fetched its graph can't be left behind.
	// planEpicReparent refuses the same case from the cached graph first.
	/** Resolves true when the task is now in the target epic lane. */
	async function moveToEpic(task: TaskMeta, target: string | null): Promise<boolean> {
		if (!canEdit) return false;
		const epics = epicIdsIn(graph);
		const plan = planEpicReparent(graph, task.id, target, epics);
		if (!plan.ok) {
			error = plan.reason;
			return false;
		}
		if (!plan.call) return true;
		busyId = task.id;
		error = null;
		const snapshot = graph;
		graph = withEpicReparent(graph, task.id, target, epics);
		try {
			await api.setMembership(vault.id, task.id, { ...plan.call, type: "epic" });
			void refreshGraph();
			return true;
		} catch (err) {
			graph = snapshot; // roll back: the server wrote nothing
			error = err instanceof ApiError ? err.message : "Could not move the task to that epic.";
			void refreshGraph(); // the stored links may differ from this page's graph
			return false;
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
	/** A drop on one status cell of an epic lane: re-parent, then move status. */
	async function onEpicDrop(laneId: string, target: Status) {
		const id = dragId;
		dragId = null;
		if (!id) return;
		const task = tasks.find((t) => t.id === id);
		if (!task) return;
		const epic = laneId === NO_EPIC ? null : laneId;
		if ((nearestEpicOf(graph, task.id) ?? null) !== epic && !(await moveToEpic(task, epic))) return;
		await moveTo(task, target);
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

{#snippet taskCard(task: TaskMeta)}
	{@const st = statusOf(task)}
	<div
		class="card task-card status-{st}"
		class:busy={busyId === task.id}
		draggable={canEdit}
		ondragstart={() => canEdit && (dragId = task.id)}
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
			{#if task.estimate !== undefined}
				<span class="areas" title="Estimate">{task.estimate} pts</span>
			{/if}
		</div>
		{#if canEdit && iterations.length > 0}
			<!-- svelte-ignore a11y_no_noninteractive_element_interactions, a11y_click_events_have_key_events -->
			<label
				class="iter-pick"
				onclick={(e) => e.stopPropagation()}
				onkeydown={(e) => e.stopPropagation()}
			>
				<span class="sr-only">Iteration for {task.title}</span>
				<select
					value={iterationOf(task.id)}
					disabled={!hydrated || busyId === task.id}
					onchange={(e) => void assignIteration(task, e.currentTarget.value)}
				>
					<option value="">No iteration</option>
					{#each iterations as it (it.id)}
						<option value={it.id}>{it.title}</option>
					{/each}
				</select>
			</label>
		{/if}
		{#if canEdit && groupBy === "epic" && epicOptions.length > 0}
			<!-- svelte-ignore a11y_no_noninteractive_element_interactions, a11y_click_events_have_key_events -->
			<label
				class="iter-pick epic-pick"
				onclick={(e) => e.stopPropagation()}
				onkeydown={(e) => e.stopPropagation()}
			>
				<span class="sr-only">Epic for {task.title}</span>
				<select
					value={nearestEpicOf(graph, task.id) ?? ""}
					disabled={!hydrated || busyId === task.id}
					onchange={async (e) => {
						const sel = e.currentTarget;
						const ok = await moveToEpic(task, sel.value || null);
						if (!ok) sel.value = nearestEpicOf(graph, task.id) ?? "";
					}}
				>
					<option value="">No epic</option>
					{#each epicOptions as ep (ep.id)}
						<option value={ep.id}>{ep.title}</option>
					{/each}
				</select>
			</label>
		{/if}
		{#if canEdit}
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
		{/if}
	</div>
{/snippet}

<svelte:head><title>Board — {vault.name} — Brainz</title></svelte:head>

<div class="board-page">
	<div class="toolbar">
		<div class="left">
			<h1>{vault.name} · Board</h1>
			{#each vaultTabLinks(vault.slug, "board") as link (link.href)}
				<a class="btn btn-ghost btn-sm" href={link.href}>{link.label}</a>
			{/each}
		</div>
		{#if scope}
			<span class="scope-chip" data-scope={scope}>
				Showing <strong>{titleFor(scope)}</strong>
				<a href="/v/{vault.slug}/board?group={groupBy}" aria-label="Show the whole board">✕</a>
			</span>
		{/if}
		<div class="group-control" role="group" aria-label="Group by">
			<span class="glabel">Group by</span>
			{#each GROUPS as [val, label] (val)}
				<button
					type="button"
					class="chip"
					class:on={groupBy === val}
					aria-pressed={groupBy === val}
					onclick={() => (groupBy = val)}
				>
					{label}
				</button>
			{/each}
		</div>
		<div class="right">
			<span class="count">{shown.length} {shown.length === 1 ? "task" : "tasks"}</span>
			<span class="live" class:on={polling} title="Live — polling every 4s">● live</span>
		</div>
	</div>

	{#if error}<p class="error-text banner" role="alert">{error}</p>{/if}

	{#if tasks.length === 0}
		<div class="empty">
			<div class="mark" aria-hidden="true"><Mark size={40} /></div>
			<h2>No tasks yet</h2>
			<p class="muted">
				Tasks appear here when an agent files them (create_task over MCP) or takes work off the pile.
				Give your fleet the vault's MCP key and watch the board fill up.
			</p>
		</div>
	{:else if groupBy === "epic"}
		<div class="epic-lanes">
			{#each epicLanes as lane (lane.id)}
				{@const open = !collapsed.has(lane.id)}
				<section class="epic-lane" class:none={lane.id === NO_EPIC} aria-label="Epic: {lane.label}">
					<header class="epic-head">
						<button
							type="button"
							class="epic-toggle"
							aria-expanded={open}
							aria-controls="epic-body-{lane.id}"
							onclick={() => toggleLane(lane.id)}
						>
							<span class="chev" aria-hidden="true">{open ? "▾" : "▸"}</span>
							{#if lane.id !== NO_EPIC}
								<span class="dot" style="background:{TYPE_COLORS.epic}"></span>
							{/if}
							<span class="epic-title">{lane.label}</span>
						</button>
						<div
							class="epic-progress"
							role="progressbar"
							aria-label="{lane.label} progress"
							aria-valuemin={0}
							aria-valuemax={lane.rollup.total}
							aria-valuenow={lane.rollup.done}
						>
							<span class="bar done" style="width:{lane.rollup.total ? (lane.rollup.done / lane.rollup.total) * 100 : 0}%"></span>
							<span class="bar taken" style="width:{lane.rollup.total ? (lane.rollup.taken / lane.rollup.total) * 100 : 0}%"></span>
						</div>
						<span class="epic-rollup">
							<strong>{lane.rollup.done}/{lane.rollup.total}</strong> done
							{#if lane.rollup.taken > 0}· <span class="status-taken">{lane.rollup.taken} taken</span>{/if}
							· {lane.rollup.pct}%
						</span>
					</header>
					{#if open}
						<div class="columns epic-columns" id="epic-body-{lane.id}">
							{#each STATUSES as st (st)}
								<div
									class="column epic-cell"
									role="group"
									aria-label="{lane.label} · {st}"
									data-epic={lane.id}
									data-status={st}
									ondragover={(e) => dragId !== null && e.preventDefault()}
									ondrop={() => void onEpicDrop(lane.id, st)}
									class:drop-target={dragId !== null}
								>
									<header class="col-head">
										<span class="col-title status-{st}">{st}</span>
										<span class="col-count">{lane.columns[st].length}</span>
									</header>
									<div class="cards">
										{#each lane.columns[st] as task (task.id)}
											{@render taskCard(task)}
										{/each}
										{#if lane.columns[st].length === 0}
											<p class="lane-empty muted">—</p>
										{/if}
									</div>
								</div>
							{/each}
						</div>
					{/if}
				</section>
			{/each}
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
							{@render taskCard(task)}
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
				readonly={!canEdit}
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
	.scope-chip {
		display: inline-flex;
		align-items: center;
		gap: 6px;
		padding: 3px 8px 3px 10px;
		border: 1px solid var(--border-strong);
		border-radius: 999px;
		font-size: 12px;
		color: var(--text-dim);
	}
	.scope-chip strong {
		color: var(--text);
		font-weight: 600;
	}
	.scope-chip a {
		color: var(--text-dim);
		text-decoration: none;
	}
	.scope-chip a:hover {
		color: var(--text);
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
		display: flex;
		justify-content: center;
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
	.iter-pick {
		display: block;
		margin-top: 6px;
	}
	.iter-pick select {
		width: 100%;
		font-size: 12px;
		padding: 3px 6px;
		background: var(--bg-overlay);
		color: var(--text);
		border: 1px solid var(--border);
		border-radius: 6px;
	}
	.epic-lanes {
		display: flex;
		flex-direction: column;
		gap: 12px;
		flex: 1;
		min-height: 0;
		overflow-y: auto;
	}
	.epic-lane {
		border: 1px solid var(--border);
		border-radius: 12px;
		padding: 8px 10px 10px;
		background: color-mix(in srgb, var(--bg-raised) 55%, transparent);
	}
	.epic-lane.none {
		border-style: dashed;
	}
	.epic-head {
		display: flex;
		align-items: center;
		gap: 12px;
		flex-wrap: wrap;
	}
	.epic-toggle {
		display: flex;
		align-items: center;
		gap: 7px;
		background: none;
		border: none;
		color: var(--text);
		font: inherit;
		font-size: 14px;
		font-weight: 650;
		cursor: pointer;
		padding: 2px 0;
	}
	.chev {
		width: 12px;
		color: var(--text-dim);
	}
	.epic-progress {
		display: flex;
		width: 140px;
		height: 6px;
		border-radius: 999px;
		background: var(--bg);
		border: 1px solid var(--border);
		overflow: hidden;
	}
	.epic-progress .bar.done {
		background: #34d399;
	}
	.epic-progress .bar.taken {
		background: #60a5fa;
	}
	.epic-rollup {
		font-size: 12px;
		color: var(--text-dim);
	}
	.epic-columns {
		margin-top: 8px;
		flex: none;
		overflow: visible;
	}
	.epic-cell {
		min-height: 80px;
		background: var(--bg-raised);
	}
	@media (max-width: 720px) {
		.epic-columns {
			grid-template-columns: 1fr;
		}
	}
	.sr-only {
		position: absolute;
		width: 1px;
		height: 1px;
		overflow: hidden;
		clip: rect(0 0 0 0);
		white-space: nowrap;
	}
</style>
