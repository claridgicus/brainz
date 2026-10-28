<script lang="ts">
	import type { Snippet } from "svelte";
	import Wordmark from "$lib/components/Wordmark.svelte";
	import LegalLinks from "$lib/components/LegalLinks.svelte";

	let { heading, children }: { heading: string; children: Snippet } = $props();
</script>

<main>
	<a href="/" class="home" aria-label="Brainz home"><Wordmark /></a>
	<div class="card auth-card">
		<h1>{heading}</h1>
		{@render children()}
	</div>
	<p class="consent muted">
		By continuing you agree to the
		<a href="https://brownmatter.ai/terms" rel="noopener">Terms of Service</a> and
		<a href="https://brownmatter.ai/privacy" rel="noopener">Privacy Policy</a>.
	</p>
	<LegalLinks />
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
	.consent {
		max-width: 380px;
		text-align: center;
		font-size: 12.5px;
	}
	h1 {
		font-size: 20px;
		margin-bottom: 18px;
	}
</style>
