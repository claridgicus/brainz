<script lang="ts">
	import { page } from "$app/state";
	import { authClient } from "$lib/auth-client";
	import { safeNextPath } from "$lib/nav";
	import AuthCard from "$lib/components/AuthCard.svelte";

	let { data } = $props();
	let name = $state("");
	let email = $state("");
	let password = $state("");
	let error = $state<string | null>(null);
	let busy = $state(false);

	async function submit(ev: SubmitEvent) {
		ev.preventDefault();
		busy = true;
		error = null;
		const res = await authClient.signUp.email({ name, email, password });
		if (res.error) {
			// e.g. "User already exists" / password policy violations
			error = res.error.message ?? "Sign up failed.";
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
		if (res.error) error = res.error.message ?? "GitHub sign up failed.";
	}
</script>

<svelte:head><title>Sign up — Brainz</title></svelte:head>

<AuthCard heading="Create your account">
	<form onsubmit={submit}>
		<div class="field">
			<label for="name">Name</label>
			<input id="name" class="input" bind:value={name} autocomplete="name" required />
		</div>
		<div class="field">
			<label for="email">Email</label>
			<input id="email" class="input" type="email" bind:value={email} autocomplete="email" required />
		</div>
		<div class="field">
			<label for="password">Password</label>
			<input
				id="password"
				class="input"
				type="password"
				bind:value={password}
				autocomplete="new-password"
				minlength="8"
				required
			/>
		</div>
		{#if error}<p class="error-text" role="alert">{error}</p>{/if}
		<button type="submit" class="btn btn-primary wide" disabled={busy}>
			{#if busy}<span class="spinner"></span>{/if}
			Sign up — it's free
		</button>
	</form>
	{#if data.github}
		<div class="or muted" aria-hidden="true">or</div>
		<button type="button" class="btn wide" onclick={github}>Continue with GitHub</button>
	{/if}
	<p class="alt muted">
		Already have an account? <a href="/login{page.url.search}">Sign in</a>
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
