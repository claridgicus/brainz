<script lang="ts">
	// Public legal + support pages live on the marketing site (brownmatter.ai);
	// directory listings and the MCP server card point at the same URLs.
	let { class: klass = "" }: { class?: string } = $props();
</script>

<nav class="legal-links muted {klass}" aria-label="Legal">
	<a href="https://brownmatter.ai/privacy" rel="noopener">Privacy</a>
	<span aria-hidden="true">&middot;</span>
	<a href="https://brownmatter.ai/terms" rel="noopener">Terms</a>
	<span aria-hidden="true">&middot;</span>
	<a href="https://brownmatter.ai/support" rel="noopener">Support</a>
</nav>

<style>
	.legal-links {
		display: flex;
		gap: 8px;
		justify-content: center;
		font-size: 12.5px;
	}
	.legal-links a {
		color: inherit;
	}
	.legal-links a:hover {
		color: var(--text);
	}
</style>
