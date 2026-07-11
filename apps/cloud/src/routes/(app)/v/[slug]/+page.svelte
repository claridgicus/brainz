<script lang="ts">
	// The vault workspace: force-directed graph + concept panel + editor +
	// search + type filters + stats bar.
	import type { ApiConcept, GraphNode, GraphPayload } from "@brainz/contracts";
	import { ApiError, createApi, roleOf, type UpsertConceptBody, type VaultStats } from "$lib/api";
	import { ALL_TYPES, TYPE_COLORS } from "$lib/graph-data";
	import { defaultVisibleTypes } from "$lib/graph-view";
	import ConceptEditor from "$lib/components/ConceptEditor.svelte";
	import ConceptPanel from "$lib/components/ConceptPanel.svelte";
	import Graph from "$lib/components/Graph.svelte";
	import Mark from "$lib/components/Mark.svelte";
	import Modal from "$lib/components/Modal.svelte";
	import SearchBox from "$lib/components/SearchBox.svelte";

	let { data } = $props();
	const api = createApi(fetch);
	const vault = $derived(data.vault);
	/** Viewers browse read-only: no create/edit/delete affordances (the server
	 * enforces the role too — this only hides the controls). */
	const canEdit = $derived(roleOf(data.vault) !== "viewer");

	// ------------------------------------------------------------ live data
	// Seeded from the server load once; the $effect below re-syncs on nav.
	// svelte-ignore state_referenced_locally
	let graph = $state<GraphPayload>(data.graph);
	// svelte-ignore state_referenced_locally
	let stats = $state<VaultStats>(data.stats);
	$effect(() => {
		// Re-sync when navigating between vaults.
		graph = data.graph;
		stats = data.stats;
	});

	async function refresh() {
		try {
			[graph, stats] = await Promise.all([api.graph(vault.id), api.stats(vault.id)]);
		} catch {
			/* keep showing the last good data */
		}
	}

	const pendingCount = $derived(graph.nodes.filter((n) => n.pending).length);
	const nodeById = (id: string): GraphNode | undefined => graph.nodes.find((n) => n.id === id);
	const titleFor = (id: string): string => nodeById(id)?.title ?? id;

	// -------------------------------------------------------------- filters
	// First load shows only the high-signal structural types (domain/feature/
	// spec/story/task) so the initial graph is small and paints fast; the rest
	// are toggled on demand. Off types are NOT rendered into the DOM at all
	// (the Graph sim only includes enabled-type nodes) — this is a perf win, not
	// a CSS hide. State is persisted per-vault in localStorage.
	const storageKey = $derived(`brainz:graph-types:${vault.id}`);
	function loadEnabledTypes(key: string): string[] {
		if (typeof localStorage === "undefined") return defaultVisibleTypes();
		try {
			const raw = localStorage.getItem(key);
			if (!raw) return defaultVisibleTypes();
			const parsed = JSON.parse(raw);
			if (Array.isArray(parsed)) return parsed.filter((t) => ALL_TYPES.includes(t));
		} catch {
			/* fall through to defaults */
		}
		return defaultVisibleTypes();
	}
	// svelte-ignore state_referenced_locally
	let enabledTypes = $state<string[]>(loadEnabledTypes(storageKey));
	let hydrated = false;
	$effect(() => {
		// Re-load when switching vaults; skip the persist on the very first run.
		enabledTypes = loadEnabledTypes(storageKey);
		hydrated = true;
	});
	$effect(() => {
		void enabledTypes;
		if (!hydrated || typeof localStorage === "undefined") return;
		try {
			localStorage.setItem(storageKey, JSON.stringify(enabledTypes));
		} catch {
			/* storage full / disabled — in-memory state is still authoritative */
		}
	});

	const allEnabled = $derived(enabledTypes.length === ALL_TYPES.length);
	function toggleType(t: string) {
		enabledTypes = enabledTypes.includes(t)
			? enabledTypes.filter((x) => x !== t)
			: [...enabledTypes, t];
	}
	function showAllTypes() {
		enabledTypes = [...ALL_TYPES];
	}
	// One clear "Reset graph": restore default type filters AND clear the drag
	// anchors (un-pin + re-layout, handled inside Graph.resetGraph). Confirm first
	// since it discards the user's manual node placements.
	function resetGraph() {
		if (typeof confirm === "function" && !confirm("Reset the graph? This clears pinned node positions and restores the default type filters.")) {
			return;
		}
		enabledTypes = defaultVisibleTypes();
		graphRef?.resetGraph();
	}

	// ------------------------------------------------------------ selection
	let graphRef = $state<ReturnType<typeof Graph>>();
	let selectedId = $state<string | null>(null);
	let focusId = $state<string | null>(null);
	let concept = $state<ApiConcept | null>(null);
	let conceptLoading = $state(false);
	let conceptError = $state<string | null>(null);

	const selectedNode = $derived(selectedId ? (nodeById(selectedId) ?? null) : null);
	const selectedEdges = $derived({
		outgoing: selectedId ? graph.edges.filter((e) => e.from === selectedId) : [],
		incoming: selectedId ? graph.edges.filter((e) => e.to === selectedId) : [],
	});

	async function select(id: string) {
		selectedId = id;
		concept = null;
		conceptError = null;
		const node = nodeById(id);
		if (!node || node.pending) return;
		conceptLoading = true;
		try {
			const loaded = await api.getConcept(vault.id, id);
			if (selectedId === id) concept = loaded;
		} catch (err) {
			if (selectedId === id) {
				conceptError = err instanceof ApiError ? err.message : "Failed to load concept.";
			}
		} finally {
			if (selectedId === id) conceptLoading = false;
		}
	}

	function navigate(id: string) {
		if (!nodeById(id)) return;
		graphRef?.panTo(id);
		void select(id);
	}

	function closePanel() {
		selectedId = null;
		concept = null;
	}

	// --------------------------------------------------------------- editor
	let editing = $state<"new" | "edit" | null>(null);

	async function saveConcept(body: UpsertConceptBody) {
		const saved = await api.upsertConcept(vault.id, body);
		editing = null;
		// Optimistic-ish: show the saved concept immediately, refresh in background.
		selectedId = saved.id;
		concept = saved;
		conceptError = null;
		await refresh();
		graphRef?.panTo(saved.id);
	}

	// --------------------------------------------------------------- delete
	let confirmingDelete = $state(false);
	let deleting = $state(false);
	let deleteError = $state<string | null>(null);

	async function deleteConcept() {
		if (!selectedId) return;
		deleting = true;
		deleteError = null;
		try {
			await api.deleteConcept(vault.id, selectedId);
			confirmingDelete = false;
			closePanel();
			await refresh();
		} catch (err) {
			deleteError = err instanceof ApiError ? err.message : "Failed to delete concept.";
		} finally {
			deleting = false;
		}
	}
