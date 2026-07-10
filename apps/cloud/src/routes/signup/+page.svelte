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
		// Sign-up and sign-in are the same passwordless flow: an unknown email
		// creates the account when the link is opened.
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
		const res = await authClient.signIn.social({
			provider: "github",
			callbackURL: safeNextPath(page.url.searchParams.get("next")),
		});
		if (res.error) error = res.error.message ?? "GitHub sign up failed.";
	}
</script>

<svelte:head><title>Sign up — Brainz</title></svelte:head>

<AuthCard heading={sent ? "Check your inbox" : "Create your account"}>
	{#if sent}
		<p class="intro muted" role="status">
			We've sent a one-time link to <strong>{email}</strong>. Open it to create your account and
			sign in — it works once and expires in about 15 minutes.
		</p>
		<button type="button" class="btn wide" onclick={() => (sent = false)}>Use a different email</button>
	{:else}
		<p class="intro muted">
			It's free. Enter your email and we'll send a magic link — no password to choose.
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
				Email me a sign-up link
			</button>
		</form>
		{#if data.github}
			<div class="or muted" aria-hidden="true">or</div>
			<button type="button" class="btn wide" onclick={github}>Continue with GitHub</button>
		{/if}
		<p class="alt muted">Already have an account? <a href="/login{page.url.search}">Sign in</a></p>
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
	.alt {
		font-size: 13.5px;
		margin: 16px 0 0;
		text-align: center;
	}
	.or {
		text-align: center;
		font-size: 12px;
		margin: 12px 0;
	}
</style>
