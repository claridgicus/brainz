<script lang="ts">
	import { page } from "$app/state";
	import Wordmark from "$lib/components/Wordmark.svelte";
</script>

<svelte:head><title>{page.status} — Brainz</title></svelte:head>

<main>
	<a href="/" class="home"><Wordmark /></a>
	<h1>{page.status}</h1>
	<p class="muted">{page.error?.message ?? "Something went wrong."}</p>
	<a href="/dashboard" class="btn">Back to dashboard</a>
</main>

<style>
	main {
		min-height: 100vh;
		display: flex;
		flex-direction: column;
		align-items: center;
		justify-content: center;
		gap: 10px;
		text-align: center;
		padding: 24px;
	}
	.home:hover {
		text-decoration: none;
	}
	h1 {
		font-size: 44px;
		margin: 10px 0 0;
	}
</style>
