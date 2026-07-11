<script lang="ts">
	import { GITHUB_URL, LOGIN_URL, SIGNUP_URL } from "$lib/links";
	import Wordmark from "./Wordmark.svelte";
</script>

<footer>
	<div class="container inner">
		<div class="brand">
			<Wordmark />
			<p>
				A product-knowledge graph for agent orchestration.<br />
				Brainz is a Brownmatter product.
			</p>
		</div>
		<div class="cols">
			<div class="col">
				<h4>Product</h4>
				<a href={SIGNUP_URL}>Sign up</a>
				<a href={LOGIN_URL}>Sign in</a>
				<a href="/docs">Docs</a>
			</div>
			<div class="col">
				<h4>Open source</h4>
				<a href={GITHUB_URL} rel="noopener">GitHub</a>
				<a href="/docs#local">Local CLI</a>
				<a href="/docs#tools">MCP tools</a>
			</div>
		</div>
	</div>
	<div class="container legal">
		<span>&copy; {new Date().getFullYear()} Brownmatter &middot; brownmatter.ai</span>
		<span>Free for everyone.</span>
	</div>
</footer>

<style>
	footer {
		border-top: 1px solid var(--rule);
		background: var(--bg-card);
		padding: 64px 0 36px;
	}
	.inner {
		display: flex;
		justify-content: space-between;
		gap: 48px;
		flex-wrap: wrap;
	}
	.brand p {
		color: var(--text-dim);
		font-size: 14px;
		margin-top: 14px;
	}
	.cols {
		display: flex;
		gap: 72px;
		flex-wrap: wrap;
	}
	.col {
		display: flex;
		flex-direction: column;
		gap: 9px;
	}
	.col h4 {
		font-size: 15px;
		font-weight: 600;
		letter-spacing: -0.01em;
		color: var(--text);
		margin-bottom: 6px;
	}
	.col a {
		color: var(--text-dim);
		font-size: 14.5px;
		text-decoration: none;
	}
	.col a:hover {
		color: var(--accent);
	}
	.legal {
		display: flex;
		justify-content: space-between;
		gap: 16px;
		flex-wrap: wrap;
		margin-top: 48px;
		padding-top: 20px;
		border-top: 1px solid var(--border);
		color: var(--text-dim);
		font-size: 13px;
	}
</style>
