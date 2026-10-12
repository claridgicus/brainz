<script lang="ts">
	import Seo from "$lib/components/Seo.svelte";
	import { MCP_URL, SIGNUP_URL, SITE_URL, SKILL_URL } from "$lib/links";

	const title = "Docs — Get started with Brainz";
	const description =
		"Wire Brainz into your agents in minutes: hosted remote MCP at brainz.brownmatter.ai or the local-first CLI over stdio. All sixteen MCP tools, documented.";

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
#    initialize → tools/list shows two public tools: signup and sign_in

# 2. provision a workspace — no email, no human action required
→ tools/call signup { "vaultName": "Acme brain" }

# 3. the result is everything the agent needs — and no URL of any kind
← {
    "apiKey":         "bz_…",              // works immediately — keep it secret
    "vaultSlug":      "acme-brain",
    "expiresAt":      "2026-07-18T…",      // workspace expires in 7 days unless claimed
    "claimEmailSent": false
  }

# 4. keep it: the claim tool (authenticated) emails YOUR HUMAN an approval link
→ tools/call claim { "email": "you@company.com" }
← { "status": "sent", "expiresAt": "…" }   // link goes to the inbox, never to the agent`;

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
			name: "delete_concept",
			title: "Delete concept",
			description:
				"Remove a concept from the vault and all of its outgoing edges. Use to clear a note that is wrong, " +
				"obsolete, or junk (e.g. a probe or test node that shouldn't be in the graph). Idempotent: deleting " +
				"an id that doesn't exist is a no-op success (deleted:false), not an error. Deletion is permanent — " +
				"prefer upsert_concept to correct a note you want to keep. Returns { deleted, id }.",
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
		{
			name: "onboard",
			title: "Onboard this vault",
			description:
				"Step 1 on any new vault: onboarding turns an existing product's codebase into the knowledge graph " +
				"your whole agent fleet shares. Call {action: \"start\"} to receive the onboarding playbook — " +
				"instructions for fanning subagents out over the codebase and distilling product knowledge " +
				"(domains, features, stories, specs, workflows, decisions, constraints) into concepts via " +
				"upsert_concept, each anchored to the code with codeAreas. There is NO flat concept cap — size the " +
				"effort from the codebase; for a large project expect 200–800+ concepts and do NOT stop at a few " +
				"dozen. Onboarding is a LOOP: index an area, then call {action: \"status\", areaList} (you supply " +
				"your repo's source areas — Brainz can't read the repo) to see covered vs uncovered areas; keep " +
				"indexing the uncovered ones until coverage is broad. When it is, call {action: \"complete\", " +
				"summary, areaList} to mark the vault onboarded and store the summary — complete is coverage-gated " +
				"and rejects if too many areas are still uncovered. {action: \"status\"} reports onboarded state, " +
				"concept counts, and (with areaList) coverage. Until onboarding completes, search_concepts and " +
				"get_context results carry a reminder to run it.",
		},
		{
			name: "sync",
			title: "Sync this vault to the current code",
			description:
				"Re-onboard: keep the knowledge graph true to the artifact as code changes. Onboarding is one-shot; " +
				"sync is the supported path to re-index drift. Call {action: \"start\"} for the sync playbook — a drift " +
				"playbook (not the full onboarding one): diff the codebase since last_synced_at (you run git and pass " +
				"back changedPaths + areaList), fan out over the CHANGED areas, update stale concepts in place, index " +
				"new/un-mapped work, and report coverage gaps. {action: \"complete\", summary, areaList} stamps " +
				"last_synced_at and appends your summary to the product-onboarding-summary concept (a running sync log). " +
				"{action: \"status\"} reports last sync time and staleness. Past ~14 days without a sync, get_context and " +
				"search results carry a staleness reminder to run it.",
		},
		{
			name: "list_tasks",
			title: "List tasks",
			description:
				"List the vault's work pile: `task`-type concepts with their lifecycle (open/taken/done), oldest " +
				"first. Call to survey what's outstanding before claiming work, to check what a teammate agent is " +
				"already doing (taskStatus \"taken\" with takenBy), or to audit completed work. Filter by taskStatus " +
				"or by the domain the tasks are part_of. To actually pick up work, use take_task — don't just read.",
		},
		{
			name: "take_task",
			title: "Take a task off the pile",
			description:
				"Claim a unit of work and get briefed in one call. Pass an `id` to claim a specific task, or omit it " +
				"to claim THE next open task (deterministic: oldest open by createdAt then id) — safe to call " +
				"repeatedly to drain the pile. Atomically flips the task to \"taken\" and records takenBy/takenAt; " +
				"errors if it's already taken or done. Returns the task AND an auto-assembled get_context-grade " +
				"briefing for its part_of domain plus the concepts it realizes / is governed_by (with code_areas) — " +
				"paste that straight into your implementation. THE CONTRACT: after implementing, verify the artifact " +
				"matches every spec that governs the task; fix or file a new task for any discrepancy; then index the " +
				"new/changed knowledge via upsert_concept and call complete_task.",
		},
		{
			name: "complete_task",
			title: "Complete a task",
			description:
				"Mark a task done once the work is in the artifact. Sets taskStatus=done + doneAt and appends your " +
				"`outcome` to the task body as an Outcome section. The result reminds you to index what changed via " +
				"upsert_concept so the knowledge graph stays true to the codebase — do that before moving on.",
		},
		{
			name: "session_hook",
			title: "Install the Brainz session hook",
			description:
				"Make Brainz the default in every future session, not just this one. Returns the session-hook " +
				"playbook: a short primer (get_context before planning or delegating, take_task for work, " +
				"upsert_concept to write back what changed) plus the exact steps to install it as a session-start " +
				"hook in your own harness — a Claude Code SessionStart hook in .claude/settings.json, or a marked " +
				"block in AGENTS.md / your client's rules file. Brainz can't write to your repo, so the agent " +
				"applies the edits. Call once per repository; the steps are idempotent.",
		},
		{
			name: "create_task",
			title: "Create a task",
			description:
				"Turn a finding into first-class work: creates a `task`-type concept with taskStatus=open and the " +
				"given relations — part_of a domain, `realizes` stories/features, `governed_by` specs — plus " +
				"codeAreas pointing at where the work lands. Use when you discover work that isn't reflected in the " +
				"codebase yet (a gap, a needed fix, a follow-up). The task then shows up in list_tasks / take_task " +
				"and on the Kanban board.",
		},
	];
