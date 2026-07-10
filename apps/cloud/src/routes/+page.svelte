<script lang="ts">
	// Minimal splash for signed-out visitors (signed-in users are redirected
	// to /dashboard by +page.server.ts). The full pitch lives at brownmatter.ai.
</script>

<svelte:head>
	<title>Brainz — a shared brain for your agent fleet</title>
	<meta name="description" content="Free hosted knowledge graphs for AI agent fleets. Sign up, create a vault, point any orchestrator at one MCP URL." />
</svelte:head>

<main>
	<div class="mark" aria-hidden="true">&#x1F4A9;</div>
	<h1>Brainz</h1>
	<p class="tagline">Give your agent fleet a shared brain — free hosted knowledge graphs, one MCP URL away.</p>
	<div class="cta">
		<a href="/login" class="btn">Sign in</a>
		<a href="/signup" class="btn btn-primary">Sign up</a>
	</div>
	<p class="pitch-link muted">
		New here? <a href="https://brownmatter.ai" rel="noopener">Read the pitch at brownmatter.ai</a>
	</p>
</main>

<style>
	main {
		min-height: 100vh;
		display: flex;
		flex-direction: column;
		align-items: center;
		justify-content: center;
		text-align: center;
		padding: 24px;
	}
	.mark {
		font-size: 64px;
		line-height: 1;
		filter: drop-shadow(0 2px 6px rgb(0 0 0 / 0.45));
		margin-bottom: 12px;
	}
	h1 {
		font-size: 42px;
		letter-spacing: -0.02em;
		margin-bottom: 8px;
	}
	.tagline {
		color: var(--text-dim);
		font-size: 17px;
		max-width: 460px;
		margin-bottom: 26px;
	}
	.cta {
		display: flex;
		gap: 12px;
		margin-bottom: 18px;
	}
	.pitch-link {
		font-size: 13.5px;
	}
</style>
