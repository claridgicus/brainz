<script lang="ts">
	import { authClient } from "$lib/auth-client";
	import Wordmark from "$lib/components/Wordmark.svelte";

	let { data, children } = $props();
	let signingOut = $state(false);

	async function signOut() {
		signingOut = true;
		await authClient.signOut();
		window.location.href = "/";
	}
</script>

<div class="shell">
	<header>
		<a href="/dashboard" class="home" aria-label="Brainz dashboard"><Wordmark /></a>
		<div class="right">
			<span class="who muted" title={data.user.email}>{data.user.email}</span>
			<button type="button" class="btn btn-ghost btn-sm" onclick={signOut} disabled={signingOut}>
				Sign out
			</button>
		</div>
	</header>
	<div class="content">
		{@render children()}
	</div>
</div>

<style>
	.shell {
		display: flex;
		flex-direction: column;
		height: 100vh;
	}
	header {
		flex: none;
		display: flex;
		align-items: center;
		justify-content: space-between;
		gap: 16px;
		padding: 0 20px;
		height: 54px;
		border-bottom: 1px solid var(--border);
		background: rgb(15 18 24 / 0.9);
	}
	.home:hover {
		text-decoration: none;
	}
	.right {
		display: flex;
		align-items: center;
		gap: 10px;
		min-width: 0;
	}
	.who {
		font-size: 13px;
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
	}
	.content {
		flex: 1;
		min-height: 0;
		overflow-y: auto;
	}
</style>