</script>

<Seo
	{title}
	{description}
	path="/docs"
	type="article"
	schema={[
		{
			"@type": "TechArticle",
			headline: title,
			description,
			url: `${SITE_URL}/docs`,
			author: { "@id": `${SITE_URL}/#organization` },
		},
	]}
/>

<div class="container prose docs">
	<header class="docs-head">
		<span class="kicker">Docs</span>
		<h1>Getting started</h1>
		<p class="lede">
			Two ways to run the same brain: hosted at <code>brainz.brownmatter.ai</code> (free, remote MCP
			over HTTP) or local-first from a folder of markdown (open source CLI, MCP over stdio). Both
			expose the identical vault toolset, so your orchestrator doesn't care which one it's talking
			to.
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
		subagents. Clients that support MCP discovery can also find the server themselves via
		<code>/.well-known/mcp.json</code> (registry name <code>ai.brownmatter/brainz</code>).
	</p>

	<h3 id="agent-signup">Agent-driven signup: human in the loop, not in the way</h3>
	<p>
		An orchestrator doesn't need a pre-made account. Point it at <code>{MCP_URL}</code>
		<em>without</em> an <code>Authorization</code> header and it gets a public MCP server exposing
		two tools — <code>signup</code> and <code>sign_in</code> (the sixteen vault tools stay behind
		authentication):
	</p>
	<pre><code>{agentSignupSnippet}</code></pre>
	<p>
		The <code>apiKey</code> works immediately — the agent reconnects to the same endpoint with
		<code>Authorization: Bearer bz_…</code> and can start seeding the vault right away. The
		workspace is <strong>provisional</strong>: it expires in <strong>7 days</strong> unless a human
		claims it. To keep it, the agent calls the <code>claim</code> tool with its human's email — the
		approval link is <strong>emailed to the human and never returned to the agent</strong>, so an
		agent can never see, open, or leak it. Passing <code>email</code> to <code>signup</code> fires
		the same claim request in one call. Returning humans use the <code>sign_in</code> tool instead:
		a one-time magic sign-in link lands in their inbox — no password to choose, ever (Brainz is
		<strong>passwordless</strong>). Signups are rate-limited to 5 per hour per IP.
	</p>

	<h3 id="teams">Bring your team</h3>
	<p>
		A vault isn't a solo brain. From the vault's settings, owners invite teammates by email — each
		invite is a <strong>single-use link</strong> that expires in <strong>14 days</strong> — and
		assign a role: <code>owner</code> (everything, including keys, members, and invites),
		<code>editor</code> (read and write concepts and tasks), or <code>viewer</code> (read-only).
		Roles are enforced on every REST route and MCP call, so a colleague in the dashboard and an
		agent holding an API key play by the same rules. Humans and agents share one brain.
	</p>

	<h2 id="onboard">Onboard your product</h2>
	<p>
		A fresh vault is an empty brain. The <code>onboard</code> tool fixes that without you writing a
		single note: your orchestrator calls <code>onboard</code> with
		<code>&lbrace;"action": "start"&rbrace;</code> and receives a playbook — fan subagents out over
		the codebase, distill what they find into the product ontology, and write it back with
		<code>upsert_concept</code>.
	</p>
	<p>
		The ontology is eleven concept types, and five of them carry the structure: <code>domain</code>
		(high-level product areas — the top of the graph), <code>feature</code> (concrete capabilities,
		<code>part_of</code> a domain), <code>story</code> (user stories, <code>realized_by</code> the
		features that deliver them), <code>spec</code> (the rules that <code>govern</code> features and
		stories), and <code>workflow</code> (multi-step journeys across features) — plus <code>task</code>
		(a unit of work not yet in the codebase, claimed off a real-time Kanban board via
		<code>take_task</code>) and the classics: <code>concept</code>, <code>decision</code>,
		<code>constraint</code>, <code>pattern</code>, <code>glossary</code>. Every concept can carry
		<code>code_areas</code> — rough paths or globs
		pointing at where that knowledge lives in the codebase — so a subagent briefed by
		<code>get_context</code> learns the rules <em>and</em> where to apply them.
	</p>
	<p>
		Onboarding is a loop, not a one-shot: the agent indexes an area of the codebase, calls
		<code>onboard</code> with <code>&lbrace;"action": "status", "areaList"&rbrace;</code> to see
		which areas are covered and which aren't, and keeps going until coverage is broad — expect
		hundreds of concepts on a real codebase, not dozens. <code>&lbrace;"action": "complete",
		"summary", "areaList"&rbrace;</code> is coverage-gated: it rejects if too many areas are still
		uncovered. Until it succeeds, <code>search_concepts</code> and <code>get_context</code>
		responses carry a one-line reminder — a nudge, never a wall. Local vaults get the same flow via
		<code>brainz onboard</code>.
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
		(Running the <code>brainz-mcp</code> binary directly? It can take the vault directory from the
		<code>BRAINZ_VAULT</code> environment variable instead of a flag.)
		Search is hybrid (full-text + embeddings, fused by reciprocal rank); if an embedding provider
		isn't configured or available, it degrades gracefully to keyword-only.
	</p>

	<h2 id="tools">The sixteen MCP tools</h2>
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
		responds with one JSON text block — except <code>onboard &lbrace;"action": "start"&rbrace;</code>,
		which returns the playbook as one markdown block.
	</p>

	<h2 id="next">Where to go next</h2>
	<ul>
		<li>
			<a href={SIGNUP_URL}>Create a free vault</a> and point an orchestrator at it — the fastest way
			to feel the <code>get_context</code> loop.
		</li>
		<li>
			Or just tell your agent to set itself up: point it at
			<a href={SKILL_URL} rel="noopener">{SKILL_URL}</a> — one pasted prompt and it walks itself
			through signup, key configuration, claiming the workspace for you, and onboarding.
		</li>
		<li>
			<a href="#onboard">Onboard your product</a>: point your orchestrator at the vault and have it
			call the <code>onboard</code> tool — it maps your codebase into domains, features, stories,
			specs, and workflows, each anchored to the code that implements it.
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
