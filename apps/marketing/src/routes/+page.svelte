<script lang="ts">
	import GraphMotif from "$lib/components/GraphMotif.svelte";
	import Seo from "$lib/components/Seo.svelte";
	import { APP_URL, GITHUB_URL, MCP_URL, SIGNUP_URL } from "$lib/links";

	const title = "Brownmatter — Brainz gives your agent fleet a shared brain";
	const description =
		"Brownmatter makes Brainz: a free product-knowledge graph for AI agent orchestration. Orchestrators query it over MCP; get_context returns a token-budgeted markdown briefing for every coding subagent.";

	const schema = [
		{
			"@type": "SoftwareApplication",
			name: "Brainz",
			applicationCategory: "DeveloperApplication",
			operatingSystem: "Web",
			url: APP_URL,
			sameAs: [GITHUB_URL],
			description:
				"A product-knowledge graph for AI agent orchestration, queried over MCP. Hosted free at brainz.brownmatter.ai or local-first via the open source CLI.",
			offers: { "@type": "Offer", price: "0", priceCurrency: "USD" },
		},
	];

	const mcpSnippet = `{
  "mcpServers": {
    "brainz": {
      "type": "http",
      "url": "${MCP_URL}",
      "headers": { "Authorization": "Bearer bz_..." }
    }
  }
}`;

	const noteSnippet = `---
title: Lead Scoring
type: feature
tags: [crm, ranking]
code_areas: [src/scoring/**]
relations:
  depends_on: [contact-model]
  constrained_by: [rate-limits]
---

Scores leads 0-100. Recomputed on every
[[contact-model]] change; see [[scoring-decision]].`;

	const signupSnippet = `# connect to ${MCP_URL} with NO auth header → two public tools
→ tools/call signup { "vaultName": "Acme brain" }
← { "apiKey": "bz_…", "vaultSlug": "acme-brain",
    "expiresAt": "…", "claimEmailSent": false }
# no URL of any kind in the response — approval links only ever go to the human's inbox`;
</script>

<Seo {title} {description} path="/" {schema} />

<!-- ============================================================ hero -->
<section class="hero">
	<div class="container hero-grid">
		<div class="hero-copy">
			<span class="kicker">Free &middot; Open source &middot; MCP-native</span>
			<h1>Give your agent fleet a shared&nbsp;brain</h1>
			<p class="sub">
				Brainz is a product-knowledge graph built for agent orchestration. Features, decisions,
				constraints, and patterns live as markdown concepts wired into a graph — and before your
				orchestrator delegates a coding task, one <code>get_context</code> call over MCP returns a
				token-budgeted markdown briefing to paste straight into the subagent's prompt. Subagents get
				exactly the product knowledge they need. The orchestrator's context stays clean.
			</p>
			<div class="cta-row">
				<a class="btn btn-primary btn-lg" href={SIGNUP_URL}>Start free</a>
				<a class="btn btn-lg" href="/docs">Read the docs</a>
			</div>
			<p class="hero-note">
				Brainz is a Brownmatter product — hosted at <code>brainz.brownmatter.ai</code>, or run it
				locally from a folder of markdown.
			</p>
		</div>
		<div class="hero-visual" aria-hidden="false">
			<GraphMotif />
		</div>
	</div>
</section>

