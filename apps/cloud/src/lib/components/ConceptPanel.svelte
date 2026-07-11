<script lang="ts">
	// Right-hand concept panel: rendered markdown body (sanitized — see
	// $lib/markdown), meta badges, incoming/outgoing edges, edit/delete.
	import type { ApiConcept, Edge, GraphNode } from "@brainz/contracts";
	import { TYPE_COLORS } from "$lib/graph-data";
	import { renderMarkdown } from "$lib/markdown";

	let {
		node,
		concept,
		loading,
		error,
		edges,
		titleFor,
		focused,
		readonly: isReadonly = false,
		onfocustoggle,
		onnavigate,
		onedit,
		ondelete,
		onclose,
	}: {
		/** The selected graph node (always known, even for pending nodes). */
		node: GraphNode;
		/** Full concept, when loaded (null for pending nodes / while loading). */
		concept: ApiConcept | null;
		loading: boolean;
		error: string | null;
		edges: { outgoing: Edge[]; incoming: Edge[] };
		titleFor: (id: string) => string;
		/** Whether the graph is currently focused on this node's neighborhood. */
		focused: boolean;
		/** Viewer role: hide the Edit/Delete affordances (server enforces too). */
		readonly?: boolean;
		onfocustoggle: () => void;
		onnavigate: (id: string) => void;
		onedit: () => void;
		ondelete: () => void;
		onclose: () => void;
	} = $props();

	const bodyHtml = $derived(concept ? renderMarkdown(concept.body) : "");

	/** Intercept in-app wiki-links ("#concept:<id>"); external links get a new tab. */
	function onBodyClick(ev: MouseEvent) {
		const a = (ev.target as HTMLElement).closest("a");
		if (!a) return;
		const href = a.getAttribute("href") ?? "";
		if (href.startsWith("#concept:")) {
			ev.preventDefault();
			onnavigate(decodeURIComponent(href.slice("#concept:".length)));
		} else if (href.startsWith("http")) {
			a.setAttribute("target", "_blank");
			a.setAttribute("rel", "noopener noreferrer");
		}
	}
</script>

