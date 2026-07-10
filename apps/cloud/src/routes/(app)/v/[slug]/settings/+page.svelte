<script lang="ts">
	import { goto } from "$app/navigation";
	import type { ApiKey } from "@brainz/contracts";
	import { ApiError, createApi } from "$lib/api";
	import CopyButton from "$lib/components/CopyButton.svelte";
	import Modal from "$lib/components/Modal.svelte";

	let { data } = $props();
	const api = createApi(fetch);
	const vault = $derived(data.vault);

	const errMsg = (err: unknown, fallback: string) =>
		err instanceof ApiError ? err.message : fallback;

	// ---------------------------------------------------------------- rename
	// Intentionally seeded once from the load — this is an edit buffer.
	// svelte-ignore state_referenced_locally
	let name = $state(data.vault.name);
	let renaming = $state(false);
	let renameError = $state<string | null>(null);
	let renamed = $state(false);

	async function rename(ev: SubmitEvent) {
		ev.preventDefault();
		renaming = true;
		renameError = null;
		renamed = false;
		try {
			await api.updateVault(vault.id, { name: name.trim() });
			renamed = true;
		} catch (err) {
			renameError = errMsg(err, "Rename failed.");
		} finally {
			renaming = false;
		}
	}

	// --------------------------------------------------------------- api keys
	// svelte-ignore state_referenced_locally
	let keys = $state<ApiKey[]>(data.keys);
	let newKeyName = $state("");
	let creatingKey = $state(false);
	let keyError = $state<string | null>(null);
	/** Plaintext shown exactly once, straight from the create response. */
	let freshKey = $state<{ name: string; key: string } | null>(null);
	let revokeTarget = $state<ApiKey | null>(null);
	let revoking = $state(false);
	let revokeError = $state<string | null>(null);

	async function createKey(ev: SubmitEvent) {
		ev.preventDefault();
		creatingKey = true;
		keyError = null;
		try {
			const created = await api.createKey(vault.id, newKeyName.trim());
			freshKey = { name: created.name, key: created.key };
			newKeyName = "";
			keys = await api.listKeys(vault.id);
		} catch (err) {
			keyError = errMsg(err, "Failed to create key.");
		} finally {
			creatingKey = false;
		}
	}

	async function revokeKey() {
		if (!revokeTarget) return;
		revoking = true;
		revokeError = null;
		try {
			await api.revokeKey(revokeTarget.id);
			keys = keys.filter((k) => k.id !== revokeTarget!.id);
			revokeTarget = null;
		} catch (err) {
			revokeError = errMsg(err, "Failed to revoke key.");
		} finally {
			revoking = false;
		}
	}

	const fmtDate = (iso: string) =>
		new Date(iso).toLocaleDateString(undefined, { year: "numeric", month: "short", day: "numeric" });

	// --------------------------------------------------------------- mcp docs
	const MCP_URL = "https://brain.brownmatter.ai/mcp";
	const mcpJson = (key: string) => `{
  "mcpServers": {
    "brainz": {
      "type": "http",
      "url": "${MCP_URL}",
      "headers": { "Authorization": "Bearer ${key}" }
    }
  }
}`;
	const mcpCli = (key: string) =>
		`claude mcp add --transport http brainz ${MCP_URL} --header "Authorization: Bearer ${key}"`;
	const keyPlaceholder = "<your key>";

	// ------------------------------------------------------------ danger zone
	let confirmSlug = $state("");
	let deleting = $state(false);
	let deleteError = $state<string | null>(null);

	async function deleteVault(ev: SubmitEvent) {
		ev.preventDefault();
		if (confirmSlug !== vault.slug) return;
		deleting = true;
		deleteError = null;
		try {
			await api.deleteVault(vault.id);
			await goto("/dashboard");
		} catch (err) {
			deleteError = errMsg(err, "Failed to delete vault.");
			deleting = false;
		}
	}
</script>

<svelte:head><title>Settings · {vault.name} — Brainz</title></svelte:head>

