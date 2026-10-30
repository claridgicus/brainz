<script lang="ts">
	import { onMount, untrack } from "svelte";
	import AuthCard from "$lib/components/AuthCard.svelte";

	/**
	 * OAuth consent (Wave OA). Contract with +page.server.ts:
	 *   load → { status: "consent", client: {name, selfAsserted, metadataDocument},
	 *            redirectHost, loopback, userEmail, vaults: [{id, name, slug, role}],
	 *            preTicked, params }
	 *        | { status: "error", message }
	 *   ?/approve (vault_id, repeatable, or all_vaults=on + params) → 303 to the
	 *            client with a code (multi-vault grants: one connection can
	 *            cover several vaults, or all of them including later ones).
	 *            Idempotent per authorize request: a duplicate gets the same code.
	 *   ?/createVault (name + tick, repeatable + params) → 303 back here with the
	 *            new vault pre-ticked ("+ New vault"); never mints a code
	 *   ?/deny (params) → 303 to the client with error=access_denied
	 * Plain (non-enhanced) forms: the browser follows the 303 to the client's
	 * redirect URI itself, which may be another origin or a loopback port.
	 *
	 * Progressive enhancement: without JS every vault is a plain checkbox and
	 * each form submits as is. With JS, more than PICKER_THRESHOLD vaults get a
	 * search box and removable "selected" chips over the same checkboxes, and
	 * the first submit puts the page in a processing state that blocks another.
	 */
	let { data, form } = $props();

	/** More vaults than this: search-and-select instead of a bare checkbox list. */
	const PICKER_THRESHOLD = 5;

	/** "All my vaults, including ones I create or join later". */
	let allVaults = $state(false);
	/** Ticked vault ids, starting from the server's pre-ticks (only the initial data matters). */
	let picked = $state<string[]>(untrack(() => (data.status === "consent" ? [...data.preTicked] : [])));
	/** Hydrated: the search and chips only work with JS, so they stay hidden until then. */
	let enhanced = $state(false);
	let query = $state("");
	/** Which form was submitted; set on the first submit and blocks any other. */
	let busy = $state<"approve" | "create" | "deny" | null>(null);

	onMount(() => {
		enhanced = true;
	});

	const vaults = $derived(data.status === "consent" ? data.vaults : []);
	const usePicker = $derived(vaults.length > PICKER_THRESHOLD);
	const needle = $derived(query.trim().toLowerCase());
	const matches = (v: { name: string; slug: string }) =>
		!needle || v.name.toLowerCase().includes(needle) || v.slug.includes(needle);
	const matchCount = $derived(vaults.filter(matches).length);
	const pickedVaults = $derived(vaults.filter((v) => picked.includes(v.id)));
	const scopeText = $derived(
		allVaults ? "all your vaults, including ones you create or join later" : "the vaults you pick",
	);
	const pickerStatus = $derived(
		allVaults
			? "All your vaults are included, so picking single vaults is off."
			: needle
				? `${matchCount} of ${vaults.length} vaults match`
				: `${picked.length} of ${vaults.length} vaults selected`,
	);

	/** onsubmit for every form: the first submit goes through, any later one is dropped. */
	function once(kind: "approve" | "create" | "deny") {
		return (e: SubmitEvent) => {
			if (busy !== null) {
				e.preventDefault();
				return;
			}
			// Only buttons and name-less controls are disabled by this, so the
			// entry list the browser is about to send is unchanged.
			busy = kind;
		};
	}

	/** Enter in the search box ticks the first unticked match (and never submits the form). */
	function onSearchKey(e: KeyboardEvent) {
		if (e.key === "Enter") {
			e.preventDefault();
			const first = vaults.find((v) => matches(v) && !picked.includes(v.id));
			if (first) {
				picked = [...picked, first.id];
				query = "";
			}
		} else if (e.key === "Escape" && query) {
			e.preventDefault();
			query = "";
		}
	}

	function unpick(id: string) {
		picked = picked.filter((p) => p !== id);
	}

	/** Back/forward cache: a restored page must not stay stuck in "Connecting…". */
	function onPageShow(e: PageTransitionEvent) {
		if (e.persisted) busy = null;
	}
</script>

<svelte:head><title>Connect an app — Brainz</title></svelte:head>
<svelte:window onpageshow={onPageShow} />