<!-- ============================================================ features -->
<section class="section" id="features">
	<div class="container">
		<span class="kicker">What it is</span>
		<h2 class="section-title">A knowledge base agents can actually use</h2>
		<p class="section-lede">
			Not a wiki that goes stale in a drawer — a queryable graph whose primary consumer is an
			orchestrator agent, with humans as welcome guests.
		</p>

		<div class="feature-grid">
			<div class="card feature">
				<h3>Concepts, linked into a graph</h3>
				<p>
					Every concept is a markdown note — feature, decision, constraint, pattern, or glossary
					term. Inline <code>[[wiki-links]]</code> and typed relations like
					<code>depends_on</code>, <code>part_of</code>, and <code>constrains</code> wire notes
					into a directed graph, so context assembly follows the structure of your product instead
					of guessing from keywords. And <code>code_areas</code> anchor each concept to the code it
					describes — a briefed agent learns the rules <em>and</em> where to apply them.
				</p>
				<pre><code>{noteSnippet}</code></pre>
			</div>

			<div class="card feature">
				<h3>Remote MCP in one snippet</h3>
				<p>
					Point any MCP client at your hosted vault — Claude Code, or anything that speaks
					streamable HTTP. Create an API key in the dashboard, add one entry to
					<code>.mcp.json</code>, and every vault tool is live — from
					<code>search_concepts</code> to <code>take_task</code>.
				</p>
				<pre><code>{mcpSnippet}</code></pre>
			</div>

			<div class="card feature">
				<h3>Hybrid search, graceful fallback</h3>
				<p>
					Queries fuse full-text search with embedding similarity via reciprocal-rank fusion, then
					expand through the graph to pull in the neighbors that matter. If embeddings are
					unavailable — offline, no key, no model — everything degrades to keyword search. Nothing
					crashes, ever.
				</p>
			</div>

			<div class="card feature">
				<h3>Local-first &amp; open source</h3>
				<p>
					The same brain runs from a folder of markdown on your machine: <code>npx brainz init</code>,
					edit notes in any editor, and serve them to your agents over stdio MCP with the CLI. The
					index is derived SQLite, rebuilt from your files — your knowledge stays plain markdown,
					in git, forever portable.
				</p>
			</div>

			<div class="card feature">
				<h3>Give your fleet a work queue</h3>
				<p>
					Tasks are concepts too. <code>create_task</code> turns a finding into first-class work —
					wired to its domain, the specs that govern it, and the code areas where it lands. One
					<code>take_task</code> call claims the next open task atomically <em>and</em> returns it
					with an auto-assembled briefing, so the agent that picks up the work starts already
					briefed. You watch it happen on a real-time Kanban board: Open, Taken, Done.
				</p>
			</div>

			<div class="card feature">
				<h3>Share one brain across humans and agents</h3>
				<p>
					Invite teammates by email — single-use links, <code>owner</code> / <code>editor</code> /
					<code>viewer</code> roles, enforced on every REST route and MCP call. Your colleagues
					browse the same graph in the dashboard that your agents query over MCP. One vault, one
					source of truth, everyone briefed from it.
				</p>
			</div>

			<div class="card feature wide">
				<h3>No signup form required — your agent does it</h3>
				<p>
					An orchestrator can provision its own brain: hit <code>{MCP_URL}</code> with no
					credentials and the endpoint exposes two public tools — <code>signup</code> and
					<code>sign_in</code>. One <code>signup</code> call creates a provisional workspace: a
					first vault and an API key that works immediately, no email required. The response
					contains no URL of any kind — that's the security story. The workspace expires in 7 days
					unless claimed: the <code>claim</code> tool emails your human an approval link the agent
					never sees. No passwords anywhere — Brainz is passwordless. Or skip the wiring entirely:
					tell your agent to read <a href="/docs#agent-signup">the setup flow</a> and it does the
					rest.
				</p>
				<pre><code>{signupSnippet}</code></pre>
			</div>
		</div>
	</div>
</section>

<!-- ============================================================ how it works -->
<section class="section how" id="how-it-works">
	<div class="container">
		<span class="kicker">How it works</span>
		<h2 class="section-title">Three steps to briefed subagents</h2>
		<div class="steps">
			<div class="step">
				<div class="step-n">1</div>
				<h3>Capture concepts</h3>
				<p>
					Point your agent at an existing codebase: the <code>onboard</code> tool hands it a
					playbook for distilling your product into the graph. Then let agents keep capturing
					knowledge as they work with <code>upsert_concept</code>. No account yet? Your agent can
					<a href="/docs#agent-signup">sign itself up</a> first.
				</p>
			</div>
			<div class="step">
				<div class="step-n">2</div>
				<h3>Wire the MCP</h3>
				<p>
					One entry in <code>.mcp.json</code>: hosted over HTTP with an API key, or local over
					stdio. Your orchestrator sees the full toolset — search, traversal, writes, a work
					queue, and the flagship, <code>get_context</code>.
				</p>
			</div>
			<div class="step">
				<div class="step-n">3</div>
				<h3>Brief every subagent</h3>
				<p>
					Before delegating, the orchestrator calls <code>get_context</code> and injects the
					returned markdown bundle into the subagent's prompt. Curated product knowledge in;
					context pollution out.
				</p>
			</div>
		</div>
	</div>
</section>

