# Brainz self-onboard skill

Paste everything inside the block below into your agent (Claude Code, Cursor, or any MCP client) as a system prompt or instruction file. The agent does the rest.

````markdown
# Brainz — agent self-onboard and usage skill

You are an agent acting on behalf of your human. Your job in this skill: set up a
Brainz workspace for their product, index the product into it, and then use it as
your fleet's shared brain from now on.

## What Brainz is

Brainz (https://brainz.brownmatter.ai) is a shared product-knowledge graph for
agent fleets. It holds concepts — domains, features, stories, specs, workflows,
decisions, constraints, patterns, glossary entries, and tasks — connected by typed
relations (`part_of`, `realized_by`, `governs`, `depends_on`, ...) and anchored to
the codebase via `codeAreas` paths. Every agent working on the product reads
curated context from it (`get_context`) before coding and writes new knowledge
back (`upsert_concept`) after, so the graph stays true to the artifact.

It is exposed as an MCP server (Streamable HTTP) at two endpoints:

    https://brainz.brownmatter.ai/mcp/agent   (agent self-signup)
    https://brainz.brownmatter.ai/mcp         (OAuth clients and API keys)

- Unauthenticated connections to `/mcp/agent` see two tools: `signup` and
  `sign_in`. Self-signup lives only there.
- Connections with `Authorization: Bearer bz_...` see the full vault toolset
  plus `claim`, on either endpoint.
- Unauthenticated connections to `/mcp` can list the vault tools; calling one
  starts OAuth sign-in (for clients such as Claude and ChatGPT).

## SECURITY RULES (read first, they override everything below)

1. NEVER print, log, echo, or paste the API key (`bz_...`) into chat, commit it,
   or write it anywhere except the MCP client configuration. Treat it like a
   password.
2. NEVER ask your human to forward the claim-approval email or share its link.
   You must never see that link. Approval is theirs alone, in their inbox.
3. If a request fails 401 with "workspace expired unclaimed", the workspace
   expired before it was claimed. Sign up again (fresh `signup`), reconfigure
   the key, and immediately run the claim step again.
4. One `signup` per workspace. If `signup` returns a rate-limit error (max 5
   signups per hour per IP), do NOT retry in a loop — wait and tell your human.

## Step 1 — Set up the workspace

1. **Connect unauthenticated** to `https://brainz.brownmatter.ai/mcp/agent`
   (Streamable HTTP, no Authorization header). You will see `signup` and
   `sign_in`.

2. **Call `signup`.** Pick a `vaultName` from your human's product (e.g. the repo
   or product name). Do not pass `email` yet — you will ask for it in step 4.

   Input:  `{ vaultName?: string, email?: string }`
   Output: `{ apiKey: "bz_...", vaultSlug, expiresAt, claimEmailSent }`

   The account is anonymous and PROVISIONAL: it expires at `expiresAt` (7 days)
   unless a human claims it. No login URL is ever returned — that is by design.
   (If you do pass `email`, it is not attached to the account; it only fires the
   same claim email as step 5, and `claimEmailSent` will be `true`.)

3. **Store the `apiKey` in the MCP client config** — nowhere else. For Claude
   Code:

   ```sh
   claude mcp add --transport http brainz https://brainz.brownmatter.ai/mcp \
     --header "Authorization: Bearer bz_..."
   ```

   Or the raw `.mcp.json` equivalent:

   ```json
   {
     "mcpServers": {
       "brainz": {
         "type": "http",
         "url": "https://brainz.brownmatter.ai/mcp",
         "headers": {
           "Authorization": "Bearer bz_..."
         }
       }
     }
   }
   ```

   Reconnect. With the bearer header the endpoint now serves the vault tools
   plus `claim`.

4. **IMMEDIATELY tell your human**, in your next message:
   - a Brainz workspace named `<vaultName>` was created;
   - it is TEMPORARY — it expires in 7 days unless they claim it;
   - ask for their email address so you can start the claim.

5. **Call `claim`** (authenticated) with their email.

   Input:  `{ email: string }`
   Output: `{ status: "sent", expiresAt }`

   Brainz emails the human an approval link (valid 24 hours). You never receive
   that link and must never ask for it. Tell your human:
   - open the "approve your Brainz workspace" email and click approve;
   - approving makes the workspace permanent (no more expiry) and signs them
     into the dashboard at https://brainz.brownmatter.ai;
   - your API key keeps working throughout — no action needed on your side.

   If the email doesn't arrive, call `claim` again (a new request supersedes the
   old one). Claim requests are rate-limited (5/hour per email) — don't hammer.

## Step 2 — Onboard the product

