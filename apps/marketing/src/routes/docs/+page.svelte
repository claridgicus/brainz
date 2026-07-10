<script lang="ts">
	import { APP_URL, MCP_URL, SIGNUP_URL, SITE_URL } from "$lib/links";

	const title = "Docs — Get started with Brainz";
	const description =
		"Wire Brainz into your agents in minutes: hosted remote MCP at brain.brownmatter.ai or the local-first CLI over stdio. All eight MCP tools, documented.";

	const remoteMcpSnippet = `{
  "mcpServers": {
    "brainz": {
      "type": "http",
      "url": "${MCP_URL}",
      "headers": { "Authorization": "Bearer bz_..." }
    }
  }
}`;

	const claudeMcpAdd = `claude mcp add --transport http brainz ${MCP_URL} \\
  --header "Authorization: Bearer bz_..."`;

	const agentSignupSnippet = `# 1. connect UNAUTHENTICATED — no Authorization header
#    initialize → tools/list shows exactly one tool: signup

# 2. call it with your human's email
→ tools/call signup { "email": "you@company.com", "vaultName": "Acme brain" }

# 3. the result is everything the agent needs
← {
    "apiKey":    "bz_…",                                  // keep this — works immediately
    "claimUrl":  "${APP_URL}/claim/…",  // deliver this to your human
    "vaultSlug": "acme-brain",
    "email":     "you@company.com"
  }`;

	const localInit = `# scaffold a vault (config + concepts/ + a sample note)
npx brainz init my-vault

# add concepts and link them
npx brainz add "Billing Engine" --vault my-vault --type feature --body "Handles invoicing."
npx brainz add "Ledger" --vault my-vault --body "Double-entry ledger."
npx brainz link billing-engine ledger --relation depends_on --vault my-vault

# query it
npx brainz search "billing" --vault my-vault
npx brainz context --query "billing" --budget 800 --vault my-vault`;

	const localMcpSnippet = `{
  "mcpServers": {
    "brainz": {
      "command": "npx",
      "args": ["brainz", "mcp", "--vault", "/absolute/path/to/my-vault"]
    }
  }
}`;

	// Names, titles, and descriptions lifted verbatim from the MCP tool registry
	// (packages/contracts/src/mcp.ts — the wire-shape source of truth).
	const tools = [
		{
			name: "search_concepts",
			title: "Search concepts",
			description:
				"Search the product knowledge vault by free-text query. Use this first, whenever you need product " +
				"knowledge but don't yet know which concept ids exist — e.g. before planning work that touches a " +
				"feature, decision, or constraint. Returns ranked hits (id, title, type, score, snippet) only; " +
				"follow up with get_concept for one full note or get_context for an injectable bundle. " +
				"Never errors on odd queries — an empty hit list just means nothing matched.",
		},
		{
			name: "get_concept",
			title: "Get concept",
			description:
				"Fetch one concept by exact id: full markdown body, metadata, and its direct graph neighbors " +
				"(each with the relation that connects it). Use after search_concepts or when another note " +
				"wiki-links an id you need in full. The neighbors list tells you what to fetch next. " +
				"If you don't know the id, use search_concepts instead.",
		},
		{
			name: "get_related",
			title: "Get related concepts",
			description:
				"Walk the knowledge graph outward from a concept and return everything within `depth` hops, with " +
				"distance and the edge path that reached it. Use to map the blast radius before changing a feature " +
				"(what depends on it, what constrains it, which decisions apply) or to discover structure that " +
				"keyword search misses. Filter by relation names (e.g. depends_on) to follow only one kind of edge.",
		},
		{
			name: "get_context",
			title: "Assemble context bundle",
			description:
				"THE tool to call before delegating a coding task: assembles a ready-to-inject markdown briefing of " +
				"the most relevant concepts (seeded by a search query and/or explicit ids, expanded through the " +
				"graph) trimmed to a token budget. Paste the returned markdown straight into a subagent's prompt so " +
				"it gets curated product knowledge without you relaying individual notes. The final JSON line " +
				"reports which concept ids were included, whether the bundle was truncated, and its approximate " +
				"token count. Provide at least one of `query` or `ids`.",
		},
		{
			name: "upsert_concept",
			title: "Create or update concept",
			description:
				"Write a concept note into the vault (creates or overwrites the markdown file, then reindexes it). " +
				"Use to capture new product knowledge discovered during a task — a decision made, a constraint hit, " +
				"a pattern adopted — so future agents can find it. Omit `id` to derive a slug from the title; pass " +
				"an existing id to update that note. Body is markdown; [[wiki-links]] to other concept ids create " +
				"graph edges. Returns the saved concept's metadata.",
		},
		{
			name: "link_concepts",
			title: "Link concepts",
			description:
				"Add a typed, directed edge between two existing concepts by editing the `from` note's frontmatter " +
				"(e.g. lead-scoring depends_on contact-model). Use when you notice a relationship the vault is " +
				"missing. Both concepts should already exist; use upsert_concept first if not.",
		},
		{
			name: "list_concepts",
			title: "List concepts",
			description:
				"Enumerate concept metadata (no bodies), optionally filtered by product, type, or a single tag. " +
				"Use to get the lay of the land in an unfamiliar vault, to audit what exists (e.g. all decisions " +
				"for a product), or when search vocabulary isn't matching. For content, follow up with get_concept " +
				"or get_context.",
		},
		{
			name: "vault_stats",
			title: "Vault stats",
			description:
				"Cheap orientation call: counts of concepts and edges, the products and tags in use, a breakdown " +
				"by concept type, and whether semantic search is available. Call once when connecting to an " +
				"unfamiliar vault to calibrate how much knowledge is here and which product/tag filters exist.",
		},
	];
</script>

