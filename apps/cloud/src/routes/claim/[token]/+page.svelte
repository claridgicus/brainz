<script lang="ts">
	import { enhance } from "$app/forms";
	import AuthCard from "$lib/components/AuthCard.svelte";

	let { data, form } = $props();
	let busy = $state(false);
</script>

<svelte:head><title>Claim your account — Brainz</title></svelte:head>

{#if data.state === "valid"}
	<AuthCard heading="Claim your account">
		<p class="intro muted">
			An agent set up this Brainz account for <strong>{data.email}</strong>. Choose a password to
			take ownership — you'll be signed in straight away.
		</p>
		<form
			method="POST"
			use:enhance={() => {
				busy = true;
				return async ({ update }) => {
					busy = false;
					await update();
				};
			}}
		>
			<div class="field">
				<label for="email">Email</label>
				<input id="email" class="input" type="email" value={data.email} disabled />
			</div>
			<div class="field">
				<label for="password">Password</label>
				<input
					id="password"
					name="password"
					class="input"
					type="password"
					autocomplete="new-password"
					minlength="8"
					required
				/>
			</div>
			{#if form?.error}<p class="error-text" role="alert">{form.error}</p>{/if}
			<button type="submit" class="btn btn-primary wide" disabled={busy}>
				{#if busy}<span class="spinner"></span>{/if}
				Set password &amp; sign in
			</button>
		</form>
		<p class="alt muted">
			Your agent's API key already works — claiming just adds dashboard access.
		</p>
	</AuthCard>
{:else}
	<AuthCard heading={data.state === "expired" ? "Claim link expired" : "Claim link not valid"}>
		<p class="intro muted" role="alert">
			{#if data.state === "expired"}
				This claim link has expired — claim links are valid for 7 days.
			{:else if data.state === "claimed"}
				This claim link has already been used. If that was you, just sign in.
			{:else}
				This claim link isn't valid. It may have been mistyped or revoked.
			{/if}
		</p>
		<div class="actions">
			<a class="btn btn-primary wide" href="/login">Sign in</a>
			<a class="btn wide" href="/signup">Sign up again</a>
		</div>
	</AuthCard>
{/if}

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
	.actions {
		display: flex;
		flex-direction: column;
		gap: 10px;
	}
</style>
