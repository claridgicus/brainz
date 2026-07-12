<script lang="ts">
	// Concept editor (create + edit): title, type, tags, product, markdown
	// body with a live preview toggle. The parent performs the actual save.
	import type { ApiConcept, ConceptTypeEntry } from "@brainz/contracts";
	import { CONCEPT_TYPES } from "@brainz/contracts";
	import type { UpsertConceptBody } from "$lib/api";
	import { renderMarkdown } from "$lib/markdown";

	let {
		initial = null,
		types = [],
		onsubmit,
		oncancel,
	}: {
		/** Existing concept to edit, or null to create a new one. */
		initial?: ApiConcept | null;
		/** The vault's concept-type registry — populates the type dropdown so
		 * custom types are selectable. Falls back to the 11 built-ins when empty. */
		types?: readonly ConceptTypeEntry[];
		onsubmit: (body: UpsertConceptBody) => Promise<void>;
		oncancel: () => void;
	} = $props();

	// The dropdown options: registry types (label + key), else the built-ins.
	const typeOptions = $derived<{ key: string; label: string }[]>(
		types.length > 0
			? types.filter((t) => !t.hidden).map((t) => ({ key: t.key, label: t.label }))
			: CONCEPT_TYPES.map((k) => ({ key: k, label: k })),
	);

	// The form intentionally seeds from `initial` once — the editor is
	// remounted per open, and edits must not be clobbered by prop changes.
	// svelte-ignore state_referenced_locally
	let title = $state(initial?.title ?? "");
	// svelte-ignore state_referenced_locally
	let type = $state<string>(initial?.type ?? "concept");
	// svelte-ignore state_referenced_locally
	let tags = $state((initial?.tags ?? []).join(", "));
	// svelte-ignore state_referenced_locally
	let product = $state(initial?.product ?? "");
	// svelte-ignore state_referenced_locally
	let body = $state(initial?.body ?? "");
	let preview = $state(false);
	let saving = $state(false);
	let error = $state<string | null>(null);

	const previewHtml = $derived(preview ? renderMarkdown(body) : "");

	async function save(ev: SubmitEvent) {
		ev.preventDefault();
		if (!title.trim()) {
			error = "Title is required.";
			return;
		}
		saving = true;
		error = null;
		const parsedTags = tags
			.split(",")
			.map((t) => t.trim())
			.filter(Boolean);
		try {
			await onsubmit({
				...(initial ? { id: initial.id } : {}),
				title: title.trim(),
				type,
				body,
				tags: parsedTags,
				...(product.trim() ? { product: product.trim() } : {}),
			});
		} catch (err) {
			error = err instanceof Error ? err.message : String(err);
		} finally {
			saving = false;
		}
	}
</script>

<form class="editor" onsubmit={save}>
	<div class="row">
		<div class="field grow">
			<label for="ce-title">Title</label>
			<input id="ce-title" class="input" bind:value={title} placeholder="Lead scoring" required />
		</div>
		<div class="field">
			<label for="ce-type">Type</label>
			<select id="ce-type" class="select" bind:value={type}>
				{#each typeOptions as t (t.key)}
					<option value={t.key}>{t.label}</option>
				{/each}
			</select>
		</div>
	</div>

	<div class="row">
		<div class="field grow">
			<label for="ce-tags">Tags <span class="hint">(comma-separated)</span></label>
			<input id="ce-tags" class="input" bind:value={tags} placeholder="auth, scoring" />
		</div>
		<div class="field grow">
			<label for="ce-product">Product <span class="hint">(optional)</span></label>
			<input id="ce-product" class="input" bind:value={product} placeholder="crm" />
		</div>
	</div>

	<div class="field">
		<div class="body-head">
			<label for="ce-body">Body <span class="hint">(markdown; [[wiki-links]] become edges)</span></label>
			<button type="button" class="btn btn-ghost btn-sm" onclick={() => (preview = !preview)}>
				{preview ? "Edit" : "Preview"}
			</button>
		</div>
		{#if preview}
			<!-- eslint-disable-next-line svelte/no-at-html-tags — renderMarkdown escapes raw HTML and neutralizes unsafe URLs -->
			<div class="md preview">{@html previewHtml}</div>
		{:else}
			<textarea id="ce-body" class="textarea" bind:value={body} placeholder="What should your agents know?"></textarea>
		{/if}
	</div>

	{#if error}<p class="error-text">{error}</p>{/if}

	<div class="buttons">
		<button type="submit" class="btn btn-primary" disabled={saving}>
			{#if saving}<span class="spinner"></span>{/if}
			{initial ? "Save changes" : "Create concept"}
		</button>
		<button type="button" class="btn" onclick={oncancel} disabled={saving}>Cancel</button>
	</div>
</form>

<style>
	.row {
		display: flex;
		gap: 12px;
	}
	.grow {
		flex: 1;
	}
	.hint {
		text-transform: none;
		letter-spacing: 0;
		font-weight: 400;
		opacity: 0.8;
	}
	.body-head {
		display: flex;
		align-items: center;
		justify-content: space-between;
	}
	.body-head label {
		font-size: 12px;
		font-weight: 650;
		color: var(--text-dim);
		text-transform: uppercase;
		letter-spacing: 0.06em;
	}
	.preview {
		border: 1px solid var(--border);
		border-radius: 8px;
		padding: 12px 14px;
		min-height: 180px;
		background: var(--bg);
	}
	.buttons {
		display: flex;
		gap: 10px;
		margin-top: 4px;
	}
</style>