{#snippet allOption()}
	<label class="vault all">
		<input type="checkbox" name="all_vaults" bind:checked={allVaults} />
		<span class="name">All my vaults, including ones I create or join later</span>
	</label>
{/snippet}

{#snippet spinner()}<span class="spinner" aria-hidden="true"></span>{/snippet}

{#if data.status === "error"}
	<AuthCard heading="This connection request isn't valid">
		<p class="intro muted">{data.message}</p>
		<p class="intro muted">Start the connection again from the app you were using.</p>
		<a href="/dashboard" class="btn wide">Go to your dashboard</a>
	</AuthCard>
{:else}
	<!-- A client-ID metadata document with a loopback redirect is a program on
	     this computer (Claude Code uses claude.ai's document), not the website
	     that publishes the document. -->
	{@const localApp = data.client.metadataDocument && data.loopback}
	<AuthCard heading={localApp ? "Connect an app on your computer to Brainz" : `Connect ${data.client.name} to Brainz`}>
		<p class="intro muted">
			{#if localApp}
				An app on your computer wants to use Brainz as <strong>{data.userEmail}</strong>. It
				identifies itself with the public client ID published by <strong>{data.client.name}</strong
				>{#if data.client.name === "claude.ai"}, which is how Claude Code connects{/if}.
			{:else}
				<strong>{data.client.name}</strong>{#if data.client.selfAsserted}&nbsp;(the name the app
					gave itself){/if} wants to use Brainz as <strong>{data.userEmail}</strong>.
			{/if}
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

		{#if localApp}
			<p class="warn" role="note">
				It returns to <code>{data.redirectHost}</code> on your own computer, and any program there can
				use a public client ID. Only approve if you just started this connection yourself, e.g. from
				Claude Code.
			</p>
		{:else if data.loopback}
			<p class="warn" role="note">
				This app runs on your own computer (it returns to <code>{data.redirectHost}</code>). Only
				approve if you just started this connection yourself, e.g. from Claude Code.
			</p>
		{/if}

		{#if data.vaults.length === 0}
			<p class="intro muted">You don't have a vault yet. Create one to connect it.</p>
		{:else}
			<form
				id="consent-approve"
				method="POST"
				action="?/approve"
				aria-busy={busy === "approve"}
				onsubmit={once("approve")}
			>
				{#each Object.entries(data.params) as [name, value] (name)}
					<input type="hidden" {name} {value} />
				{/each}
				<fieldset class="vaults" class:picker={usePicker} data-picker={usePicker ? "search" : "list"}>
					<legend>Vaults</legend>
					{#if usePicker}
						{@render allOption()}
						<div class="search" hidden={!enhanced}>
							<label class="sr-only" for="vault-search">Search your vaults</label>
							<input
								id="vault-search"
								class="input"
								type="search"
								placeholder="Search {data.vaults.length} vaults by name or slug"
								autocomplete="off"
								aria-controls="vault-options"
								aria-describedby="vault-picker-status"
								bind:value={query}
								onkeydown={onSearchKey}
								disabled={allVaults}
							/>
							{#if pickedVaults.length > 0 && !allVaults}
								<ul class="chips" aria-label="Selected vaults">
									{#each pickedVaults as vault (vault.id)}
										<li>
											<button
												type="button"
												class="chip"
												aria-label="Remove {vault.name}"
												onclick={() => unpick(vault.id)}
											>
												<span>{vault.name}</span><span class="x" aria-hidden="true">×</span>
											</button>
										</li>
									{/each}
								</ul>
							{/if}
							<p id="vault-picker-status" class="picker-status muted" aria-live="polite">
								{pickerStatus}
							</p>
						</div>
					{/if}
					<div id="vault-options" class="options">
						{#each data.vaults as vault (vault.id)}
							<label
								class="vault"
								class:dim={allVaults}
								hidden={usePicker && enhanced && !matches(vault)}
								data-slug={vault.slug}
							>
								{#if allVaults}
									<input type="checkbox" checked disabled />
								{:else}
									<input type="checkbox" name="vault_id" value={vault.id} bind:group={picked} />
								{/if}
								<span class="name">{vault.name}</span>
								<span class="role muted">{vault.role === "viewer" ? "read-only" : vault.role}</span>
							</label>
						{/each}
						{#if usePicker && enhanced && matchCount === 0}
							<p class="no-match muted">No vault matches “{query.trim()}”.</p>
						{/if}
					</div>
					{#if !usePicker}
						{@render allOption()}
						{#if allVaults}
							<p class="picker-status muted">All your vaults are included, so picking single vaults is off.</p>
						{/if}
					{/if}
				</fieldset>
				{#if form?.error}<p class="error-text" role="alert">{form.error}</p>{/if}
			</form>
		{/if}
		<!-- "+ New vault" sits above Allow: it creates the vault and comes back here
		     with it ticked; it never connects by itself. -->
		<form
			method="POST"
			action="?/createVault"
			class="new-vault"
			aria-busy={busy === "create"}
			onsubmit={once("create")}
		>
			{#each Object.entries(data.params) as [name, value] (name)}
				<input type="hidden" {name} {value} />
			{/each}
			{#each picked as id (id)}
				<input type="hidden" name="tick" value={id} />
			{/each}
			<label class="sr-only" for="new-vault-name">New vault name</label>
			<div class="new-vault-row">
				<input
					id="new-vault-name"
					class="input"
					type="text"
					name="name"
					placeholder="New vault name"
					maxlength="120"
					required
					readonly={busy === "create"}
				/>
				<button type="submit" class="btn" disabled={busy !== null}>
					{#if busy === "create"}{@render spinner()}Creating…{:else}+ New vault{/if}
				</button>
			</div>
			{#if form?.createError}<p class="error-text" role="alert">{form.createError}</p>{/if}
		</form>
		{#if data.vaults.length > 0}
			<!-- Outside its form (form="consent-approve") so "+ New vault" can sit above it. -->
			<button
				type="submit"
				form="consent-approve"
				class="btn btn-primary wide allow"
				disabled={busy !== null || (!allVaults && picked.length === 0)}
			>
				{#if busy === "approve"}{@render spinner()}Connecting…{:else}Allow access{/if}
			</button>
		{/if}
		<form method="POST" action="?/deny" class="deny" onsubmit={once("deny")}>
			{#each Object.entries(data.params) as [name, value] (name)}
				<input type="hidden" {name} {value} />
			{/each}
			<button type="submit" class="btn btn-ghost wide" disabled={busy !== null}>Cancel</button>
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
		min-width: 0;
	}
	.vaults legend {
		font-size: 11.5px;
		font-weight: 600;
		color: var(--text-dim);
		text-transform: uppercase;
		letter-spacing: 0.06em;
		margin-bottom: 6px;
	}
	.options {
		display: flex;
		flex-direction: column;
		gap: 6px;
	}
	.picker .options {
		max-height: 232px;
		overflow-y: auto;
		padding-right: 2px;
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
	.vault[hidden] {
		display: none;
	}
	.vault:has(input:checked:not(:disabled)) {
		border-color: var(--border-strong);
		background: var(--accent-soft);
	}
	.vault:has(input:focus-visible) {
		border-color: var(--accent);
	}
	.vault .name {
		flex: 1;
		font-size: 13.5px;
		overflow-wrap: anywhere;
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
	.search {
		display: flex;
		flex-direction: column;
		gap: 8px;
	}
	.search[hidden] {
		display: none;
	}
	.search .input:disabled {
		opacity: 0.6;
		cursor: not-allowed;
	}
	.chips {
		list-style: none;
		margin: 0;
		padding: 0;
		display: flex;
		flex-wrap: wrap;
		gap: 6px;
	}
	.chip {
		display: inline-flex;
		align-items: center;
		gap: 6px;
		max-width: 100%;
		padding: 3px 6px 3px 10px;
		font: inherit;
		font-size: 12.5px;
		color: var(--text);
		background: var(--accent-soft);
		border: 1px solid var(--border-strong);
		border-radius: 999px;
		cursor: pointer;
	}
	.chip span:first-child {
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
	}
	.chip:hover,
	.chip:focus-visible {
		border-color: var(--accent);
		outline: none;
	}
	.chip .x {
		color: var(--text-dim);
		font-size: 14px;
		line-height: 1;
	}
	.picker-status,
	.no-match {
		font-size: 12px;
		margin: 0;
	}
	.no-match {
		padding: 6px 2px;
	}
	.wide {
		width: 100%;
		margin-top: 4px;
	}
	.new-vault {
		margin: 0 0 12px;
		display: flex;
		flex-direction: column;
		gap: 6px;
	}
	.new-vault-row {
		display: flex;
		gap: 8px;
	}
	.new-vault-row .input {
		flex: 1;
		min-width: 0;
		padding-top: 7px;
		padding-bottom: 7px;
	}
	.new-vault-row .btn {
		white-space: nowrap;
	}
	.deny {
		margin-top: 8px;
	}
	.spinner {
		width: 13px;
		height: 13px;
		margin-right: 8px;
		border: 2px solid currentColor;
		border-right-color: transparent;
		border-radius: 50%;
		display: inline-block;
		vertical-align: -2px;
		animation: spin 700ms linear infinite;
	}
	@keyframes spin {
		to {
			transform: rotate(360deg);
		}
	}
	@media (prefers-reduced-motion: reduce) {
		.spinner {
			animation-duration: 2s;
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
	.fineprint {
		font-size: 12px;
		margin: 12px 0 0;
		text-align: center;
	}
</style>