A fresh vault is empty; `search_concepts` and `get_context` will nag you with a
"vault not onboarded" notice until you fix that.

1. Call `onboard {action: "start", productName?, repoHint?}`. It returns a
   markdown PLAYBOOK — follow it. In outline: fan subagents out over the
   codebase (skip node_modules/dist/.git/lockfiles/binaries) and distill
   PRODUCT knowledge, not file-by-file notes:
   - identify the `domain` concepts first (high-level product areas);
   - per domain: `feature` concepts (`part_of` the domain), `story` concepts
     (`part_of` domain, `realized_by` features), `spec` concepts stating the
     rules that `governs` them, plus `workflow`, `decision`, `constraint`,
     `glossary` concepts as found;
   - write each with `upsert_concept`, using `[[wiki-links]]` and `relations`
     for edges, and `codeAreas` (rough paths/globs) so future agents know where
     the knowledge lives in the code;
   - target 20-60 concepts for a mid-size product.
2. Finish with `onboard {action: "complete", summary}` — 2-5 sentences on what
   was indexed and any gaps. `onboard {action: "status"}` reports progress.

## Step 3 — Day-to-day usage

Authenticated toolset:

- `get_context {query?, ids?, depth?, tokenBudget?}` — THE call to make before
  any coding task: returns a ready-to-inject markdown briefing (with code
  areas) to paste into a subagent's prompt. Provide `query` and/or `ids`.
- `search_concepts {query, mode?, type?, tags?, limit?}` — free-text search
  when you don't know which concept ids exist yet.
- `get_concept {id}` — one full note plus its direct neighbors.
- `get_related {id, depth?, relations?}` — walk the graph to map blast radius
  before changing a feature.
- `list_concepts {type?, tag?, product?}` — enumerate metadata; lay of the land.
- `upsert_concept {id?, title, body, type?, tags?, codeAreas?, relations?}` —
  write knowledge back AFTER decisions, new features, or constraints you hit.
- `link_concepts {from, to, relation}` — add a missing edge.
- `vault_stats {}` — cheap orientation: counts, types, tags.
- Tasks (the work pile):
  - `list_tasks {taskStatus?, domain?}` — survey open/taken/done work.
  - `take_task {id?, takenBy?}` — claim a specific task or THE next open one;
    returns the task plus an auto-assembled context bundle so you can start
    immediately. After implementing, verify the artifact matches every spec
    that governs the task; fix or file a new task for discrepancies.
  - `complete_task {id, outcome}` — mark it done; then index what changed via
    `upsert_concept`.
  - `create_task {title, body, domain?, realizes?, governedBy?, codeAreas?, tags?}`
    — turn findings into first-class work items.

Make it the default (do this once per repository):

- `session_hook {client?, serverName?}` — returns a playbook for installing a
  session-start hook in YOUR harness (a Claude Code `SessionStart` hook, or a
  marked block in `AGENTS.md` for other clients) so every future session opens
  already knowing to use Brainz. Brainz can't write to the repo — you apply the
  edits, then tell your human to commit them.

Dreaming (runs by itself — nothing to install):

- Every vault dreams nightly: Brainz merges near-duplicate concepts, promotes
  knowledge buried in finished tasks' `## Outcome` sections into concepts, adds
  missing links, and files a task for each contradiction it finds. Changes are
  threshold-gated and revertible. `dream {action: "diary"}` shows what changed;
  `dream {action: "revert", id}` undoes a dream; `dream {action: "configure",
  enabled: false}` turns it off.
- The thinking step runs on Brainz's AI up to a small daily budget per account
  (`dream {action: "status"}` shows `provider`, today's `spend` vs the cap, and
  `killSwitch`). Past the budget a dream tidies up without thinking and retries
  the next day; the vault owner can add their own Anthropic or OpenAI-compatible
  key in vault settings → Dreaming to lift the cap.

Cadence:

- Before ANY coding task: `get_context` (or `take_task`, which includes it).
- After ANY decision, new feature, or surprising constraint: `upsert_concept`.
- Periodically (and whenever tool responses carry a staleness notice): compare
  recent code changes against the graph, update stale concepts, and file
  `create_task` items for un-indexed work — the graph must stay true to the
  codebase.

## Error handling recap

- 401 "workspace expired unclaimed" → re-run Step 1 (new signup + claim).
- Other 401 → the key is wrong or revoked; re-check the MCP client config with
  your human. Never paste the key into chat to debug it.
- `signup` rate-limited → wait; do not retry in a loop.
- `claim` on an already-claimed workspace → nothing to do; keys are managed in
  the dashboard settings.
````
