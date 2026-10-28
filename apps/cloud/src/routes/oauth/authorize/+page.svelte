<script lang="ts">
	import { untrack } from "svelte";
	import AuthCard from "$lib/components/AuthCard.svelte";

	/**
	 * OAuth consent (Wave OA). Contract with +page.server.ts:
	 *   load → { status: "consent", client: {name, selfAsserted}, redirectHost,
	 *            loopback, userEmail, vaults: [{id, name, role}], preTicked, params }
	 *        | { status: "error", message }
	 *   ?/approve (vault_id, repeatable, or all_vaults=on + params) → 303 to the
	 *            client with a code (multi-vault grants: one connection can
	 *            cover several vaults, or all of them including later ones)
	 *   ?/createVault (name + tick, repeatable + params) → 303 back here with the
	 *            new vault pre-ticked ("+ New vault"); never mints a code
	 *   ?/deny (params) → 303 to the client with error=access_denied
	 * Plain (non-enhanced) forms: the browser follows the 303 to the client's
	 * redirect URI itself, which may be another origin or a loopback port.
	 */
	let { data, form } = $props();

	/** "All my vaults, including ones I create or join later". */
	let allVaults = $state(false);
	/** Ticked vault ids, starting from the server's pre-ticks (only the initial data matters). */
	let picked = $state<string[]>(untrack(() => (data.status === "consent" ? [...data.preTicked] : [])));
	const scopeText = $derived(
		allVaults
			? "all your vaults, including ones you create or join later"
			: picked.length === 1
				? "the vault you pick"
				: `the ${picked.length} vaults you pick`,
	);
</script>

<svelte:head><title>Connect an app — Brainz</title></svelte:head>

