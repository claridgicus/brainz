<script lang="ts">
	import AuthCard from "$lib/components/AuthCard.svelte";

	/**
	 * OAuth consent (Wave OA). Contract with +page.server.ts:
	 *   load → { status: "consent", client: {name, selfAsserted}, redirectHost,
	 *            loopback, userEmail, vaults: [{id, name, role}], params }
	 *        | { status: "error", message }
	 *   ?/approve (vault_id + params) → 303 to the client with a code
	 *   ?/deny (params) → 303 to the client with error=access_denied
	 * Plain (non-enhanced) forms: the browser follows the 303 to the client's
	 * redirect URI itself, which may be another origin or a loopback port.
	 */
	let { data, form } = $props();
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
				<dd>Search, read and write the concepts and tasks in the vault you pick</dd>
			</div>
			<div>
				<dt>It can't</dt>
				<dd>See your other vaults, manage keys or members, or delete the vault</dd>
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
			<p class="intro muted">You don't have a vault yet. Create one, then connect again.</p>
			<a href="/dashboard" class="btn btn-primary wide">Create a vault</a>
		{:else}
			<form method="POST" action="?/approve">
				{#each Object.entries(data.params) as [name, value] (name)}
					<input type="hidden" {name} {value} />
				{/each}
				<fieldset class="vaults">
					<legend>Vault</legend>
					{#each data.vaults as vault, i (vault.id)}
						<label class="vault">
							<input type="radio" name="vault_id" value={vault.id} checked={i === 0} required />
							<span class="name">{vault.name}</span>
							<span class="role muted">{vault.role === "viewer" ? "read-only" : vault.role}</span>
						</label>
					{/each}
				</fieldset>
				{#if form?.error}<p class="error-text" role="alert">{form.error}</p>{/if}
				<button type="submit" class="btn btn-primary wide">Allow access</button>
			</form>
		{/if}
		<form method="POST" action="?/deny">
			{#each Object.entries(data.params) as [name, value] (name)}
				<input type="hidden" {name} {value} />
			{/each}
			<button type="submit" class="btn btn-ghost wide">Cancel</button>
		</form>
		<p class="fineprint muted">
			You can disconnect at any time from the app. Each connection covers one vault; connect again
			to add another.
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
	.wide {
		width: 100%;
		margin-top: 4px;
	}
	form + form {
		margin-top: 8px;
	}
	.fineprint {
		font-size: 12px;
		margin: 12px 0 0;
		text-align: center;
	}
</style>
