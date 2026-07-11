<script lang="ts">
	import { enhance } from "$app/forms";
	import { authClient } from "$lib/auth-client";
	import AuthCard from "$lib/components/AuthCard.svelte";

	/**
	 * Vault-invite acceptance page (Wave M). The recipient lands here from the
	 * invite email ("<name> invited you to <vault> on Brainz").
	 *
	 * Contract with +page.server.ts (backend-owned):
	 *   load →  { status: "valid", vaultName, role, email, invitedByName,
	 *             expiresAt (ISO), signedInEmail: string | null,
	 *             emailMismatch: boolean }
	 *        |  { status: "invalid" }
	 *   ?/accept   → on success the server redirects into the vault
	 *   ?/sendLink → emails a magic sign-in link to the invited address;
	 *                success returns { linkSent: true }
	 */
	type InviteData =
		| {
				status: "valid";
				vaultName: string;
				role: string;
				email: string;
				invitedByName: string;
				expiresAt: string;
				signedInEmail: string | null;
				emailMismatch: boolean;
		  }
		| { status: "invalid" };

	type InviteForm = { linkSent?: boolean; error?: string } | null;

	let { data, form }: { data: InviteData; form: InviteForm } = $props();

	let busy = $state<"accept" | "sendLink" | null>(null);
	let error = $state<string | null>(null);
	let signingOut = $state(false);

	function submit(action: "accept" | "sendLink") {
		return () => {
			busy = action;
			error = null;
			return async ({ result, update }: { result: any; update: () => Promise<void> }) => {
				if (result.type === "redirect") {
					// Accept lands inside the vault — take a full navigation so the
					// (app) layout's session load runs fresh.
					window.location.assign(result.location);
					return;
				}
				busy = null;
				if (result.type === "failure") {
					error = result.data?.error ?? "Something went wrong — please try again.";
				} else if (result.type === "error") {
					error = "Something went wrong — please try again.";
				}
				await update();
			};
		};
	}

	/** Mismatch escape hatch: sign out, then reload so the load re-evaluates
	 * into the signed-out (email-me-a-link) state. */
	async function signOut() {
		signingOut = true;
		try {
			await authClient.signOut();
			window.location.reload();
		} catch {
			signingOut = false;
		}
	}

	function fmtDate(iso: string): string {
		const d = new Date(iso);
		if (Number.isNaN(d.getTime())) return iso;
		return d.toLocaleDateString(undefined, { year: "numeric", month: "long", day: "numeric" });
	}
</script>

<svelte:head><title>Vault invite — Brainz</title></svelte:head>

{#if data.status !== "valid"}
	<AuthCard heading="This invite isn't valid">
		<p class="intro muted">
			This invite link has expired, was revoked, was already used, or doesn't exist. Ask the person
			who invited you to send a new one — invites are single-use and expire after 14 days.
		</p>
		<a href="/login" class="btn wide">Go to sign in</a>
	</AuthCard>
{:else if data.emailMismatch}
	<AuthCard heading="Wrong account for this invite">
		<p class="intro muted">
			This invite is for <strong>{data.email}</strong>, but you're signed in as
			<strong>{data.signedInEmail}</strong>.
		</p>
		<p class="error-text" role="alert">
			Sign out, then open the invite link again to accept it as {data.email}.
		</p>
		<button type="button" class="btn wide" onclick={signOut} disabled={signingOut}>
			{#if signingOut}<span class="spinner"></span>{/if}
			Sign out
		</button>
	</AuthCard>
{:else if data.signedInEmail}
	<AuthCard heading="You've been invited">
		<p class="intro muted">
			<strong>{data.invitedByName}</strong> invited you to
			<strong>{data.vaultName}</strong> as {data.role === "owner" ? "an" : "a"}
			<strong>{data.role}</strong>.
		</p>

		<dl class="details">
			<div>
				<dt>Vault</dt>
				<dd>{data.vaultName}</dd>
			</div>
			<div>
				<dt>Your role</dt>
				<dd>{data.role}</dd>
			</div>
			<div>
				<dt>Invited by</dt>
				<dd>{data.invitedByName}</dd>
			</div>
			<div>
				<dt>Expires</dt>
				<dd>{fmtDate(data.expiresAt)}</dd>
			</div>
		</dl>

		{#if error}<p class="error-text" role="alert">{error}</p>{/if}

		<form method="POST" action="?/accept" use:enhance={submit("accept")}>
			<button type="submit" class="btn btn-primary wide" disabled={busy !== null}>
				{#if busy === "accept"}<span class="spinner"></span>{/if}
				Accept invite
			</button>
		</form>
		<p class="fineprint muted">Signed in as {data.signedInEmail}.</p>
	</AuthCard>
{:else if form?.linkSent}
	<AuthCard heading="Check your inbox">
		<p class="intro muted" role="status">
			We emailed a sign-in link to <strong>{data.email}</strong>. Open it, then come back to this
			invite link to accept — or just follow the prompts after signing in.
		</p>
		<p class="fineprint muted">Wrong address? Ask {data.invitedByName} to re-invite you.</p>
	</AuthCard>
{:else}
	<AuthCard heading="You've been invited">
		<p class="intro muted">
			<strong>{data.invitedByName}</strong> invited <strong>{data.email}</strong> to
			<strong>{data.vaultName}</strong> as {data.role === "owner" ? "an" : "a"}
			<strong>{data.role}</strong>. Sign in as {data.email} to accept — no password needed, we'll
			email you a one-time link.
		</p>

		<dl class="details">
			<div>
				<dt>Vault</dt>
				<dd>{data.vaultName}</dd>
			</div>
			<div>
				<dt>Your role</dt>
				<dd>{data.role}</dd>
			</div>
			<div>
				<dt>Expires</dt>
				<dd>{fmtDate(data.expiresAt)}</dd>
			</div>
		</dl>

		{#if error}<p class="error-text" role="alert">{error}</p>{/if}

		<form method="POST" action="?/sendLink" use:enhance={submit("sendLink")}>
			<button type="submit" class="btn btn-primary wide" disabled={busy !== null}>
				{#if busy === "sendLink"}<span class="spinner"></span>{/if}
				Email me a sign-in link
			</button>
		</form>
		<p class="fineprint muted">The link goes to {data.email} — the address this invite names.</p>
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
	.wide {
		width: 100%;
		margin-top: 4px;
	}
	.fineprint {
		font-size: 12px;
		margin: 12px 0 0;
		text-align: center;
	}
</style>