<main class="page">
	<nav class="crumbs">
		<a href="/v/{vault.slug}">← {vault.name}</a>
	</nav>
	<h1>Vault settings</h1>

	<!-- ------------------------------------------------------------ rename -->
	<section class="card">
		<h2>Vault name</h2>
		<form onsubmit={rename} class="row">
			<input class="input grow" bind:value={name} aria-label="Vault name" required />
			<button type="submit" class="btn" disabled={renaming || !name.trim() || name.trim() === vault.name}>
				{#if renaming}<span class="spinner"></span>{/if}
				Rename
			</button>
		</form>
		{#if renameError}<p class="error-text" role="alert">{renameError}</p>{/if}
		{#if renamed}<p class="ok-text" role="status">Renamed.</p>{/if}
		<p class="muted note">Slug stays <code>{vault.slug}</code> — it's part of your URLs.</p>
	</section>

	<!-- ---------------------------------------------------------- api keys -->
	<section class="card">
		<h2>API keys</h2>
		<p class="muted">
			Keys are scoped to this vault only, hashed at rest, and shown exactly once at creation.
			Use them as <code>Authorization: Bearer bz_…</code> for the REST API and MCP.
		</p>

		<form onsubmit={createKey} class="row">
			<input
				class="input grow"
				bind:value={newKeyName}
				placeholder="Key name, e.g. orchestrator-prod"
				aria-label="New key name"
				required
			/>
			<button type="submit" class="btn btn-primary" disabled={creatingKey || !newKeyName.trim()}>
				{#if creatingKey}<span class="spinner"></span>{/if}
				Create key
			</button>
		</form>
		{#if keyError}<p class="error-text" role="alert">{keyError}</p>{/if}

		{#if keys.length === 0}
			<p class="muted">No keys yet.</p>
		{:else}
			<div class="table-wrap">
				<table>
					<thead>
						<tr><th>Name</th><th>Key</th><th>Created</th><th>Last used</th><th></th></tr>
					</thead>
					<tbody>
						{#each keys as k (k.id)}
							<tr>
								<td>{k.name}</td>
								<td><code>{k.keyPrefix}…</code></td>
								<td>{fmtDate(k.createdAt)}</td>
								<td>{k.lastUsedAt ? fmtDate(k.lastUsedAt) : "never"}</td>
								<td class="ta-right">
									<button type="button" class="btn btn-danger btn-sm" onclick={() => { revokeError = null; revokeTarget = k; }}>
										Revoke
									</button>
								</td>
							</tr>
						{/each}
					</tbody>
				</table>
			</div>
		{/if}
	</section>

	<!-- --------------------------------------------------------- mcp setup -->
	<section class="card">
		<h2>Connect your orchestrator (MCP)</h2>
		<p class="muted">
			Point any MCP-capable agent at this vault. Create a key above, then swap it in for
			<code>{keyPlaceholder}</code>.
		</p>

		<div class="snippet">
			<div class="snippet-head">
				<span>.mcp.json</span>
				<CopyButton text={mcpJson(keyPlaceholder)} />
			</div>
			<pre>{mcpJson(keyPlaceholder)}</pre>
		</div>

		<div class="snippet">
			<div class="snippet-head">
				<span>Claude Code</span>
				<CopyButton text={mcpCli(keyPlaceholder)} />
			</div>
			<pre>{mcpCli(keyPlaceholder)}</pre>
		</div>

		<p class="muted note">
			Agents can also self-provision: connecting to <code>{MCP_URL}</code> with no
			<code>Authorization</code> header exposes a public <code>signup</code> tool that creates an
			account, a vault, and a working API key — and returns a claim link for the human to take
			ownership later.
		</p>
	</section>

	<!-- -------------------------------------------------------- danger zone -->
	<section class="card danger-zone">
		<h2>Danger zone</h2>
		<p class="muted">
			Deleting a vault destroys every concept, edge, and API key in it. This cannot be undone.
		</p>
		<form onsubmit={deleteVault}>
			<div class="field">
				<label for="dz-slug">Type <code>{vault.slug}</code> to confirm</label>
				<input id="dz-slug" class="input" bind:value={confirmSlug} autocomplete="off" />
			</div>
			{#if deleteError}<p class="error-text" role="alert">{deleteError}</p>{/if}
			<button type="submit" class="btn btn-danger" disabled={deleting || confirmSlug !== vault.slug}>
				{#if deleting}<span class="spinner"></span>{/if}
				Delete this vault
			</button>
		</form>
	</section>
</main>

<!-- Plaintext key: the ONE time it's visible. -->
{#if freshKey}
	<Modal title="API key created" onclose={() => (freshKey = null)}>
		<p>
			Key <strong>{freshKey.name}</strong> — copy it now.
			<strong>You won't see this again.</strong>
		</p>
		<div class="key-row">
			<code class="key">{freshKey.key}</code>
			<CopyButton text={freshKey.key} />
		</div>
		<button type="button" class="btn" onclick={() => (freshKey = null)}>Done — I copied it</button>
	</Modal>
{/if}

{#if revokeTarget}
	<Modal title="Revoke key" onclose={() => (revokeTarget = null)}>
		<p>
			Revoke <strong>{revokeTarget.name}</strong> (<code>{revokeTarget.keyPrefix}…</code>)?
			Anything using it loses access immediately.
		</p>
		{#if revokeError}<p class="error-text" role="alert">{revokeError}</p>{/if}
		<div class="row">
			<button type="button" class="btn btn-danger" onclick={revokeKey} disabled={revoking}>
				{#if revoking}<span class="spinner"></span>{/if}
				Revoke
			</button>
			<button type="button" class="btn" onclick={() => (revokeTarget = null)} disabled={revoking}>
				Cancel
			</button>
		</div>
	</Modal>
{/if}

<style>
	.page {
		max-width: 760px;
		margin: 0 auto;
		padding: 28px 24px 60px;
		display: flex;
		flex-direction: column;
		gap: 18px;
	}
	.crumbs {
		font-size: 13.5px;
	}
	h1 {
		font-size: 22px;
		margin: 0;
	}
	h2 {
		font-size: 16px;
		margin-bottom: 10px;
	}
	.row {
		display: flex;
		gap: 10px;
		align-items: flex-start;
		flex-wrap: wrap;
		margin-bottom: 10px;
	}
	.grow {
		flex: 1;
		min-width: 220px;
	}
	.note {
		font-size: 13px;
		margin: 8px 0 0;
	}
	.ok-text {
		color: var(--ok);
		font-size: 13.5px;
		margin: 0 0 8px;
	}

	.table-wrap {
		overflow-x: auto;
		border: 1px solid var(--border);
		border-radius: 10px;
		margin-top: 12px;
	}
	table {
		border-collapse: collapse;
		width: 100%;
		font-size: 13.5px;
	}
	th,
	td {
		text-align: left;
		padding: 9px 12px;
		border-bottom: 1px solid var(--border);
		white-space: nowrap;
	}
	tbody tr:last-child td {
		border-bottom: none;
	}
	th {
		color: var(--text-dim);
		font-size: 11.5px;
		text-transform: uppercase;
		letter-spacing: 0.06em;
	}
	.ta-right {
		text-align: right;
	}

	.snippet {
		margin-top: 14px;
	}
	.snippet-head {
		display: flex;
		align-items: center;
		justify-content: space-between;
		font-size: 12px;
		font-weight: 650;
		color: var(--text-dim);
		text-transform: uppercase;
		letter-spacing: 0.06em;
		margin-bottom: 6px;
	}
	.snippet pre {
		margin: 0;
	}

	.danger-zone {
		border-color: rgb(248 113 113 / 0.35);
	}

	.key-row {
		display: flex;
		align-items: center;
		gap: 10px;
		margin: 4px 0 16px;
	}
	.key {
		flex: 1;
		padding: 8px 10px;
		font-size: 13px;
		word-break: break-all;
		background: var(--bg);
	}
</style>
