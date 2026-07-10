<script lang="ts">
	import type { Snippet } from "svelte";
	import Wordmark from "$lib/components/Wordmark.svelte";

	let { heading, children }: { heading: string; children: Snippet } = $props();
</script>

<main>
	<a href="/" class="home" aria-label="Brainz home"><Wordmark /></a>
	<div class="card auth-card">
		<h1>{heading}</h1>
		{@render children()}
	</div>
</main>

<style>
	main {
		min-height: 100vh;
		display: flex;
		flex-direction: column;
		align-items: center;
		justify-content: center;
		gap: 22px;
		padding: 24px;
	}
	.home:hover {
		text-decoration: none;
	}
	.auth-card {
		width: 100%;
		max-width: 380px;
		padding: 26px;
	}
	h1 {
		font-size: 20px;
		margin-bottom: 18px;
	}
</style>