<!-- ============================================================ free -->
<section class="section free" id="free">
	<div class="container free-inner">
		<h2 class="section-title">Free. Actually free.</h2>
		<p class="free-copy">
			Hosted vaults at <code>brainz.brownmatter.ai</code> are free for everyone — no tiers, no trial
			clock, no credit card, no seat limits. And because the engine is open source and every concept
			is plain markdown, you're never locked in: the same vault runs from a folder on your laptop.
		</p>
		<div class="cta-row center">
			<a class="btn btn-primary btn-lg" href={SIGNUP_URL}>Create your vault</a>
			<a class="btn btn-lg" href="/docs">Get started locally</a>
		</div>
	</div>
</section>

<style>
	/* ---------- hero ---------- */
	.hero {
		border-bottom: 1px solid var(--border);
	}
	.hero-grid {
		display: grid;
		grid-template-columns: minmax(0, 6fr) minmax(0, 5fr);
		align-items: center;
		gap: 56px;
		padding-top: 104px;
		padding-bottom: 104px;
	}
	h1 {
		font-size: clamp(38px, 5.4vw, 66px);
		letter-spacing: -0.04em;
		margin-bottom: 22px;
	}
	.sub {
		color: var(--text-dim);
		font-size: 18px;
		line-height: 1.55;
		max-width: 56ch;
	}
	.sub code {
		color: var(--accent);
	}
	.cta-row {
		display: flex;
		gap: 14px;
		flex-wrap: wrap;
		margin-top: 28px;
	}
	.cta-row.center {
		justify-content: center;
	}
	.hero-note {
		margin-top: 18px;
		color: var(--text-dim);
		font-size: 14px;
	}
	.hero-visual {
		min-width: 0;
	}

	/* ---------- features ---------- */
	.feature-grid {
		display: grid;
		grid-template-columns: repeat(2, minmax(0, 1fr));
		gap: 22px;
	}
	.feature h3 {
		font-size: 19px;
	}
	.feature p {
		color: var(--text-dim);
		font-size: 15px;
	}
	.feature p code {
		color: var(--text);
	}
	.feature pre {
		margin-top: 18px;
		margin-bottom: 0;
		font-size: 12.5px;
	}
	.feature.wide {
		grid-column: 1 / -1;
	}

	/* ---------- how it works ---------- */
	.how {
		border-top: 1px solid var(--rule);
		border-bottom: 1px solid var(--rule);
	}
	.steps {
		display: grid;
		grid-template-columns: repeat(3, minmax(0, 1fr));
		gap: 20px;
		margin-top: 12px;
	}
	.step {
		background: var(--bg-tile);
		border-radius: var(--radius-card);
		padding: 28px 26px 30px;
		display: flex;
		flex-direction: column;
	}
	.step h3 {
		font-size: 19px;
		letter-spacing: -0.02em;
	}
	.step p {
		color: var(--text-dim);
		font-size: 15px;
		margin-bottom: 0;
	}
	.step p code {
		color: var(--text);
	}
	.step-n {
		font-size: 64px;
		font-weight: 600;
		line-height: 1;
		letter-spacing: -0.04em;
		color: var(--text);
		margin-bottom: 48px;
	}

	/* ---------- free ---------- */
	.free {
		background: var(--cobalt);
	}
	.free-inner {
		text-align: center;
		max-width: 760px;
	}
	.free :global(.section-title) {
		color: #fff;
		font-size: clamp(36px, 5vw, 60px);
	}
	.free-copy {
		color: rgb(255 255 255 / 0.85);
		font-size: 17.5px;
		margin-bottom: 36px;
	}
	.free-copy code {
		color: #fff;
		background: rgb(255 255 255 / 0.14);
		border-color: rgb(255 255 255 / 0.25);
	}
	.free :global(.btn) {
		border-color: rgb(255 255 255 / 0.85);
		color: #fff;
	}
	.free :global(.btn:hover) {
		background: rgb(255 255 255 / 0.12);
		color: #fff;
	}
	.free :global(.btn-primary) {
		background: #fff;
		border-color: #fff;
		color: var(--cobalt);
	}
	.free :global(.btn-primary:hover) {
		background: rgb(255 255 255 / 0.9);
		color: var(--cobalt);
	}

	/* ---------- responsive ---------- */
	@media (max-width: 900px) {
		.hero-grid {
			grid-template-columns: 1fr;
			padding-top: 56px;
			padding-bottom: 56px;
		}
		.hero-visual {
			max-width: 520px;
		}
		.feature-grid {
			grid-template-columns: 1fr;
		}
		.steps {
			grid-template-columns: 1fr;
		}
	}
</style>
