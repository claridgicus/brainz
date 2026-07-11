<script lang="ts">
	import Mark from "./Mark.svelte";
</script>

<!--
	The Brainz logo mark is the zombie half-eaten brain (see Mark.svelte) — the
	brand joke, played straight against the dark, sleek chrome. The 💩 pile-of-poo
	stays Brownmatter's *company* mark over in apps/marketing.
-->
<span class="wordmark">
	<span class="mark" aria-hidden="true"><Mark size={21} /></span>
	Brainz
</span>

<style>
	.wordmark {
		display: inline-flex;
		align-items: center;
		gap: 9px;
		font-size: 19px;
		font-weight: 750;
		letter-spacing: -0.02em;
		color: var(--text);
	}
	.mark {
		display: inline-flex;
		/* keep the mark crisp against the dark chrome */
		filter: drop-shadow(0 1px 2px rgb(0 0 0 / 0.4));
	}
</style>
