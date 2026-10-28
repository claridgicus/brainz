<script lang="ts">
	import { goto } from "$app/navigation";
	import type {
		AccountDreaming,
		ApiKey,
		ConceptTypeEntry,
		VaultInvite,
		VaultMember,
		VaultRole,
	} from "@brainz/contracts";
	import { ApiError, createApi, roleOf } from "$lib/api";
	import CopyButton from "$lib/components/CopyButton.svelte";
	import Modal from "$lib/components/Modal.svelte";

	let { data } = $props();
	const api = createApi(fetch);
	const vault = $derived(data.vault);
	const role = $derived(roleOf(data.vault));
	const isOwner = $derived(role === "owner");
	const me = $derived(data.user.id);

	const errMsg = (err: unknown, fallback: string) =>
		err instanceof ApiError ? err.message : fallback;

	const ROLES: VaultRole[] = ["owner", "editor", "viewer"];

	// --------------------------------------------------------------- members
	// svelte-ignore state_referenced_locally
	let members = $state<VaultMember[] | null>(data.members);
	let memberError = $state<string | null>(null);
	let memberBusyId = $state<string | null>(null);
	let removeMemberTarget = $state<VaultMember | null>(null);
	let removingMember = $state(false);
	let removeMemberError = $state<string | null>(null);

	const ownerCount = $derived((members ?? []).filter((m) => m.role === "owner").length);
	const isLastOwner = (m: VaultMember) => m.role === "owner" && ownerCount <= 1;

	/** Optimistic role change with rollback — the server's error message (e.g.
	 * the last-owner guard) is surfaced verbatim. */
	async function changeRole(m: VaultMember, next: VaultRole) {
		if (!members || next === m.role) return;
		const snapshot = members;
		memberError = null;
		memberBusyId = m.userId;
		members = members.map((x) => (x.userId === m.userId ? { ...x, role: next } : x));
		try {
			const updated = await api.updateMemberRole(vault.id, m.userId, next);
			members = (members ?? []).map((x) => (x.userId === m.userId ? updated : x));
		} catch (err) {
			members = snapshot;
			memberError = errMsg(err, "Failed to change role.");
		} finally {
			memberBusyId = null;
		}
	}

	async function confirmRemoveMember() {
		if (!removeMemberTarget) return;
		const target = removeMemberTarget;
		removingMember = true;
		removeMemberError = null;
		try {
			await api.removeMember(vault.id, target.userId);
			if (target.userId === me) {
				await goto("/dashboard");
				return;
			}
			members = (members ?? []).filter((x) => x.userId !== target.userId);
			removeMemberTarget = null;
		} catch (err) {
			removeMemberError = errMsg(err, "Failed to remove member.");
		} finally {
			removingMember = false;
		}
	}

	// -------------------------------------------------------- concept types
	// The per-vault type registry (Wave TR): list built-in + custom types, edit
	// label/color/weight/order/hide, add a custom type. Owner/editor gated (the
	// server enforces the role; viewers see a read-only list). Re-weighting a type
	// shifts where it appears in the graph's zoom progression and its node size.
	// svelte-ignore state_referenced_locally
	let types = $state<ConceptTypeEntry[] | null>(data.types);
	const canEditTypes = $derived(role !== "viewer");
	let typesError = $state<string | null>(null);
	let typeBusyKey = $state<string | null>(null);

	/** Persist one field change on a type (optimistic, with rollback). */
	async function patchType(t: ConceptTypeEntry, patch: Partial<ConceptTypeEntry>) {
		if (!types) return;
		const snapshot = types;
		typesError = null;
		typeBusyKey = t.key;
		types = types.map((x) => (x.key === t.key ? { ...x, ...patch } : x));
		try {
			const updated = await api.updateType(vault.id, t.key, {
				label: patch.label,
				color: patch.color,
				weight: patch.weight,
				order: patch.order,
				hidden: patch.hidden,
			});
			types = (types ?? []).map((x) => (x.key === t.key ? updated : x));
		} catch (err) {
			types = snapshot;
			typesError = errMsg(err, "Failed to update type.");
		} finally {
			typeBusyKey = null;
		}
	}

	// New-custom-type form.
	let newTypeLabel = $state("");
	let newTypeColor = $state("#a78bfa");
	let newTypeWeight = $state(40);
	let addingType = $state(false);
	const newTypeKeyPreview = $derived(
		newTypeLabel
			.trim()
			.toLowerCase()
			.replace(/[^a-z0-9]+/g, "-")
			.replace(/^-+|-+$/g, ""),
	);

	async function addType(e: SubmitEvent) {
		e.preventDefault();
		if (!types || !newTypeKeyPreview) return;
		addingType = true;
		typesError = null;
		try {
			const created = await api.createType(vault.id, {
				key: newTypeKeyPreview,
				label: newTypeLabel.trim() || newTypeKeyPreview,
				color: newTypeColor,
				weight: newTypeWeight,
			});
			types = [...(types ?? []), created];
			newTypeLabel = "";
			newTypeColor = "#a78bfa";
			newTypeWeight = 40;
		} catch (err) {
			typesError = errMsg(err, "Failed to add type.");
		} finally {
			addingType = false;
		}
	}

	let deleteTypeTarget = $state<ConceptTypeEntry | null>(null);
	let deletingType = $state(false);
	let deleteTypeError = $state<string | null>(null);

	async function confirmDeleteType() {
		if (!deleteTypeTarget) return;
		const target = deleteTypeTarget;
		deletingType = true;
		deleteTypeError = null;
		try {
			await api.deleteType(vault.id, target.key);
			types = (types ?? []).filter((x) => x.key !== target.key);
			deleteTypeTarget = null;
		} catch (err) {
			deleteTypeError = errMsg(err, "Failed to delete type.");
		} finally {
			deletingType = false;
		}
	}

	// --------------------------------------------------------------- invites
	// svelte-ignore state_referenced_locally
	let invites = $state<VaultInvite[] | null>(data.invites);
	let inviteEmail = $state("");
	let inviteRole = $state<VaultRole>("editor");
	let sendingInvite = $state(false);
	let inviteError = $state<string | null>(null);
	/** One-time invite URL, straight from the create/resend response. */
	let freshInvite = $state<{ email: string; url: string } | null>(null);
	let inviteBusy = $state<{ id: string; action: "resend" | "revoke" } | null>(null);

	async function sendInvite(ev: SubmitEvent) {
		ev.preventDefault();
		sendingInvite = true;
		inviteError = null;
		try {
			const created = await api.createInvite(vault.id, {
				email: inviteEmail.trim(),
				role: inviteRole,
			});
			freshInvite = { email: created.invite.email, url: created.url };
			inviteEmail = "";
			invites = await api.listInvites(vault.id);
		} catch (err) {
			inviteError = errMsg(err, "Failed to send invite.");
		} finally {
			sendingInvite = false;
		}
	}

	async function resendInvite(inv: VaultInvite) {
		inviteBusy = { id: inv.id, action: "resend" };
		inviteError = null;
		try {
			const sent = await api.resendInvite(vault.id, inv.id);
			freshInvite = { email: sent.invite.email, url: sent.url };
			invites = (invites ?? []).map((x) => (x.id === inv.id ? sent.invite : x));
		} catch (err) {
			inviteError = errMsg(err, "Failed to resend invite.");
		} finally {
			inviteBusy = null;
		}
	}

	async function revokeInvite(inv: VaultInvite) {
		inviteBusy = { id: inv.id, action: "revoke" };
		inviteError = null;
		try {
			await api.revokeInvite(vault.id, inv.id);
			invites = (invites ?? []).filter((x) => x.id !== inv.id);
		} catch (err) {
			inviteError = errMsg(err, "Failed to revoke invite.");
		} finally {
			inviteBusy = null;
		}
	}

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

	// --------------------------------------------------------- public access
	// Owner-only. `publicEnabled` mirrors the vault's stored flag; the token +
	// /public/<token> URL are shown EXACTLY once (enable/rotate) — only the hash
	// is stored, so a live link cannot be re-displayed. Rotate mints a new token
	// (old link dies); disable revokes.
	// svelte-ignore state_referenced_locally
	let publicEnabled = $state<boolean>(data.publicStatus?.enabled ?? false);
	let publicBusy = $state<null | "enable" | "rotate" | "disable">(null);
	let publicError = $state<string | null>(null);
	/** One-time public token + URL, straight from the enable/rotate response. */
	let freshPublic = $state<{ token: string; url: string } | null>(null);

	async function enablePublic() {
		publicBusy = "enable";
		publicError = null;
		try {
			const res = await api.enablePublic(vault.id);
			publicEnabled = true;
			freshPublic = { token: res.token, url: res.url };
		} catch (err) {
			publicError = errMsg(err, "Failed to enable public access.");
		} finally {
			publicBusy = null;
		}
	}

	async function rotatePublic() {
		publicBusy = "rotate";
		publicError = null;
		try {
			const res = await api.rotatePublic(vault.id);
			publicEnabled = true;
			freshPublic = { token: res.token, url: res.url };
		} catch (err) {
			publicError = errMsg(err, "Failed to rotate the public link.");
		} finally {
			publicBusy = null;
		}
	}

	async function disablePublic() {
		publicBusy = "disable";
		publicError = null;
		try {
			await api.disablePublic(vault.id);
			publicEnabled = false;
			freshPublic = null;
		} catch (err) {
			publicError = errMsg(err, "Failed to disable public access.");
		} finally {
			publicBusy = null;
		}
	}

	const publicMcpCli = (token: string) =>
		`claude mcp add --transport http brainz-public ${MCP_URL} --header "Authorization: Bearer ${token}"`;

	// -------------------------------------------------------------- dreaming
	// The signed-in user's own account: their BYOK dream LLM key (only its hint
	// is ever shown back) and today's operator-paid dream spend vs the cap.
	// svelte-ignore state_referenced_locally
	let dreaming = $state<AccountDreaming | null>(data.dreaming);
	let llmProvider = $state<"anthropic" | "openai">("anthropic");
	let llmApiKey = $state("");
	let llmBaseUrl = $state("");
	let llmModel = $state("");
	let llmBusy = $state<null | "save" | "remove">(null);
	let llmError = $state<string | null>(null);

	const fmtUsd = (n: number) => `$${n.toFixed(2)}`;

	async function saveLlmKey(ev: SubmitEvent) {
		ev.preventDefault();
		llmBusy = "save";
		llmError = null;
		try {
			dreaming = await api.setLlmKey({
				provider: llmProvider,
				apiKey: llmApiKey.trim(),
				...(llmProvider === "openai" ? { baseUrl: llmBaseUrl.trim() } : {}),
				...(llmModel.trim() ? { model: llmModel.trim() } : {}),
			});
			llmApiKey = "";
		} catch (err) {
			llmError = errMsg(err, "Failed to save the key.");
		} finally {
			llmBusy = null;
		}
	}

	async function removeLlmKey() {
		llmBusy = "remove";
		llmError = null;
		try {
			dreaming = await api.removeLlmKey();
		} catch (err) {
			llmError = errMsg(err, "Failed to remove the key.");
		} finally {
			llmBusy = null;
		}
	}

	// --------------------------------------------------------------- mcp docs
	const MCP_URL = "https://brainz.brownmatter.ai/mcp";
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
	{#if !isOwner}
		<p class="muted role-note">
			You're {role === "editor" ? "an editor" : "a viewer"} on this vault — only owners can rename
			it, manage API keys, or invite members.
		</p>
	{/if}

	{#if isOwner}
		<!-- ---------------------------------------------------------- rename -->
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
	{/if}

	<!-- ----------------------------------------------------------- members -->
	<section class="card">
		<h2>Members</h2>
		{#if members === null}
			<p class="error-text" role="alert">Couldn't load members — reload the page to try again.</p>
		{:else}
			{#if memberError}<p class="error-text" role="alert">{memberError}</p>{/if}
			<div class="table-wrap">
				<table>
					<thead>
						<tr><th>Member</th><th>Role</th><th>Joined</th><th></th></tr>
					</thead>
					<tbody>
						{#each members as m (m.userId)}
							<tr>
								<td>
									<div class="who-cell">
										<span>{m.name}{m.userId === me ? " (you)" : ""}</span>
										<span class="muted who-email">{m.email}</span>
									</div>
								</td>
								<td>
									{#if isOwner}
										<span title={isLastOwner(m) ? "The last owner can't be demoted." : undefined}>
											<select
												class="select role-select"
												value={m.role}
												disabled={isLastOwner(m) || memberBusyId !== null}
												onchange={(e) => void changeRole(m, e.currentTarget.value as VaultRole)}
												aria-label="Role for {m.email}"
											>
												{#each ROLES as r (r)}<option value={r}>{r}</option>{/each}
											</select>
										</span>
									{:else}
										<span class="badge role-{m.role}">{m.role}</span>
									{/if}
								</td>
								<td>{fmtDate(m.createdAt)}</td>
								<td class="ta-right">
									{#if isOwner}
										<span title={isLastOwner(m) ? "The last owner can't leave or be removed." : undefined}>
											<button
												type="button"
												class="btn btn-danger btn-sm"
												disabled={isLastOwner(m) || memberBusyId !== null}
												onclick={() => { removeMemberError = null; removeMemberTarget = m; }}
											>
												{m.userId === me ? "Leave" : "Remove"}
											</button>
										</span>
									{:else if m.userId === me}
										<button
											type="button"
											class="btn btn-danger btn-sm"
											onclick={() => { removeMemberError = null; removeMemberTarget = m; }}
										>
											Leave vault
										</button>
									{/if}
								</td>
							</tr>
						{/each}
					</tbody>
				</table>
			</div>
		{/if}
	</section>

	<!-- ---------------------------------------------------- concept types -->
	<section class="card">
		<h2>Concept types</h2>
		<p class="muted section-hint">
			Types drive the graph's colors, chips, and semantic-zoom. <strong>Weight</strong> is the
			one knob: a higher weight reveals a type earlier as you zoom out and draws its nodes
			larger. Built-in types can be re-weighted, recolored, reordered, and hidden, but not
			deleted (hide them instead). {#if !canEditTypes}<em>Viewers see this read-only.</em>{/if}
		</p>
		{#if types === null}
			<p class="error-text" role="alert">Couldn't load concept types — reload to try again.</p>
		{:else}
			{#if typesError}<p class="error-text" role="alert">{typesError}</p>{/if}
			<div class="table-wrap">
				<table>
					<thead>
						<tr><th>Type</th><th>Color</th><th>Weight</th><th>Order</th><th>Shown</th><th></th></tr>
					</thead>
					<tbody>
						{#each types as t (t.key)}
							<tr class:type-hidden={t.hidden}>
								<td>
									<div class="who-cell">
										{#if canEditTypes}
											<input
												class="input type-label"
												value={t.label}
												disabled={typeBusyKey !== null}
												onchange={(e) => void patchType(t, { label: e.currentTarget.value })}
												aria-label="Label for {t.key}"
											/>
										{:else}
											<span>{t.label}</span>
										{/if}
										<span class="muted who-email">
											{t.key}{t.builtin ? " · built-in" : " · custom"}
										</span>
									</div>
								</td>
								<td>
									<span class="color-cell">
										<span class="dot" style="background:{t.color}"></span>
										{#if canEditTypes}
											<input
												type="color"
												class="color-input"
												value={t.color}
												disabled={typeBusyKey !== null}
												onchange={(e) => void patchType(t, { color: e.currentTarget.value })}
												aria-label="Color for {t.key}"
											/>
										{/if}
									</span>
								</td>
								<td>
									{#if canEditTypes}
										<input
											type="number"
											class="input num-input"
											value={t.weight}
											disabled={typeBusyKey !== null}
											onchange={(e) => void patchType(t, { weight: Number(e.currentTarget.value) })}
											aria-label="Weight for {t.key}"
										/>
									{:else}
										{t.weight}
									{/if}
								</td>
								<td>
									{#if canEditTypes}
										<input
											type="number"
											class="input num-input"
											value={t.order}
											disabled={typeBusyKey !== null}
											onchange={(e) => void patchType(t, { order: Number(e.currentTarget.value) })}
											aria-label="Order for {t.key}"
										/>
									{:else}
										{t.order}
									{/if}
								</td>
								<td>
									<input
										type="checkbox"
										checked={!t.hidden}
										disabled={!canEditTypes || typeBusyKey !== null}
										onchange={(e) => void patchType(t, { hidden: !e.currentTarget.checked })}
										aria-label="Show {t.key} in the graph"
									/>
								</td>
								<td class="ta-right">
									{#if canEditTypes && !t.builtin}
										<button
											type="button"
											class="btn btn-danger btn-sm"
											disabled={typeBusyKey !== null}
											onclick={() => { deleteTypeError = null; deleteTypeTarget = t; }}
										>
											Delete
										</button>
									{/if}
								</td>
							</tr>
						{/each}
					</tbody>
				</table>
			</div>

			{#if canEditTypes}
				<form class="add-type" onsubmit={addType}>
					<div class="field grow">
						<label for="nt-label">New custom type</label>
						<input
							id="nt-label"
							class="input"
							bind:value={newTypeLabel}
							placeholder="Risk"
							maxlength="40"
						/>
						{#if newTypeKeyPreview}
							<span class="muted key-preview">key: {newTypeKeyPreview}</span>
						{/if}
					</div>
					<div class="field">
						<label for="nt-color">Color</label>
						<input id="nt-color" type="color" class="color-input" bind:value={newTypeColor} />
					</div>
					<div class="field">
						<label for="nt-weight">Weight</label>
						<input id="nt-weight" type="number" class="input num-input" bind:value={newTypeWeight} />
					</div>
					<button
						type="submit"
						class="btn btn-primary btn-sm"
						disabled={addingType || !newTypeKeyPreview}
					>
						{addingType ? "Adding…" : "Add type"}
					</button>
				</form>
			{/if}
		{/if}
	</section>

	{#if isOwner}
		<!-- --------------------------------------------------------- invites -->
		<section class="card">
			<h2>Invites</h2>
			<p class="muted">
				Invite a teammate by email — they get a link that signs them in and adds them to this
				vault with the role you pick. Invites expire after 14 days.
			</p>
			<form onsubmit={sendInvite} class="row">
				<input
					class="input grow"
					type="email"
					bind:value={inviteEmail}
					placeholder="teammate@example.com"
					aria-label="Invite email"
					required
				/>
				<select class="select role-select" bind:value={inviteRole} aria-label="Invite role">
					{#each ROLES as r (r)}<option value={r}>{r}</option>{/each}
				</select>
				<button type="submit" class="btn btn-primary" disabled={sendingInvite || !inviteEmail.trim()}>
					{#if sendingInvite}<span class="spinner"></span>{/if}
					Send invite
				</button>
			</form>
			{#if inviteError}<p class="error-text" role="alert">{inviteError}</p>{/if}

			{#if invites === null}
				<p class="error-text" role="alert">Couldn't load pending invites — reload the page to try again.</p>
			{:else if invites.length === 0}
				<p class="muted">No pending invites.</p>
			{:else}
				<div class="table-wrap">
					<table>
						<thead>
							<tr><th>Email</th><th>Role</th><th>Expires</th><th></th></tr>
						</thead>
						<tbody>
							{#each invites as inv (inv.id)}
								<tr>
									<td>{inv.email}</td>
									<td><span class="badge role-{inv.role}">{inv.role}</span></td>
									<td>{fmtDate(inv.expiresAt)}</td>
									<td class="ta-right">
										<div class="row-actions">
											<button
												type="button"
												class="btn btn-sm"
												onclick={() => void resendInvite(inv)}
												disabled={inviteBusy !== null}
											>
												{#if inviteBusy?.id === inv.id && inviteBusy.action === "resend"}<span class="spinner"></span>{/if}
												Resend
											</button>
											<button
												type="button"
												class="btn btn-danger btn-sm"
												onclick={() => void revokeInvite(inv)}
												disabled={inviteBusy !== null}
											>
												{#if inviteBusy?.id === inv.id && inviteBusy.action === "revoke"}<span class="spinner"></span>{/if}
												Revoke
											</button>
										</div>
									</td>
								</tr>
							{/each}
						</tbody>
					</table>
				</div>
			{/if}
		</section>
	{/if}

	{#if isOwner}
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
	{/if}

	{#if isOwner}
	<!-- ------------------------------------------------------ public access -->
	<section class="card">
		<h2>Public access</h2>
		<p class="muted">
			Make this vault readable by anyone with the link — no sign-in, read-only. They get the
			graph, concept panel, search, and context; never members, keys, invites, or any way to
			write. Access is an unguessable, revocable token: rotate to replace the link, disable to
			revoke it. Public vaults are never listed or enumerated.
		</p>

		{#if publicError}<p class="error-text" role="alert">{publicError}</p>{/if}

		{#if !publicEnabled}
			<button
				type="button"
				class="btn btn-primary"
				onclick={enablePublic}
				disabled={publicBusy !== null}
			>
				{#if publicBusy === "enable"}<span class="spinner"></span>{/if}
				Enable public access
			</button>
		{:else}
			<p class="ok-text" role="status">
				Public read-only access is <strong>on</strong>.
				{#if data.publicStatus?.createdAt}Link created {fmtDate(data.publicStatus.createdAt)}.{/if}
			</p>
			<p class="muted note">
				The shareable <code>/public/&lt;token&gt;</code> link and its MCP snippet are shown only
				once, when you enable or rotate — only the token's hash is stored, so a live link can't be
				re-displayed. Lost it? Rotate to mint a new one.
			</p>
			<div class="row">
				<button type="button" class="btn" onclick={rotatePublic} disabled={publicBusy !== null}>
					{#if publicBusy === "rotate"}<span class="spinner"></span>{/if}
					Rotate link
				</button>
				<button
					type="button"
					class="btn btn-danger"
					onclick={disablePublic}
					disabled={publicBusy !== null}
				>
					{#if publicBusy === "disable"}<span class="spinner"></span>{/if}
					Disable
				</button>
			</div>
		{/if}
	</section>
	{/if}

	<!-- ---------------------------------------------------------- dreaming -->
	<section class="card">
		<h2>Dreaming</h2>
		<p class="muted">
			Each night your vaults consolidate themselves ("dreaming"). The thinking step runs on Brainz's
			Workers AI up to a small daily budget per account, or on your own LLM key with no cap. This
			is your account's setting: it applies to every vault you own.
		</p>

		{#if !dreaming}
			<p class="error-text" role="alert">Couldn't load dreaming settings — reload to try again.</p>
		{:else}
			{#if dreaming.killSwitch === "all" || (dreaming.killSwitch === "workers-ai" && !dreaming.key)}
				<p class="muted note" role="status">
					Dreaming on Brainz's AI is paused by the operator right now; vaults still tidy up, but
					skip the thinking step{dreaming.killSwitch === "workers-ai" ? " unless you add your own key" : ""}.
				</p>
			{/if}

			{#if dreaming.key}
				<p class="ok-text" role="status">
					Dreams run on your <strong>{dreaming.key.provider === "anthropic" ? "Anthropic" : "OpenAI-compatible"}</strong>
					key <code>{dreaming.key.hint}</code>{#if dreaming.key.model} · <code>{dreaming.key.model}</code>{/if}{#if dreaming.key.baseUrl} · <code>{dreaming.key.baseUrl}</code>{/if}
					— updated {fmtDate(dreaming.key.updatedAt)}. No daily cap applies.
				</p>
				<div class="row">
					<button
						type="button"
						class="btn btn-danger btn-sm"
						onclick={removeLlmKey}
						disabled={llmBusy !== null}
					>
						{#if llmBusy === "remove"}<span class="spinner"></span>{/if}
						Remove key
					</button>
				</div>
			{:else}
				<p class="muted" role="status">
					Today's dream spend: <strong>{fmtUsd(dreaming.spend.usd)}</strong> of
					{fmtUsd(dreaming.spend.capUsd)} (resets at 00:00 UTC).
				</p>
			{/if}

			<form onsubmit={saveLlmKey}>
				<div class="row">
					<select class="select" bind:value={llmProvider} aria-label="LLM provider">
						<option value="anthropic">Anthropic</option>
						<option value="openai">OpenAI-compatible</option>
					</select>
					<input
						class="input grow"
						type="password"
						bind:value={llmApiKey}
						placeholder={dreaming.key ? "Replace with a new API key" : "Your API key"}
						aria-label="LLM API key"
						autocomplete="off"
						required
					/>
				</div>
				<div class="row">
					{#if llmProvider === "openai"}
						<input
							class="input grow"
							bind:value={llmBaseUrl}
							placeholder="https://api.openai.com/v1"
							aria-label="Base URL"
							required
						/>
					{/if}
					<input
						class="input grow"
						bind:value={llmModel}
						placeholder={llmProvider === "anthropic" ? "Model (default claude-opus-5-5)" : "Model"}
						aria-label="Model"
						required={llmProvider === "openai"}
					/>
					<button type="submit" class="btn btn-primary" disabled={llmBusy !== null || !llmApiKey.trim()}>
						{#if llmBusy === "save"}<span class="spinner"></span>{/if}
						{dreaming.key ? "Replace key" : "Save key"}
					</button>
				</div>
			</form>
			<p class="muted note">
				Keys are encrypted at rest and never shown again — only the last 4 characters. A key that
				fails is recorded in the Dream Diary; dreams never fall back to Brainz's AI.
			</p>
		{/if}
		{#if llmError}<p class="error-text" role="alert">{llmError}</p>{/if}
	</section>

	<!-- --------------------------------------------------------- mcp setup -->
	<section class="card">
		<h2>Connect your orchestrator (MCP)</h2>
		<p class="muted">
			Point any MCP-capable agent at this vault. Create a key above, then swap it in for
			<code>{keyPlaceholder}</code>. Step 1 after connecting: have your agent call the
			<code>onboard</code> tool — it returns a playbook for indexing your product's codebase into
			this vault (domains, features, stories, specs, workflows — each anchored to code areas).
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
			account, a vault, and a working API key — and returns a one-time magic sign-in link the
			human opens to land in the dashboard (passwordless — no password to set).
		</p>
	</section>

	{#if isOwner}
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
	{/if}
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

<!-- Public link + anonymous MCP snippet: the ONE time they're visible. -->
{#if freshPublic}
	<Modal title="Public link ready" onclose={() => (freshPublic = null)}>
		<p>
			Anyone with this link can read the vault — no sign-in. Copy it now.
			<strong>You won't see it again.</strong>
		</p>
		<div class="key-row">
			<code class="key">{freshPublic.url}</code>
			<CopyButton text={freshPublic.url} />
		</div>
		<p class="muted note">Anonymous MCP read access (read-only tools only):</p>
		<div class="snippet">
			<div class="snippet-head">
				<span>Claude Code</span>
				<CopyButton text={publicMcpCli(freshPublic.token)} />
			</div>
			<pre>{publicMcpCli(freshPublic.token)}</pre>
		</div>
		<button type="button" class="btn" onclick={() => (freshPublic = null)}>Done — I copied it</button>
	</Modal>
{/if}

<!-- Invite URL: the ONE time it's visible (same one-shot treatment as keys). -->
{#if freshInvite}
	<Modal title="Invite sent" onclose={() => (freshInvite = null)}>
		<p>
			An invite email is on its way to <strong>{freshInvite.email}</strong>. You can also share
			this link directly — copy it now. <strong>You won't see it again.</strong>
		</p>
		<div class="key-row">
			<code class="key">{freshInvite.url}</code>
			<CopyButton text={freshInvite.url} />
		</div>
		<button type="button" class="btn" onclick={() => (freshInvite = null)}>Done — I copied it</button>
	</Modal>
{/if}

{#if removeMemberTarget}
	<Modal
		title={removeMemberTarget.userId === me ? "Leave vault" : "Remove member"}
		onclose={() => (removeMemberTarget = null)}
	>
		<p>
			{#if removeMemberTarget.userId === me}
				Leave <strong>{vault.name}</strong>? You lose access immediately — an owner would have to
				invite you back.
			{:else}
				Remove <strong>{removeMemberTarget.name}</strong> ({removeMemberTarget.email})? They lose
				access immediately.
			{/if}
		</p>
		{#if removeMemberError}<p class="error-text" role="alert">{removeMemberError}</p>{/if}
		<div class="row">
			<button type="button" class="btn btn-danger" onclick={confirmRemoveMember} disabled={removingMember}>
				{#if removingMember}<span class="spinner"></span>{/if}
				{removeMemberTarget.userId === me ? "Leave vault" : "Remove"}
			</button>
			<button type="button" class="btn" onclick={() => (removeMemberTarget = null)} disabled={removingMember}>
				Cancel
			</button>
		</div>
	</Modal>
{/if}

{#if deleteTypeTarget}
	<Modal title="Delete concept type" onclose={() => (deleteTypeTarget = null)}>
		<p>
			Delete the custom type <strong>{deleteTypeTarget.label}</strong>
			(<code>{deleteTypeTarget.key}</code>)? This can't be undone. Concepts still using it
			must be reassigned first, or the delete is blocked.
		</p>
		{#if deleteTypeError}<p class="error-text" role="alert">{deleteTypeError}</p>{/if}
		<div class="row">
			<button type="button" class="btn btn-danger" onclick={confirmDeleteType} disabled={deletingType}>
				{#if deletingType}<span class="spinner"></span>{/if}
				Delete
			</button>
			<button type="button" class="btn" onclick={() => (deleteTypeTarget = null)} disabled={deletingType}>
				Cancel
			</button>
		</div>
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

	.role-note {
		font-size: 13.5px;
		margin: -8px 0 0;
	}
	.who-cell {
		display: flex;
		flex-direction: column;
		gap: 1px;
		line-height: 1.35;
	}
	.who-email {
		font-size: 12px;
	}
	.role-select {
		width: auto;
		min-width: 108px;
		padding-top: 5px;
		padding-bottom: 5px;
		font-size: 13px;
	}
	.row-actions {
		display: inline-flex;
		gap: 6px;
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

	/* -------------------------------------------------- concept types panel */
	.section-hint {
		margin: -4px 0 14px;
		font-size: 13px;
		line-height: 1.5;
	}
	.type-hidden {
		opacity: 0.55;
	}
	.type-label {
		max-width: 220px;
		padding: 4px 8px;
		font-size: 13px;
	}
	.num-input {
		width: 72px;
		padding: 4px 8px;
		font-size: 13px;
	}
	.color-cell {
		display: inline-flex;
		align-items: center;
		gap: 8px;
	}
	.color-cell .dot {
		width: 12px;
		height: 12px;
		border-radius: 50%;
		display: inline-block;
	}
	.color-input {
		width: 34px;
		height: 26px;
		padding: 0;
		border: 1px solid var(--border);
		border-radius: 6px;
		background: var(--bg);
		cursor: pointer;
	}
	.add-type {
		display: flex;
		flex-wrap: wrap;
		align-items: flex-end;
		gap: 12px;
		margin-top: 16px;
		padding-top: 16px;
		border-top: 1px solid var(--border);
	}
	.key-preview {
		font-size: 12px;
		margin-top: 2px;
	}
</style>
