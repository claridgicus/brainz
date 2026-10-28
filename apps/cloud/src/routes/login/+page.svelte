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

	// Password sign-in exists only for operator-provisioned reviewer accounts
	// (Wave OA); everyone else uses the magic link.
	let showPassword = $state(false);
	let password = $state("");

	async function submitPassword(ev: SubmitEvent) {
		ev.preventDefault();
		busy = true;
		error = null;
		const res = await authClient.signIn.email({ email, password });
		busy = false;
		if (res.error) {
			error = "That email and password don't match a reviewer account.";
			return;
		}
		// Full navigation: the next hop may be the OAuth consent page.
		window.location.assign(safeNextPath(page.url.searchParams.get("next")));
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
	{:else if showPassword}
		<p class="intro muted">
			Password sign-in is for reviewer accounts we set up for you. Everyone else signs in with an
			email link.
		</p>
		<form onsubmit={submitPassword}>
			<div class="field">
				<label for="email">Email</label>
				<input id="email" class="input" type="email" bind:value={email} autocomplete="username" required />
			</div>
			<div class="field">
				<label for="password">Password</label>
				<input
					id="password"
					class="input"
					type="password"
					bind:value={password}
					autocomplete="current-password"
					required
				/>
			</div>
			{#if error}<p class="error-text" role="alert">{error}</p>{/if}
			<button type="submit" class="btn btn-primary wide" disabled={busy}>
				{#if busy}<span class="spinner"></span>{/if}
				Sign in
			</button>
		</form>
		<button type="button" class="btn btn-ghost wide" onclick={() => ((showPassword = false), (error = null))}>
			Use an email link instead
		</button>
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
		<button type="button" class="link-btn muted" onclick={() => ((showPassword = true), (error = null))}>
			Have a reviewer password?
		</button>
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
	.link-btn {
		display: block;
		margin: 14px auto 0;
		background: none;
		border: 0;
		font-size: 12px;
		cursor: pointer;
		text-decoration: underline;
	}
	.or {
		text-align: center;
		font-size: 12px;
		margin: 12px 0;
	}
</style>
