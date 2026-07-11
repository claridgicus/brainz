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
	<p class="agent-link muted">
		Or <a href="/skill">let your agent set it up &rarr;</a>
	</p>
	<p class="pitch-link muted">
		New here? <a href="https://brownmatter.ai" rel="noopener">Read the pitch at brownmatter.ai</a>
	</p>

	<section class="mcp" aria-label="MCP endpoint">
		<p class="mcp-label">
			Remote MCP endpoint — auto-discoverable at
			<a href="/.well-known/mcp.json"><code>/.well-known/mcp.json</code></a>, or wire it by hand:
		</p>
		<pre><code>claude mcp add --transport http brainz https://brainz.brownmatter.ai/mcp \
  --header "Authorization: Bearer bz_..."</code></pre>
		<p class="mcp-note muted">
			No account yet? Connect <em>without</em> the header — the public <code>signup</code> tool
			provisions a workspace on the spot. Full wiring in the
			<a href="https://brownmatter.ai/docs" rel="noopener">docs</a>.
		</p>
	</section>
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
		/* quiet violet aurora behind the hero, Obsidian-style */
		background:
			radial-gradient(ellipse 62% 46% at 50% 38%, rgb(124 58 237 / 0.12), transparent 70%),
			var(--bg);
	}
	.mark {
		font-size: 64px;
		line-height: 1;
		filter: drop-shadow(0 0 26px rgb(124 58 237 / 0.5)) drop-shadow(0 2px 6px rgb(0 0 0 / 0.45));
		margin-bottom: 14px;
	}
	h1 {
		font-size: 52px;
		letter-spacing: -0.025em;
		margin-bottom: 10px;
	}
	.tagline {
		color: var(--text-dim);
		font-size: 18px;
		max-width: 480px;
		margin-bottom: 28px;
	}
	.cta {
		display: flex;
		gap: 12px;
		margin-bottom: 18px;
	}
	.agent-link {
		font-size: 13.5px;
		margin-bottom: 6px;
	}
	.pitch-link {
		font-size: 13.5px;
	}
	.mcp {
		margin-top: 40px;
		max-width: 560px;
		text-align: left;
	}
	.mcp-label {
		font-size: 13px;
		color: var(--text-dim);
		margin-bottom: 8px;
	}
	.mcp pre {
		background: rgb(255 255 255 / 0.04);
		border: 1px solid rgb(255 255 255 / 0.08);
		border-radius: 10px;
		padding: 14px 16px;
		overflow-x: auto;
		font-size: 12.5px;
		line-height: 1.5;
	}
	.mcp-note {
		font-size: 12.5px;
		margin-top: 8px;
	}
</style>