</script>

<svelte:head><title>{vault.name} — Brainz</title></svelte:head>

<div class="workspace">
	<div class="toolbar">
		<div class="left">
			<h1>{vault.name}</h1>
			<a class="btn btn-ghost btn-sm" href="/v/{vault.slug}/board">Board</a>
			<a class="btn btn-ghost btn-sm" href="/v/{vault.slug}/settings">Settings</a>
		</div>

		<SearchBox search={(q) => api.search(vault.id, q)} onpick={navigate} />

		<div class="filters" role="group" aria-label="Filter by type">
			{#each ALL_TYPES as t (t)}
				<button
					type="button"
					class="chip"
					class:off={!enabledTypes.includes(t)}
					onclick={() => toggleType(t)}
				>
					<span class="dot" style="background:{TYPE_COLORS[t]}; color:{TYPE_COLORS[t]}"></span>{t}
				</button>
			{/each}
			{#if !allEnabled}
				<button
					type="button"
					class="chip chip-action"
					onclick={showAllTypes}
					title="Render every concept type"
				>
					Show all
				</button>
			{/if}
			<button
				type="button"
				class="chip chip-action"
				onclick={resetGraph}
				title="Restore default type filters and clear pinned node positions"
			>
				Reset graph
			</button>
		</div>

		<div class="right">
			{#if canEdit}
				<button type="button" class="btn btn-primary btn-sm" onclick={() => (editing = "new")}>
					+ New concept
				</button>
			{:else}
				<span class="badge role-viewer" title="You have read-only access to this vault">viewer</span>
			{/if}
		</div>
	</div>

	<div class="stage" class:with-panel={selectedNode !== null}>
		<div class="graph-area">
			{#if graph.nodes.length === 0}
				<div class="graph-empty">
					<div class="mark" aria-hidden="true"><Mark size={40} /></div>
					<h2>An empty brain</h2>
					<p class="muted">
						Create your first concept here, or point your orchestrator at this vault's MCP URL
						(see <a href="/v/{vault.slug}/settings">settings</a>) and let your agents fill it.
					</p>
					{#if canEdit}
						<button type="button" class="btn btn-primary" onclick={() => (editing = "new")}>
							+ New concept
						</button>
					{/if}
				</div>
			{:else}
				<Graph
					bind:this={graphRef}
					{graph}
					{enabledTypes}
					vaultId={vault.id}
					{focusId}
					{selectedId}
					onselect={(id) => void select(id)}
				/>
			{/if}

			<div class="statsbar">
				<span>{stats.concepts} concepts · {stats.edges} edges{pendingCount > 0 ? ` · ${pendingCount} pending` : ""}</span>
				{#if stats.embeddings === "unavailable"}
					<span class="badge" title="Embeddings are unavailable — search runs on the keyword index only.">keyword-only</span>
				{:else}
					<span class="badge" title="Hybrid search: keyword index + embeddings.">embeddings ready</span>
				{/if}
				{#if focusId}
					<button type="button" class="badge focus-chip" onclick={() => (focusId = null)}>
						Focused: {titleFor(focusId)} ✕
					</button>
				{/if}
			</div>

			<!-- SSR-visible concept inventory (screen readers + scripted checks). -->
			<ul class="visually-hidden" aria-label="Concepts in this vault">
				{#each graph.nodes.filter((n) => !n.pending) as n (n.id)}
					<li>{n.title}</li>
				{/each}
			</ul>
		</div>

		{#if selectedNode}
			<ConceptPanel
				node={selectedNode}
				{concept}
				loading={conceptLoading}
				error={conceptError}
				edges={selectedEdges}
				{titleFor}
				readonly={!canEdit}
				focused={focusId !== null && focusId === selectedId}
				onfocustoggle={() => (focusId = focusId === selectedId ? null : selectedId)}
				onnavigate={navigate}
				onedit={() => (editing = "edit")}
				ondelete={() => {
					deleteError = null;
					confirmingDelete = true;
				}}
				onclose={closePanel}
			/>
		{/if}
	</div>
</div>

{#if editing}
	<Modal title={editing === "new" ? "New concept" : `Edit ${concept?.title ?? ""}`} onclose={() => (editing = null)}>
		<ConceptEditor
			initial={editing === "edit" ? concept : null}
			onsubmit={saveConcept}
			oncancel={() => (editing = null)}
		/>
	</Modal>
{/if}

{#if confirmingDelete && selectedNode}
	<Modal title="Delete concept" onclose={() => (confirmingDelete = false)}>
		<p>
			Delete <strong>{selectedNode.title}</strong>? Edges pointing at it will show as pending.
			This cannot be undone.
		</p>
		{#if deleteError}<p class="error-text" role="alert">{deleteError}</p>{/if}
		<div class="modal-buttons">
			<button type="button" class="btn btn-danger" onclick={deleteConcept} disabled={deleting}>
				{#if deleting}<span class="spinner"></span>{/if}
				Delete
			</button>
			<button type="button" class="btn" onclick={() => (confirmingDelete = false)} disabled={deleting}>
				Cancel
			</button>
		</div>
	</Modal>
{/if}

<style>
	.workspace {
		display: flex;
		flex-direction: column;
		height: 100%;
	}

	.toolbar {
		flex: none;
		display: flex;
		align-items: center;
		gap: 14px;
		flex-wrap: wrap;
		padding: 10px 20px;
		border-bottom: 1px solid var(--border);
		background: var(--bg-raised);
	}
	.left {
		display: flex;
		align-items: center;
		gap: 8px;
	}
	h1 {
		font-size: 16px;
		margin: 0;
	}
	.right {
		margin-left: auto;
	}

	.filters {
		display: flex;
		gap: 6px;
		flex-wrap: wrap;
	}
	.chip {
		display: inline-flex;
		align-items: center;
		gap: 6px;
		font: 500 12px/1 var(--font-sans);
		padding: 5px 10px;
		border-radius: 999px;
		border: 1px solid var(--border-strong);
		background: var(--bg-overlay);
		color: var(--text);
		cursor: pointer;
		transition:
			border-color 120ms ease,
			opacity 120ms ease;
	}
	.chip .dot {
		width: 8px;
		height: 8px;
		border-radius: 50%;
		box-shadow: 0 0 6px currentcolor;
	}
	.chip.off {
		opacity: 0.4;
	}
	.chip:hover {
		border-color: var(--accent);
	}
	.chip-action {
		color: var(--text-dim);
		font-weight: 600;
	}

	.stage {
		flex: 1;
		min-height: 0;
		display: grid;
		grid-template-columns: 1fr;
	}
	.stage.with-panel {
		grid-template-columns: 1fr minmax(300px, 380px);
	}

	.graph-area {
		position: relative;
		min-width: 0;
		overflow: hidden;
	}

	.graph-empty {
		height: 100%;
		display: flex;
		flex-direction: column;
		align-items: center;
		justify-content: center;
		text-align: center;
		padding: 24px;
	}
	.graph-empty .mark {
		display: flex;
		justify-content: center;
		margin-bottom: 8px;
	}
	.graph-empty h2 {
		font-size: 18px;
	}
	.graph-empty p {
		max-width: 420px;
	}

	.statsbar {
		position: absolute;
		left: 14px;
		bottom: 12px;
		display: flex;
		align-items: center;
		gap: 8px;
		font-size: 12.5px;
		color: var(--text-dim);
		background: rgb(14 14 17 / 0.82);
		backdrop-filter: blur(8px);
		border: 1px solid var(--border);
		border-radius: 8px;
		padding: 6px 12px;
		pointer-events: auto;
	}
	.focus-chip {
		cursor: pointer;
	}

	.modal-buttons {
		display: flex;
		gap: 10px;
	}

	@media (max-width: 860px) {
		.stage.with-panel {
			grid-template-columns: 1fr;
			grid-template-rows: 1fr minmax(220px, 45%);
		}
	}
</style>