<svelte:head>
	<title>{title}</title>
	<meta name="description" content={description} />
	<link rel="canonical" href="{SITE_URL}/docs" />
	<meta property="og:type" content="article" />
	<meta property="og:site_name" content="Brainz" />
	<meta property="og:title" content={title} />
	<meta property="og:description" content={description} />
	<meta property="og:url" content="{SITE_URL}/docs" />
	<meta name="twitter:card" content="summary" />
	<meta name="twitter:title" content={title} />
	<meta name="twitter:description" content={description} />
</svelte:head>

<div class="container prose docs">
	<header class="docs-head">
		<span class="kicker">Docs</span>
		<h1>Getting started</h1>
		<p class="lede">
			Two ways to run the same brain: hosted at <code>brain.brownmatter.ai</code> (free, remote MCP
			over HTTP) or local-first from a folder of markdown (open source CLI, MCP over stdio). Both
			expose the identical eight tools, so your orchestrator doesn't care which one it's talking to.
		</p>
	</header>

	<h2 id="hosted">Hosted: remote MCP in two minutes</h2>
	<ol>
		<li><a href={SIGNUP_URL}>Sign up</a> — it's free — and create a vault.</li>
		<li>
			In the vault's settings, create an API key. Keys look like <code>bz_&hellip;</code>, are
			scoped to that one vault, and are shown exactly once — store it like a secret.
		</li>
		<li>Add the server to your MCP client. In a project's <code>.mcp.json</code>:</li>
	</ol>
	<pre><code>{remoteMcpSnippet}</code></pre>
	<p>Or with the Claude Code CLI:</p>
	<pre><code>{claudeMcpAdd}</code></pre>
	<p>
		That's the whole integration. Your orchestrator can now call <code>vault_stats</code> to orient
		itself, <code>search_concepts</code> to explore, and <code>get_context</code> to brief
		subagents.
	</p>

	<h3 id="agent-signup">Agent-driven signup: no human in the loop</h3>
	<p>
		An orchestrator doesn't need a pre-made account. Point it at <code>{MCP_URL}</code>
		<em>without</em> an <code>Authorization</code> header and it gets a public MCP server exposing a
		single <code>signup</code> tool (the eight vault tools stay behind authentication):
	</p>
	<pre><code>{agentSignupSnippet}</code></pre>
	<p>
		The <code>apiKey</code> works immediately — the agent reconnects to the same endpoint with
		<code>Authorization: Bearer bz_…</code> and can start seeding the vault right away. The
		<code>claimUrl</code> is for the human: opening it shows the account email and a set-password
		form, then signs them into the dashboard. Claim links are <strong>single-use</strong> and expire
		after <strong>7 days</strong>; an unclaimed account keeps working for the agent — only the claim
		link expires. Password sign-in stays disabled until the account is claimed, and signups are
		rate-limited to 5 per hour per IP.
	</p>

	<h2 id="local">Local-first: a vault is just a folder</h2>
	<p>
		The open-source CLI runs the same engine against a directory of markdown. Notes are plain files
		with YAML frontmatter; the search index is derived SQLite in <code>.brainz/</code> — gitignored,
		safe to delete, rebuilt from your files.
	</p>
	<pre><code>{localInit}</code></pre>
	<p>Serve the vault to your agents over stdio MCP:</p>
	<pre><code>{localMcpSnippet}</code></pre>
	<p>
		The vault directory can also be set via the <code>BRAINZ_VAULT</code> environment variable.
		Search is hybrid (full-text + embeddings, fused by reciprocal rank); if an embedding provider
		isn't configured or available, it degrades gracefully to keyword-only.
	</p>

	<h2 id="tools">The eight MCP tools</h2>
	<p>
		These names and descriptions are the exact text your orchestrator sees — lifted from the tool
		registry that both the hosted and local servers register from, so they never drift.
	</p>
	<div class="table-wrap">
		<table>
			<thead>
				<tr>
					<th>Tool</th>
					<th>Description</th>
				</tr>
			</thead>
			<tbody>
				{#each tools as tool (tool.name)}
					<tr>
						<td>
							<code>{tool.name}</code>
							<div class="tool-title">{tool.title}</div>
						</td>
						<td>{tool.description}</td>
					</tr>
				{/each}
			</tbody>
		</table>
	</div>
	<p>
		One convention worth knowing: <code>get_context</code> responds with two text blocks — first the
		assembled markdown briefing (paste it straight into a subagent prompt), then a single-line JSON
		footer <code>&lbrace; included, truncated, approxTokens &rbrace;</code>. Every other tool
		responds with one JSON text block.
	</p>

	<h2 id="next">Where to go next</h2>
	<ul>
		<li>
			<a href={SIGNUP_URL}>Create a free vault</a> and point an orchestrator at it — the fastest way
			to feel the <code>get_context</code> loop.
		</li>
		<li>
			Seed it with your product's ten most load-bearing concepts: the features everyone touches,
			the decisions nobody remembers making, the constraints that bite.
		</li>
		<li>
			Tell your orchestrator (e.g. in <code>CLAUDE.md</code>) to call <code>get_context</code>
			before delegating, and <code>upsert_concept</code> when it learns something worth keeping.
		</li>
	</ul>
</div>

<style>
	.docs {
		padding-top: 56px;
		padding-bottom: 80px;
	}
	.docs-head h1 {
		font-size: clamp(30px, 4vw, 42px);
	}
	.lede {
		color: var(--text-dim);
		font-size: 17px;
		max-width: 68ch;
	}
	ol,
	ul {
		padding-left: 1.4em;
	}
	.tool-title {
		color: var(--text-dim);
		font-size: 12px;
		margin-top: 4px;
		white-space: nowrap;
	}
	td {
		color: var(--text-dim);
	}
	td code {
		color: var(--text);
	}
</style>
