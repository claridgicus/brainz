<script lang="ts">
	// Anonymous PUBLIC read-only vault view (public vaults). Reuses the graph
	// workspace components in READ-ONLY mode: force-directed graph + concept
	// reading panel + search + get_context — NO editor, NO new-concept, NO
	// delete, NO settings/board/members/keys, NO write affordances. Data comes
	// from the /api/public/<token>/* endpoints (no session, no bearer).
	import type { ApiConcept, GraphNode, GraphPayload } from "@brainz/contracts";
	import { ApiError, createPublicApi, type VaultStats } from "$lib/api";
	import { ALL_TYPES, TYPE_COLORS } from "$lib/graph-data";
	import {
		defaultVisibleTypes,
		type FilterMode,
	} from "$lib/graph-view";
	import ConceptPanel from "$lib/components/ConceptPanel.svelte";
	import Graph from "$lib/components/Graph.svelte";
	import Mark from "$lib/components/Mark.svelte";
	import SearchBox from "$lib/components/SearchBox.svelte";
	import Wordmark from "$lib/components/Wordmark.svelte";

	let { data } = $props();
	// `data.token` is fixed for a page instance (the route param); the graph
	// components take these as plain values.
	const api = $derived(createPublicApi(fetch, data.token));
	// A stable per-view id for localStorage keys / the graph's anchor storage.
	const viewId = $derived(`public:${data.token.slice(0, 12)}`);

	// svelte-ignore state_referenced_locally
	let graph = $state<GraphPayload>(data.graph);
	// svelte-ignore state_referenced_locally
	let stats = $state<VaultStats>(data.stats);

	const pendingCount = $derived(graph.nodes.filter((n) => n.pending).length);
	const nodeById = (id: string): GraphNode | undefined => graph.nodes.find((n) => n.id === id);
	const titleFor = (id: string): string => nodeById(id)?.title ?? id;

	// Public view uses semantic-zoom LOD like the workspace, but without the
	// manual chip UI — it stays in auto mode from the default type set.
	const filterMode: FilterMode = "auto";
	let enabledTypes = $state<string[]>(defaultVisibleTypes());
	let lodVisibleTypes = $state<string[]>(defaultVisibleTypes());
	const isTypeShown = (t: string): boolean => lodVisibleTypes.includes(t);

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
			const loaded = await api.getConcept(id);
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

	const noop = () => {};
</script>

<svelte:head>
	<title>{data.vaultName} — Brainz (public)</title>
	<!-- Unguessable-token pages must not be indexed or enumerated. -->
	<meta name="robots" content="noindex, nofollow" />
</svelte:head>

<div class="public-shell">
	<header class="pub-header">
		<a href="/" class="home" aria-label="Brainz"><Wordmark /></a>
		<div class="banner" role="note">
			<span class="dot" aria-hidden="true"></span>
			<span>Public read-only — <a href="/signup">sign up to create your own</a></span>
		</div>
	</header>

	<div class="workspace">
		<div class="toolbar">
			<div class="left">
				<h1>{data.vaultName}</h1>
				<span class="badge role-viewer" title="Anonymous read-only view">read-only</span>
			</div>

			<SearchBox search={(q) => api.search(q)} onpick={navigate} />

			<div class="legend" role="group" aria-label="Node types">
				{#each ALL_TYPES as t (t)}
					<span class="chip" class:off={!isTypeShown(t)} title={t}>
						<span class="dot" style="background:{TYPE_COLORS[t]}; color:{TYPE_COLORS[t]}"></span>{t}
					</span>
				{/each}
			</div>
		</div>

		<div class="stage" class:with-panel={selectedNode !== null}>
			<div class="graph-area">
				{#if graph.nodes.length === 0}
					<div class="graph-empty">
						<div class="mark" aria-hidden="true"><Mark size={40} /></div>
						<h2>An empty brain</h2>
						<p class="muted">This public vault has no concepts yet.</p>
					</div>
				{:else}
					<Graph
						bind:this={graphRef}
						{graph}
						{enabledTypes}
						vaultId={viewId}
						{filterMode}
						{focusId}
						{selectedId}
						onselect={(id) => void select(id)}
						onlodchange={(types) => (lodVisibleTypes = types)}
					/>
				{/if}

				<div class="statsbar">
					<span>{stats.concepts} concepts · {stats.edges} edges{pendingCount > 0 ? ` · ${pendingCount} pending` : ""}</span>
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
					readonly={true}
					focused={focusId !== null && focusId === selectedId}
					onfocustoggle={() => (focusId = focusId === selectedId ? null : selectedId)}
					onnavigate={navigate}
					onedit={noop}
					ondelete={noop}
					onclose={closePanel}
				/>
			{/if}
		</div>
	</div>
</div>

<style>
	.public-shell {
		display: flex;
		flex-direction: column;
		height: 100vh;
	}
	.pub-header {
		flex: none;
		display: flex;
		align-items: center;
		gap: 16px;
		padding: 0 20px;
		height: 48px;
		border-bottom: 1px solid var(--border);
		background: rgb(14 14 17 / 0.88);
		backdrop-filter: blur(10px);
	}
	.home:hover {
		text-decoration: none;
	}
	.banner {
		display: inline-flex;
		align-items: center;
		gap: 7px;
		margin-left: auto;
		font-size: 12.5px;
		color: var(--text-dim);
		padding: 4px 10px;
		border: 1px solid var(--border);
		border-radius: 999px;
		background: var(--bg-overlay);
	}
	.banner .dot {
		width: 7px;
		height: 7px;
		border-radius: 50%;
		background: var(--accent);
		box-shadow: 0 0 6px var(--accent);
	}

	.workspace {
		flex: 1;
		min-height: 0;
		display: flex;
		flex-direction: column;
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
	.legend {
		display: flex;
		gap: 6px;
		flex-wrap: wrap;
		margin-left: auto;
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
	}
	.focus-chip {
		cursor: pointer;
	}

	@media (max-width: 860px) {
		.stage.with-panel {
			grid-template-columns: 1fr;
			grid-template-rows: 1fr minmax(220px, 45%);
		}
	}
</style>
