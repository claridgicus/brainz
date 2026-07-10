<script lang="ts">
	import { page } from "$app/state";
	import { authClient } from "$lib/auth-client";
	import { safeNextPath } from "$lib/nav";
	import AuthCard from "$lib/components/AuthCard.svelte";

	let { data } = $props();
	let email = $state("");
	let password = $state("");
	let error = $state<string | null>(null);
	let busy = $state(false);

	async function submit(ev: SubmitEvent) {
		ev.preventDefault();
		busy = true;
		error = null;
		const res = await authClient.signIn.email({ email, password });
		if (res.error) {
			error = res.error.message ?? "Sign in failed — check your email and password.";
			busy = false;
			return;
		}
		// Full navigation so server loads see the fresh session cookie.
		window.location.href = safeNextPath(page.url.searchParams.get("next"));
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

<AuthCard heading="Sign in">
	<form onsubmit={submit}>
		<div class="field">
			<label for="email">Email</label>
			<input id="email" class="input" type="email" bind:value={email} autocomplete="email" required />
		</div>
		<div class="field">
			<label for="password">Password</label>
			<input id="password" class="input" type="password" bind:value={password} autocomplete="current-password" required />
		</div>
		{#if error}<p class="error-text" role="alert">{error}</p>{/if}
		<button type="submit" class="btn btn-primary wide" disabled={busy}>
			{#if busy}<span class="spinner"></span>{/if}
			Sign in
		</button>
	</form>
	{#if data.github}
		<div class="or muted" aria-hidden="true">or</div>
		<button type="button" class="btn wide" onclick={github}>Continue with GitHub</button>
	{/if}
	<p class="alt muted">
		No account? <a href="/signup{page.url.search}">Sign up</a>
	</p>
</AuthCard>

<style>
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
