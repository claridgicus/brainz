<script lang="ts">
	import { goto } from "$app/navigation";
	import { createApi, autoSlug, ApiError } from "$lib/api";

	let { data } = $props();
	const api = createApi(fetch);

	let vaults = $derived(data.vaults);

	// ---- create-vault form (name → auto-slug, slug stays editable) ----
	let name = $state("");
	let slug = $state("");
	let slugTouched = $state(false);
	let creating = $state(false);
	let error = $state<string | null>(null);

	function onNameInput() {
		if (!slugTouched) slug = autoSlug(name);
	}

	async function createVault(ev: SubmitEvent) {
		ev.preventDefault();
		creating = true;
		error = null;
		try {
			const vault = await api.createVault({ name: name.trim(), ...(slug ? { slug } : {}) });
			await goto(`/v/${vault.slug}`);
		} catch (err) {
			error = err instanceof ApiError ? err.message : "Failed to create vault.";
			creating = false;
		}
	}

	const fmtDate = (iso: string) =>
		new Date(iso).toLocaleDateString(undefined, { year: "numeric", month: "short", day: "numeric" });
</script>

<svelte:head><title>Dashboard — Brainz</title></svelte:head>

<main class="page">
	<h1>Your vaults</h1>

	{#if vaults.length === 0}
		<div class="card empty">
			<div class="mark" aria-hidden="true">&#x1F4A9;</div>
			<h2>Create your first vault</h2>
			<p class="muted">
				A vault is one knowledge graph — concepts, decisions, and constraints your agents share.
				Create it here, then wire your orchestrator to it: vault settings give you a ready-to-paste
				MCP config with a scoped API key.
			</p>
		</div>
	{:else}
		<div class="grid">
			{#each vaults as v (v.id)}
				<a class="card vault" href="/v/{v.slug}">
					<h2>{v.name}</h2>
					<p class="slug"><code>{v.slug}</code></p>
					<p class="muted created">Created {fmtDate(v.createdAt)}</p>
				</a>
			{/each}
		</div>
	{/if}

	<section class="card create">
		<h2>New vault</h2>
		<form onsubmit={createVault}>
			<div class="row">
				<div class="field grow">
					<label for="nv-name">Name</label>
					<input
						id="nv-name"
						class="input"
						bind:value={name}
						oninput={onNameInput}
						placeholder="Acme CRM"
						required
					/>
				</div>
				<div class="field grow">
					<label for="nv-slug">Slug</label>
					<input
						id="nv-slug"
						class="input"
						bind:value={slug}
						oninput={() => (slugTouched = true)}
						placeholder="acme-crm"
						pattern="[a-z0-9\-]*"
					/>
				</div>
			</div>
			{#if error}<p class="error-text" role="alert">{error}</p>{/if}
			<button type="submit" class="btn btn-primary" disabled={creating || !name.trim()}>
				{#if creating}<span class="spinner"></span>{/if}
				Create vault
			</button>
		</form>
	</section>
</main>

<style>
	.page {
		max-width: 860px;
		margin: 0 auto;
		padding: 36px 24px 60px;
	}
	h1 {
		font-size: 24px;
		margin-bottom: 22px;
	}
	.grid {
		display: grid;
		grid-template-columns: repeat(auto-fill, minmax(240px, 1fr));
		gap: 14px;
		margin-bottom: 28px;
	}
	.vault {
		display: block;
		color: var(--text);
		transition: border-color 120ms ease;
	}
	.vault:hover {
		text-decoration: none;
		border-color: var(--accent);
	}
	.vault h2 {
		font-size: 16px;
		margin-bottom: 4px;
	}
	.slug {
		margin: 0 0 8px;
	}
	.created {
		font-size: 12.5px;
		margin: 0;
	}
	.empty {
		text-align: center;
		padding: 40px 26px;
		margin-bottom: 28px;
	}
	.empty .mark {
		font-size: 40px;
		margin-bottom: 10px;
	}
	.empty h2 {
		font-size: 18px;
	}
	.empty p {
		max-width: 480px;
		margin: 0 auto;
	}
	.create h2 {
		font-size: 16px;
		margin-bottom: 14px;
	}
	.row {
		display: flex;
		gap: 12px;
		flex-wrap: wrap;
	}
	.grow {
		flex: 1;
		min-width: 200px;
	}
</style>