{#if data.status === "error"}
	<AuthCard heading="This connection request isn't valid">
		<p class="intro muted">{data.message}</p>
		<p class="intro muted">Start the connection again from the app you were using.</p>
		<a href="/dashboard" class="btn wide">Go to your dashboard</a>
	</AuthCard>
{:else}
	<AuthCard heading="Connect {data.client.name} to Brainz">
		<p class="intro muted">
			<strong>{data.client.name}</strong>{#if data.client.selfAsserted}&nbsp;(the name the app gave
				itself){/if} wants to use Brainz as <strong>{data.userEmail}</strong>.
		</p>

		<dl class="details">
			<div>
				<dt>It will be able to</dt>
				<dd>
					Search, read and write the concepts and tasks in {scopeText} (read only where you're a
					viewer)
				</dd>
			</div>
			<div>
				<dt>It can't</dt>
				<dd>
					{allVaults ? "Manage" : "See vaults you don't pick, manage"} keys or members, or delete a vault
				</dd>
			</div>
			<div>
				<dt>Sends you back to</dt>
				<dd><code>{data.redirectHost}</code></dd>
			</div>
		</dl>

		{#if data.loopback}
			<p class="warn" role="note">
				This app runs on your own computer (it returns to <code>{data.redirectHost}</code>). Only
				approve if you just started this connection yourself, e.g. from Claude Code.
			</p>
		{/if}

		{#if data.vaults.length === 0}
			<p class="intro muted">You don't have a vault yet. Create one to connect it.</p>
		{:else}
			<form method="POST" action="?/approve">
				{#each Object.entries(data.params) as [name, value] (name)}
					<input type="hidden" {name} {value} />
				{/each}
				<fieldset class="vaults">
					<legend>Vaults</legend>
					{#each data.vaults as vault (vault.id)}
						<label class="vault" class:dim={allVaults}>
							{#if allVaults}
								<input type="checkbox" checked disabled />
							{:else}
								<input type="checkbox" name="vault_id" value={vault.id} bind:group={picked} />
							{/if}
							<span class="name">{vault.name}</span>
							<span class="role muted">{vault.role === "viewer" ? "read-only" : vault.role}</span>
						</label>
					{/each}
					<label class="vault all">
						<input type="checkbox" name="all_vaults" bind:checked={allVaults} />
						<span class="name">All my vaults, including ones I create or join later</span>
					</label>
				</fieldset>
				{#if form?.error}<p class="error-text" role="alert">{form.error}</p>{/if}
				<button type="submit" class="btn btn-primary wide" disabled={!allVaults && picked.length === 0}>
					Allow access
				</button>
			</form>
		{/if}
		<!-- "+ New vault": creates the vault and comes back here with it ticked; it never connects by itself. -->
		<form method="POST" action="?/createVault" class="new-vault">
			{#each Object.entries(data.params) as [name, value] (name)}
				<input type="hidden" {name} {value} />
			{/each}
			{#each picked as id (id)}
				<input type="hidden" name="tick" value={id} />
			{/each}
			<label class="new-vault-name">
				<span class="sr-only">New vault name</span>
				<input type="text" name="name" placeholder="New vault name" maxlength="120" required />
			</label>
			<button type="submit" class="btn wide">+ New vault</button>
			{#if form?.createError}<p class="error-text" role="alert">{form.createError}</p>{/if}
		</form>
		<form method="POST" action="?/deny">
			{#each Object.entries(data.params) as [name, value] (name)}
				<input type="hidden" {name} {value} />
			{/each}
			<button type="submit" class="btn btn-ghost wide">Cancel</button>
		</form>
		<p class="fineprint muted">
			You can disconnect at any time from the app. To change which vaults it covers, connect
			again.
		</p>
	</AuthCard>
{/if}

<style>
	.intro {
		font-size: 13.5px;
		margin: 0 0 16px;
	}
	.intro strong {
		color: var(--text);
	}
	.details {
		margin: 0 0 16px;
		padding: 12px 14px;
		background: var(--bg-deep);
		border: 1px solid var(--border);
		border-radius: 8px;
		display: flex;
		flex-direction: column;
		gap: 8px;
	}
	.details > div {
		display: flex;
		justify-content: space-between;
		align-items: baseline;
		gap: 12px;
	}
	.details dt {
		font-size: 11.5px;
		font-weight: 600;
		color: var(--text-dim);
		text-transform: uppercase;
		letter-spacing: 0.06em;
		white-space: nowrap;
	}
	.details dd {
		margin: 0;
		font-size: 13.5px;
		text-align: right;
		overflow-wrap: anywhere;
	}
	.warn {
		font-size: 12.5px;
		margin: 0 0 16px;
		padding: 10px 12px;
		border: 1px solid var(--border);
		border-left: 3px solid var(--warn, #c98a2b);
		border-radius: 6px;
	}
	.vaults {
		border: 0;
		margin: 0 0 12px;
		padding: 0;
		display: flex;
		flex-direction: column;
		gap: 6px;
	}
	.vaults legend {
		font-size: 11.5px;
		font-weight: 600;
		color: var(--text-dim);
		text-transform: uppercase;
		letter-spacing: 0.06em;
		margin-bottom: 6px;
	}
	.vault {
		display: flex;
		align-items: center;
		gap: 10px;
		padding: 9px 12px;
		border: 1px solid var(--border);
		border-radius: 8px;
		cursor: pointer;
	}
	.vault .name {
		flex: 1;
		font-size: 13.5px;
	}
	.vault .role {
		font-size: 12px;
	}
	.vault.dim {
		opacity: 0.6;
	}
	.vault.all {
		border-style: dashed;
	}
	.wide {
		width: 100%;
		margin-top: 4px;
	}
	form + form {
		margin-top: 8px;
	}
	.new-vault {
		display: flex;
		flex-direction: column;
		gap: 6px;
	}
	.new-vault-name input {
		width: 100%;
		box-sizing: border-box;
	}
	.sr-only {
		position: absolute;
		width: 1px;
		height: 1px;
		overflow: hidden;
		clip: rect(0 0 0 0);
		white-space: nowrap;
	}
	.fineprint {
		font-size: 12px;
		margin: 12px 0 0;
		text-align: center;
	}
</style>