<aside class="panel" aria-label="Concept details">
	<div class="head">
		<h2>{concept?.title ?? node.title}</h2>
		<div class="actions">
			<button
				type="button"
				class="btn btn-ghost btn-sm"
				class:on={focused}
				onclick={onfocustoggle}
				title="Show only this node's neighborhood"
			>
				{focused ? "Unfocus" : "Focus"}
			</button>
			{#if !node.pending && !isReadonly}
				<button type="button" class="btn btn-ghost btn-sm" onclick={onedit}>Edit</button>
				<button type="button" class="btn btn-ghost btn-sm danger" onclick={ondelete}>Delete</button>
			{/if}
			<button type="button" class="btn btn-ghost btn-sm" onclick={onclose} aria-label="Close panel">✕</button>
		</div>
	</div>

	<div class="badges">
		<span class="badge">
			<span class="dot" style="background:{TYPE_COLORS[node.type] ?? TYPE_COLORS['pending']}"></span>
			{node.pending ? "pending" : node.type}
		</span>
		{#if concept?.type === "task"}
			{@const ts = concept.taskStatus ?? "open"}
			<span class="badge task-badge task-{ts}">{ts}</span>
			{#if ts === "taken" && concept.takenBy}<span class="badge">by {concept.takenBy}</span>{/if}
		{/if}
		{#if concept?.product}<span class="badge">{concept.product}</span>{/if}
		{#if concept && concept.status !== "active"}<span class="badge">{concept.status}</span>{/if}
		{#each concept?.tags ?? [] as tag (tag)}<span class="badge">#{tag}</span>{/each}
	</div>

	{#if concept?.codeAreas && concept.codeAreas.length > 0}
		<div class="code-areas" aria-label="Code areas">
			{#each concept.codeAreas as area (area)}<span class="code-area">{area}</span>{/each}
		</div>
	{/if}

	<div class="body">
		{#if node.pending}
			<p class="muted"><em>
				This concept doesn't exist yet — it's referenced by other notes but hasn't been written.
			</em></p>
		{:else if loading}
			<p class="muted"><span class="spinner"></span> Loading…</p>
		{:else if error}
			<p class="error-text">{error}</p>
		{:else if concept}
			<!-- eslint-disable-next-line svelte/no-at-html-tags — renderMarkdown escapes raw HTML and neutralizes unsafe URLs -->
			<div class="md" onclick={onBodyClick} role="presentation">{@html bodyHtml}</div>
		{/if}
	</div>

	<div class="edges">
		{#if edges.outgoing.length > 0}
			<h3>Outgoing ({edges.outgoing.length})</h3>
			{#each edges.outgoing as e (e.from + e.relation + e.to)}
				<div class="edge-row">
					<span class="edge-rel">→ {e.relation}</span>
					<button type="button" class="edge-target" onclick={() => onnavigate(e.to)}>{titleFor(e.to)}</button>
				</div>
			{/each}
		{/if}
		{#if edges.incoming.length > 0}
			<h3>Incoming ({edges.incoming.length})</h3>
			{#each edges.incoming as e (e.from + e.relation + e.to)}
				<div class="edge-row">
					<span class="edge-rel">← {e.relation}</span>
					<button type="button" class="edge-target" onclick={() => onnavigate(e.from)}>{titleFor(e.from)}</button>
				</div>
			{/each}
		{/if}
		{#if edges.outgoing.length === 0 && edges.incoming.length === 0}
			<h3>No edges</h3>
		{/if}
	</div>
</aside>

<style>
	.panel {
		display: flex;
		flex-direction: column;
		height: 100%;
		overflow-y: auto;
		background: var(--bg-raised);
		border-left: 1px solid var(--border);
		padding: 18px 20px;
	}
	.head {
		display: flex;
		align-items: flex-start;
		justify-content: space-between;
		gap: 10px;
	}
	.head h2 {
		font-size: 17px;
		margin: 0;
	}
	.actions {
		display: flex;
		gap: 2px;
		flex: none;
	}
	.danger {
		color: var(--danger);
	}
	.on {
		color: var(--accent);
		border-color: var(--accent);
	}
	.badges {
		display: flex;
		flex-wrap: wrap;
		gap: 6px;
		margin: 10px 0 14px;
	}
	.task-badge {
		font-weight: 600;
		text-transform: capitalize;
	}
	.task-open {
		color: #f59e0b;
		border-color: color-mix(in srgb, #f59e0b 45%, transparent);
	}
	.task-taken {
		color: #60a5fa;
		border-color: color-mix(in srgb, #60a5fa 45%, transparent);
	}
	.task-done {
		color: #34d399;
		border-color: color-mix(in srgb, #34d399 45%, transparent);
	}
	.code-areas {
		display: flex;
		flex-wrap: wrap;
		gap: 6px;
		margin: -6px 0 14px;
	}
	.code-area {
		font-family: var(--font-mono);
		font-size: 11px;
		color: var(--text);
		background: var(--bg);
		border: 1px solid var(--border);
		border-radius: 6px;
		padding: 2px 8px;
		max-width: 100%;
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
	}
	.body {
		flex: 1;
	}
	.edges {
		border-top: 1px solid var(--border);
		padding-top: 10px;
		margin-top: 14px;
	}
	.edges h3 {
		font-size: 11.5px;
		text-transform: uppercase;
		letter-spacing: 0.07em;
		color: var(--text-dim);
		margin: 10px 0 6px;
	}
	.edge-row {
		display: flex;
		align-items: baseline;
		gap: 8px;
		font-size: 13px;
		padding: 2px 0;
	}
	.edge-rel {
		color: var(--text-dim);
		font-family: var(--font-mono);
		font-size: 11.5px;
		flex: none;
	}
	.edge-target {
		background: none;
		border: none;
		padding: 0;
		font: inherit;
		color: var(--accent);
		cursor: pointer;
		text-align: left;
	}
	.edge-target:hover {
		text-decoration: underline;
	}
</style>
