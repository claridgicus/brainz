<script lang="ts">
	import type { Snippet } from "svelte";

	/** Shared shell for /privacy, /terms and /support: kicker, title, date, prose body. */
	interface Props {
		kicker: string;
		heading: string;
		/** Human-readable "Last updated" date; omit for pages that aren't versioned. */
		updated?: string;
		children: Snippet;
	}

	let { kicker, heading, updated, children }: Props = $props();
</script>

<div class="container prose legal">
	<header class="legal-head">
		<span class="kicker">{kicker}</span>
		<h1>{heading}</h1>
		{#if updated}<p class="updated">Last updated: {updated}</p>{/if}
	</header>
	{@render children()}
</div>

<style>
	.legal {
		padding-top: 56px;
		padding-bottom: 80px;
		max-width: 820px;
	}
	.legal-head h1 {
		font-size: clamp(30px, 4vw, 42px);
	}
	.updated {
		color: var(--text-dim);
		font-size: 14px;
	}
	.legal :global(ul) {
		padding-left: 1.4em;
	}
	.legal :global(li),
	.legal :global(p) {
		max-width: 72ch;
	}
</style>
