<script lang="ts">
	import { enhance } from "$app/forms";
	import AuthCard from "$lib/components/AuthCard.svelte";

	/**
	 * Claim approval page (Wave G). A human lands here from the claim email —
	 * "An agent set up a Brainz workspace and wants to attach it to your email".
	 *
	 * Contract with +page.server.ts (backend-owned):
	 *   load →  { status: "valid", email, vaultName, keyName, keyPrefix,
	 *             createdAt (ISO), expiresAt (ISO) }
	 *        |  { status: "invalid" }
	 *   ?/approve → on success the server redirects to a sign-in URL that
	 *               lands on /dashboard
	 *   ?/decline → server redirects OR returns { declined: true }
	 */
	type ClaimData =
		| {
				status: "valid";
				email: string;
				vaultName: string;
				keyName: string;
				keyPrefix: string;
				createdAt: string;
				expiresAt: string;
		  }
		| { status: "invalid" };

	type ClaimForm = { declined?: boolean; error?: string } | null;

	let { data, form }: { data: ClaimData; form: ClaimForm } = $props();

	let busy = $state<"approve" | "decline" | null>(null);
	let error = $state<string | null>(null);

	function submit(action: "approve" | "decline") {
		return () => {
			busy = action;
			error = null;
			return async ({ result, update }: { result: any; update: () => Promise<void> }) => {
				if (result.type === "redirect") {
					// The approve redirect may point at an auth endpoint (session
					// mint) rather than an app route — take a full navigation.
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

	function fmtDate(iso: string): string {
		const d = new Date(iso);
		if (Number.isNaN(d.getTime())) return iso;
		return d.toLocaleDateString(undefined, { year: "numeric", month: "long", day: "numeric" });
	}
</script>

<svelte:head><title>Approve workspace — Brainz</title></svelte:head>

{#if form?.declined}
	<AuthCard heading="Claim declined">
		<p class="intro muted" role="status">
			Nothing was attached to your email — you're all set, no further action needed. The workspace
			the agent created will simply expire on its own.
		</p>
		<a href="/" class="btn wide">Back to Brainz</a>
	</AuthCard>
{:else if data.status === "valid"}
	<AuthCard heading="An agent set up a workspace for you">
		<p class="intro muted">
			An agent created a Brainz workspace and wants to attach it to
			<strong>{data.email}</strong>. Approving makes it permanent — and the agent
			<strong>keeps access</strong> via its API key.
		</p>

		<dl class="details">
			<div>
				<dt>Workspace</dt>
				<dd>{data.vaultName}</dd>
			</div>
			<div>
				<dt>Created</dt>
				<dd>{fmtDate(data.createdAt)}</dd>
			</div>
			<div>
				<dt>Agent's API key</dt>
				<dd>{data.keyName} <code>{data.keyPrefix}…</code></dd>
			</div>
			<div>
				<dt>Expires</dt>
				<dd>{fmtDate(data.expiresAt)} if not approved</dd>
			</div>
		</dl>

		{#if error}<p class="error-text" role="alert">{error}</p>{/if}

		<form method="POST" action="?/approve" use:enhance={submit("approve")}>
			<button type="submit" class="btn btn-primary wide" disabled={busy !== null}>
				{#if busy === "approve"}<span class="spinner"></span>{/if}
				Approve &amp; sign in
			</button>
		</form>
		<form method="POST" action="?/decline" use:enhance={submit("decline")}>
			<button type="submit" class="btn btn-ghost wide" disabled={busy !== null}>
				{#if busy === "decline"}<span class="spinner"></span>{/if}
				This wasn't me — decline
			</button>
		</form>
		<p class="fineprint muted">
			Declining attaches nothing to your email; the workspace expires on its own.
		</p>
	</AuthCard>
{:else}
	<AuthCard heading="This link isn't valid">
		<p class="intro muted">
			This claim link has expired, was already used, or doesn't exist. If you're expecting one, ask
			your agent to request a new claim email — links are single-use and expire after 24 hours.
		</p>
		<a href="/login" class="btn wide">Go to sign in</a>
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
	form + form {
		margin-top: 8px;
	}
	.fineprint {
		font-size: 12px;
		margin: 12px 0 0;
		text-align: center;
	}
</style>
