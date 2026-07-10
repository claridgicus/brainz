<script lang="ts">
	import { page } from "$app/state";
	import { authClient } from "$lib/auth-client";
	import { safeNextPath } from "$lib/nav";
	import AuthCard from "$lib/components/AuthCard.svelte";

	let { data } = $props();
	let email = $state("");
	let sent = $state(false);
	let error = $state<string | null>(null);
	let busy = $state(false);

	async function submit(ev: SubmitEvent) {
		ev.preventDefault();
		busy = true;
		error = null;
		const res = await authClient.signIn.magicLink({
			email,
			callbackURL: safeNextPath(page.url.searchParams.get("next")),
		});
		busy = false;
		if (res.error) {
			error = res.error.message ?? "Couldn't send the link — please try again.";
			return;
		}
		sent = true;
	}

	async function github() {
		error = null;
		// Better Auth redirects to GitHub, then back to callbackURL.
		const res = await authClient.signIn.social({
			provider: "github",
			callbackURL: safeNextPath(page.url.searchParams.get("next")),
		});
		if (res.error) error = res.error.message ?? "GitHub sign in failed.";
	}
</script>

<svelte:head><title>Sign in — Brainz</title></svelte:head>

<AuthCard heading={sent ? "Check your inbox" : "Sign in or sign up"}>
	{#if sent}
		<p class="intro muted" role="status">
			If <strong>{email}</strong> is a valid address, we've sent a one-time sign-in link there. Open
			it to continue — it works once and expires in about 15 minutes.
		</p>
		<button type="button" class="btn wide" onclick={() => (sent = false)}>Use a different email</button>
	{:else}
		<p class="intro muted">
			Enter your email and we'll send a magic link. No password — new here or returning, it's the
			same link.
		</p>
		<form onsubmit={submit}>
			<div class="field">
				<label for="email">Email</label>
				<input
					id="email"
					class="input"
					type="email"
					bind:value={email}
					autocomplete="email"
					required
				/>
			</div>
			{#if error}<p class="error-text" role="alert">{error}</p>{/if}
			<button type="submit" class="btn btn-primary wide" disabled={busy}>
				{#if busy}<span class="spinner"></span>{/if}
				Email me a sign-in link
			</button>
		</form>
		{#if data.github}
			<div class="or muted" aria-hidden="true">or</div>
			<button type="button" class="btn wide" onclick={github}>Continue with GitHub</button>
		{/if}
	{/if}
</AuthCard>

<style>
	.intro {
		font-size: 13.5px;
		margin: 0 0 16px;
	}
	.wide {
		width: 100%;
		margin-top: 4px;
	}
	.or {
		text-align: center;
		font-size: 12px;
		margin: 12px 0;
	}
</style>
