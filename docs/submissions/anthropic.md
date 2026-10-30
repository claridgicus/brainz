# Brainz — Claude Connectors Directory submission packet

Prepared 2026-10-28 against production (deploy 093faaf: cloud a929f671, marketing 07ea880c).
Portal: <https://claude.ai/directory/manage> → **Submit new** → **MCP connector**.
Submitter: any paid Claude plan (Pro/Max: your own account; Team/Enterprise: an Owner).

Sources, all official and fetched 2026-10-28:
[submission](https://claude.com/docs/connectors/building/submission) ·
[review criteria](https://claude.com/docs/connectors/building/review-criteria) ·
[authentication](https://claude.com/docs/connectors/building/authentication) ·
[lazy authentication](https://claude.com/docs/connectors/building/lazy-authentication) ·
[publish](https://claude.com/docs/directory/publish) ·
[managing your listing](https://claude.com/docs/connectors/building/managing-your-listing) ·
[size and timeout limits](https://claude.com/docs/connectors/building/index).
Anything the docs don't state is marked **UNCONFIRMED**.

No secrets are in this file. The reviewer credentials live in
`~/.config/brainz-reviewers/anthropic.json` (mode 0600) on James's machine and go only into the
portal's **Test & launch** step.

---

## Submitted / Published

| | |
|---|---|
| Status | **Published**: live in the Claude Connectors Directory |
| Submitted | 2026-10-29, from James's Claude account (Max plan). Passed the automated review and was **Approved** the same day |
| Published | 2026-10-30. The portal shows "Published · Live in the directory" |
| Listing | `brainz` (permanent slug). Public page: <https://claude.ai/directory/brainz>. Manage: <https://claude.ai/directory/manage/brainz>. The portal shows no other submission id. |
| Public page check | Right after publishing, the public page still said "This connector doesn't exist". The portal notes that new listings "can take up to an hour to show in the directory". Re-check it. |
| Escalations | directory@anthropic.com (listing changes, review decisions), mcp-review@anthropic.com |

Screenshots (kept out of the repo): `~/.cache/orchestrate/anthropic-submission/review-before-submit-2026-10-29.jpg`
(the full review step before submit, with no credentials on it) and `published-2026-10-30.jpg`.

### What was entered, where it differs from the steps below

- **Connection:** the portal now needs the server connected as a custom connector in the submitting
  account, so it can read the tools ("Brainz", Sign in now, CIMD). It was connected to one of
  James's vaults with one Allow click, and it stays in James's Settings → Connectors until he
  removes it. The portal read 16 tools / 0 resources / OAuth. Its only notes were two non-blocking
  "Reference the target API docs" suggestions (on `create_task` and `upsert_concept`), which don't
  apply to a first-party server.
- **Listing:** name `Brainz`, slug `brainz`, one-liner as in Step 3. In the description, the vault
  paragraph was corrected for multi-vault consent: "You sign in with OAuth and pick the vaults to
  share on the consent screen. The connection reaches only those vaults: owners and editors get
  every tool, viewers get the read tools." The destructive sentence became "Read tools change
  nothing, and tools that overwrite or delete data are marked destructive." (1,392 chars.)
  Categories: Development tools, Productivity. Author: left blank, so it defaults to the company.
  Icon: the portal takes a URL, not an upload, and the server URL's favicon resolves to the
  Brownmatter mark, so a custom icon is set: the commit-pinned
  `https://raw.githubusercontent.com/claridgicus/brainz/db2f61f…/docs/submissions/assets/brainz-tile-512.png`.
  Docs `https://brownmatter.ai/docs`, support `support@brownmatter.ai`, privacy
  `https://brownmatter.ai/privacy`.
- **Use cases** (the portal allows three, each with one example prompt): brief a coding task
  (`get_context` prompt), answer product questions and record decisions (search plus the PostHog
  decision), work a shared task pile (list + take). Prerequisites as in Step 4. Read and write.
- **Company:** `Brownmatter`, `https://brownmatter.ai` (James's choice). Primary contact James
  Claridge, Founder. The submitted listing still has **james@plutocracy.io** as the primary
  contact, because it was filled before James asked for support@brownmatter.ai everywhere.
  Editing an approved listing would send it back to review, so the change is requested by email:
  [anthropic-contact-change-email.md](anthropic-contact-change-email.md) (draft, not sent). The
  public support contact is support@brownmatter.ai.
- **Authentication:** Always required, OAuth with **Client ID Metadata Document**. The portal
  detected "no sign-in" because anonymous `initialize` returns 200, so this was set by hand.
- **Data handling:** we own the API; health data No; sponsored content No.
- **Test & launch:** the Step 8 text with the credentials, plus "Have a reviewer password?" for the
  sign-in link, "Allow access" for the consent button, and an instruction to tick ONE vault and
  click Allow access ONCE (the double-submit consent fix was still in flight). "Self-tested" was
  ticked with James's confirmation, after all 16 tools ran (see Evidence, 2026-10-29 MCP
  Inspector).
- **Compliance:** all seven acknowledgments were ticked with James's explicit confirmation. An
  additional note explains CIMD + DCR, the lazy-auth 401, why the portal detects "no sign-in", and
  that `signup`/`sign_in`/`claim`/`session_hook` are not on `/mcp` for OAuth connections.
- The submit step showed one non-blocking advisory: the contact email's domain differs from the
  signed-in account's.

---

## Before you open the portal

| # | Item | State | Tracking task |
|---|---|---|---|
| 1 | Setup docs for connecting from Claude on brownmatter.ai/docs ("required by your publish date") | **gap** | `docs-add-connect-from-claude-and-connect-from-chatgpt-setup-sections` |
| 2 | No Cloudflare WAF/bot rule blocks `160.79.104.0/21` | **unknown** (operator check) | `james-confirm-no-cloudflare-waf-bot-rule-blocks-claude-or-chatgpt-on-brainz-brownmatter-ai` |
| 3 | support@brownmatter.ai is monitored | **unknown** | `james-make-support-brownmatter-ai-a-monitored-inbox` |
| 4 | Every tool run once via MCP Inspector or as a custom connector (the portal asks you to confirm this) | **done** (2026-10-29: all 16 tools via MCP Inspector on the reviewer account; claude.ai and Claude Code connect + consent passed live. See Evidence) | `james-live-client-tests-claude-ai-claude-code-and-chatgpt-against-production` |
| 5 | Privacy policy discloses OAuth connector data | **gap** (advised) | `privacy-policy-disclose-oauth-connector-data-needs-james-s-approval` |
| 6 | Onboard/sync notices in tool results are neutral | **gap** (advised; reviewer vault unaffected) | `make-the-onboard-sync-notices-in-tool-results-neutral-on-directory-surfaces` |

Items 1 to 4 must be done before you submit. Items 5 and 6 lower the rejection risk. The
umbrella task is `james-submit-brainz-to-the-claude-connectors-directory-and-the-chatgpt-plugin-directory`.

---

## Step 1 — Connection

| Field | Answer |
|---|---|
| Server URL | `https://brainz.brownmatter.ai/mcp` |
| Users connect to different URLs | **No.** Everyone uses the same URL, and OAuth picks the user and vault. |

Don't submit `/mcp/agent`. It serves agent self-signup, which returns an API key in the tool
result and is deliberately kept off directory surfaces (SPEC-CLOUD "Directory policy").

## Step 2 — Tools

The portal syncs these from the server. Without a token, `tools/list` on `/mcp` returns the 16
directory tools with full annotations (verified 2026-10-28). Every tool has a `title` and
explicit `readOnlyHint`, `destructiveHint` and `openWorldHint` values. Nothing should be flagged.
Prompts and resources: none.

| Tool | Title | readOnly | destructive | openWorld | Rationale (SPEC.md "MCP tool annotations") |
|---|---|---|---|---|---|
| `search_concepts` | Search concepts | true | false | false | Ranked search over this vault's own index; changes nothing. |
| `get_concept` | Get concept | true | false | false | Reads one concept and its direct neighbours. |
| `get_related` | Get related concepts | true | false | false | Graph walk over this vault; read only. |
| `get_context` | Assemble context bundle | true | false | false | Builds a markdown briefing from vault concepts; writes nothing. |
| `list_concepts` | List concepts | true | false | false | Lists concept metadata, without bodies. |
| `vault_stats` | Vault stats | true | false | false | Counts and facets of this vault. |
| `list_tasks` | List tasks | true | false | false | Lists task concepts and their lifecycle state. |
| `upsert_concept` | Create or update concept | false | **true** | false | Overwrites an existing note's title, body and fields when the id exists. |
| `delete_concept` | Delete concept | false | **true** | false | Permanently removes a concept and its outgoing edges. |
| `link_concepts` | Link concepts | false | false | false | Additive: adds one edge to a note's frontmatter. |
| `create_task` | Create a task | false | false | false | Additive: creates a new task concept. |
| `take_task` | Take a task off the pile | false | false | false | Task-state transition (open → taken) plus a briefing. |
| `complete_task` | Complete a task | false | false | false | Task-state transition (→ done); appends an Outcome section. |
| `onboard` | Onboard this vault | false | false | false | `start`/`status` read; `complete` stamps the onboarding time and writes the vault's own summary note. |
| `sync` | Sync this vault to the current code | false | false | false | Same as onboard, for re-indexing after code changes. |
| `dream` | Dream (nightly consolidation) | false | **true** | **true** | `run` can merge or tombstone duplicate concepts (`revert` restores them). The REM stage calls an LLM provider: Workers AI, or the vault owner's own Anthropic/OpenAI key. |

These tools are on other surfaces but **not** on `/mcp` for OAuth connections: `session_hook`
(installs a persistent primer in a harness, which Anthropic would read as overriding system
instructions), `signup` and `sign_in` (they handle API keys and sign-in links), and `claim`
(an OAuth user is already a signed-in human).

A viewer-role member who connects gets only the six public read tools (`PUBLIC_VAULT_READ_TOOL_NAMES`: every read tool above except `list_tasks`).

## Step 3 — Listing

| Field | Limit | Answer |
|---|---|---|
| Server name | 100 | `Brainz` |
| One-liner | 200 | `A shared product-knowledge graph for you and your AI agents: search features, specs, decisions and tasks, brief a coding task, and record what you learn.` (152 chars) |
| Description | 2,000 | See below (about 1,450 chars) |
| Categories | 1–5 | Pick from the portal's list (**UNCONFIRMED**: the docs don't publish it). In order of preference: Developer tools; Productivity; Knowledge management / Documentation. |
| Documentation URL | | `https://brownmatter.ai/docs` (add the "Connect from Claude" section first, item 1) |
| Privacy policy URL | | `https://brownmatter.ai/privacy` |
| Support contact | | `support@brownmatter.ai` (support page: `https://brownmatter.ai/support`) |
| Icon | | `docs/submissions/assets/brainz-tile-512.png` (512×512 PNG, mark on the app's dark tile). Size and format are **UNCONFIRMED**: the docs only say "an icon". Alternatives: `brainz-tile.svg`, or the transparent `brainz-mark-512.png` / `brainz-mark.svg`. |
| URL slug | | `brainz` (permanent once published) |

Description:

```text
Brainz keeps a product's knowledge where people and AI agents can share it: features, user stories, specs, workflows, decisions, constraints, glossary terms and tasks, stored as linked markdown concepts in a vault.

Connect Brainz and Claude can:
- search the vault and open any concept together with the notes it links to;
- walk the graph around a feature to see what depends on it, what constrains it and which decisions apply;
- assemble a briefing on a topic, trimmed to a token budget, ready to hand to a coding agent or a teammate;
- record knowledge: create or update a concept, link two concepts, or delete one that is wrong;
- work the task pile: list open tasks, take one (which returns its briefing), create a task from a finding, and complete one with an outcome;
- return the onboarding and sync playbooks for indexing a codebase into the vault, and run or configure the vault's consolidation sweep.

You sign in with OAuth and choose one vault on the consent screen. The connection reaches only that vault: owners and editors get every tool, viewers get the read tools. To use a second vault, connect again.

Brainz cannot read your repository or files, and it never receives your conversation, only each tool call's arguments. Read tools run without changing anything; tools that overwrite or delete are marked destructive, so Claude asks before running them.

Brainz is free. Sign up at https://brainz.brownmatter.ai with a magic link or GitHub.
```

## Step 4 — Use cases

| Field | Answer |
|---|---|
| Primary use cases | 1. Brief a coding task: "Brief me on X before I start", via `get_context`. 2. Answer product questions from specs and decisions: `search_concepts`, `get_concept`, `get_related`. 3. Capture decisions and constraints found while working: `upsert_concept`, `link_concepts`. 4. Run a task pile shared by people and agents: `list_tasks`, `take_task`, `create_task`, `complete_task`. 5. Keep the graph current with the code: `onboard`, `sync`, `dream`. |
| What users need before connecting | A free Brainz account (sign up at brainz.brownmatter.ai with a magic link or GitHub) and at least one vault where they are owner or editor (viewers get read-only tools). No plan or payment. |
| Reads, writes, or both | **Both.** |

Example prompts for reviewers (they match the seeded reviewer vault):

1. "What's in my Brainz vault?" → `vault_stats`
2. "Search Brainz for the lead scoring model and tell me the score tiers." → `search_concepts`, `get_concept` (hot ≥ 70, warm 40–69, cold < 40)
3. "What depends on lead scoring?" → `get_related`
4. "Use Brainz to brief me on showing sales reps why a lead's score changed, including where in the code the work lands." → `get_context`
5. "List the open tasks, then take the one about lead score explanations." → `list_tasks`, `take_task`
6. "Record a decision: we'll use PostHog for product analytics because it can self-host in the EU. Link it to lead scoring." → `upsert_concept`, `link_concepts`
7. "Mark the consent-filter task done: audience builder now excludes contacts without consent." → `complete_task`
8. "Delete the concept you just created." → `delete_concept` (destructive, so Claude asks first)

## Step 5 — Company

| Field | Answer |
|---|---|
| Company name | `Brownmatter` (trading name; legal operator **Plutocracy Pty Ltd**, as on /terms and /privacy). James decides which name is shown. |
| Website | `https://brownmatter.ai` |
| Primary contact for review updates | James, at an address he monitors (not committed here) |

## Step 6 — Authentication

| Field | Answer |
|---|---|
| Authentication requirement | **Always required.** Every tool call needs a vault, so signing in on connect is the clearer UX. `/mcp` also supports lazy auth: unauthenticated `initialize` and `tools/list` succeed, and any `tools/call` gets HTTP 401 with `WWW-Authenticate: Bearer resource_metadata="https://brainz.brownmatter.ai/.well-known/oauth-protected-resource/mcp", scope="vault"`. So **Required when the server asks** also works. |
| Authentication method | OAuth 2.0, with Claude registering itself: **DCR** (`registration_endpoint`) or **CIMD** (`client_id_metadata_document_supported: true`, `none` in `token_endpoint_auth_methods_supported`). Both are the default `oauth_dcr` / `oauth_cimd` types. |
| Anthropic-held client ID/secret | Leave empty. Not needed with DCR/CIMD. |
| Scopes | `vault`. The PRM advertises `scopes_supported: ["vault"]` and the AS lists `offline_access` too, so Claude appends it. A refresh token is always issued either way. |
| Callback | `https://claude.ai/api/mcp/auth_callback` is registered by Claude through DCR and matched exactly. Claude Code's `http://localhost:<port>/callback` and `127.0.0.1` callbacks match with any port. |

Discovery, as verified live:

- `GET /.well-known/oauth-protected-resource/mcp` → `resource: https://brainz.brownmatter.ai/mcp`, `authorization_servers: [https://brainz.brownmatter.ai]`
- `GET /.well-known/oauth-authorization-server` → authorize, token, register and revoke under `/oauth/*`; `code_challenge_methods_supported: ["S256"]`; grants `authorization_code` and `refresh_token`; refresh tokens rotate, with reuse detection.

## Step 7 — Data handling

| Question | Answer |
|---|---|
| Whose API does the connector call? | **Our own, first-party.** The MCP server and the Brainz service are the same Cloudflare Worker on `brainz.brownmatter.ai`. Vault content lives in that vault's Durable Object, and the control plane in D1. |
| Personal health data | **No.** |
| Sponsored content | **No.** |

## Step 8 — Test & launch

Paste the following into the reviewer-instructions field, filling the two placeholders from
`~/.config/brainz-reviewers/anthropic.json` (`email`, `password`). Don't paste the file
itself.

```text
Test account (password sign-in, no email step, no MFA):
  Email:    <email from the credentials file>
  Password: <password from the credentials file>

1. In Claude: Customize > Connectors > Add custom connector, URL https://brainz.brownmatter.ai/mcp
   (or use the directory listing once it is visible to you). Click Connect.
2. You are sent to brainz.brownmatter.ai. On the sign-in page choose
   "Sign in with a password" and use the credentials above.
3. The consent screen names Claude, shows what is granted ("read and write the concepts and
   tasks in one vault, as you") and lists one vault, "Brainz demo" (owner). Select it and
   click Approve.
4. The vault is a fully populated sample product (Acme CRM): 31 concepts across 3 domains, with
   features, stories, specs, a workflow, decisions, constraints, patterns, glossary terms, an
   onboarding summary and 6 tasks (4 open, 1 taken, 1 done).
5. Try: "What's in my Brainz vault?", "Search Brainz for the lead scoring model and tell me the
   score tiers", "Use Brainz to brief me on showing reps why a lead's score changed",
   "List the open tasks, then take the one about lead score explanations", "Record a decision:
   we'll use PostHog for product analytics because it can self-host in the EU; link it to lead
   scoring", then "Delete the concept you just created".
Write tools change only this demo vault; we reset it between reviews.
Contact: support@brownmatter.ai
```

Then tick the confirmation that every tool was run through MCP Inspector or as a custom
connector in Claude. Do item 4 of the checklist first.

## Step 9 — Compliance (all seven required)

| Acknowledgment | Why Brainz complies |
|---|---|
| Directory guidelines | Follows the Software Directory Terms and Policy. The listing text is accurate and the tools are purpose-built. |
| First-party API usage | The server calls only Brainz's own storage, on the same domain as the service. |
| Financial transactions | No money, crypto or asset transfers, and nothing for sale (Brainz is free). |
| AI media generation | No image, video or audio generation. `dream` produces text proposals only. |
| Prompt injection | Tool descriptions and server instructions describe and don't steer. A contracts lint test rejects "THE tool", "every session", "do NOT stop" and similar. No hidden or encoded text, and no `session_hook` on `/mcp`. Advised fix: item 6 (notices in results). |
| Conversation data collection | No tool accepts conversation history, memory or user files. `dream` sends only vault concepts to its LLM. |
| Public documentation | `https://brownmatter.ai/docs` (item 1 adds the Claude connection steps). |

## Step 10 — Review and submit

Clear any quality warnings, then submit. Anthropic scans the submission and by default lists it
as **Community**; a Verified escalation runs each tool. Track status in the portal. Escalations
go to `mcp-review@anthropic.com`.

---

## Gap check against the review criteria

| Requirement (source) | Brainz | Evidence |
|---|---|---|
| Remote, reachable over HTTPS (submission) | **pass** | `https://brainz.brownmatter.ai/mcp` answers `initialize` with 200 |
| OAuth 2.0 for tools acting on a user's account (submission) | **pass** | Own AS: DCR + CIMD, PKCE S256, PRM, RFC 8414 metadata |
| 401 + `resource_metadata` for gated calls, not 200 `isError` (lazy-auth) | **pass** | Unauthenticated `tools/call` → `HTTP/2 401` with the challenge above |
| PRM `resource` equals the MCP URL exactly (authentication) | **pass** | `https://brainz.brownmatter.ai/mcp` |
| S256 PKCE advertised and enforced (authentication) | **pass** | `plain` is rejected (SPEC-CLOUD Wave OA) |
| `claude.ai` callback and Claude Code loopback on any port (authentication) | **pass** | Loopback port-ignoring match, live probe used `127.0.0.1:53682` |
| Form-encoded token endpoint, `invalid_grant` for bad refresh, refresh rotation (authentication) | **pass** | Live: form-encoded exchange 200; rotation and reuse revocation covered by unit + E2E tests |
| Anthropic egress `160.79.104.0/21` not blocked (authentication) | **unknown** | DCR rate-limit exemption is in code; WAF state needs the operator (item 2) |
| Every tool has `title` + readOnly/destructive hint (submission, review criteria) | **pass** | 16/16, all three hints explicit |
| Tool names ≤ 64 chars | **pass** | Longest is `search_concepts` (15 chars) |
| Read and write split into separate tools | **pass** | No catch-all request tool |
| Narrow, accurate descriptions; no prompt-injection patterns | **pass** for descriptions and instructions | Contracts lint test; neutral `serverInstructions()` |
| No directive text in tool **results** | **gap** (advised) | "call the onboard tool…" notice on non-onboarded vaults (item 6). The reviewer vault is onboarded, so reviewers won't see it. |
| Valid calls succeed; actionable errors (functional quality) | **pass** | Live: 9 read calls OK; an unknown id → `isError` "no concept with id … use search_concepts or list_concepts to find valid ids" |
| Reasonably sized responses (≤ ~150k chars claude.ai, 25k tokens Claude Code) | **pass** | `get_context` takes `tokenBudget`; the largest live response was 9 KB |
| No conversation-data collection; no memory/chat-history queries | **pass** | See Step 9 |
| First-party API, domain matches the service | **pass** | |
| No money transfer or AI media generation | **pass** | |
| Test credentials for a fully populated account | **pass** | Reviewer account seeded and onboarded 2026-10-28 (31 concepts, 114 edges) |
| Public documentation by publish date | **gap** | Item 1 |
| Privacy policy URL | **pass** (URL live), **gap** (OAuth disclosure, item 5) | `https://brownmatter.ai/privacy` |
| Support contact | **unknown** | Item 3 |
| Icon | **pass** | `assets/brainz-tile-512.png` (spec **UNCONFIRMED**) |
| Tested as a custom connector in Claude | **partial pass** | claude.ai and Claude Code, live 2026-10-29 (see Evidence); not every tool has run from a Claude client yet (item 4) |
| MCP App screenshots / allowed link URIs | **n/a** | No UI, no `ui/open-link` |

## Evidence: live run against production, 2026-10-28

With curl/Node as the Anthropic reviewer (script kept out of the repo; it prints statuses
only):

- `/api/auth/sign-in/email` with the reviewer password → 200
- `POST /oauth/register` (public client, loopback redirect) → 201
- `GET /oauth/authorize` (S256, `resource=…/mcp`, `scope=vault offline_access`) with the session → 200 consent page with vault picker
- Approve → 303 to the loopback redirect with `code`, `state` and `iss=https://brainz.brownmatter.ai`
- `POST /oauth/token` (form-encoded, no Origin) → 200 `Bearer`, `scope=vault`, `expires_in=3600`, refresh token issued
- MCP `initialize` 200; `tools/list` → 16 tools
- `vault_stats`, `search_concepts`, `get_concept`, `get_related`, `get_context`, `list_concepts`, `list_tasks` and `onboard status` → 200 OK; unknown id → actionable `isError`
- `POST /oauth/revoke` → 200, then `tools/call` → 401

## Evidence: live client run, 2026-10-29

Signed in to claude.ai and to Brainz as James, against production. The custom connector and
the `brainz-test` server were removed afterwards.

- **claude.ai custom connector.** Customize → Connectors → Add custom connector, name "Brainz", URL `https://brainz.brownmatter.ai/mcp`, OAuth client "Use Claude's published identity" (CIMD `https://claude.ai/oauth/mcp-oauth-client-metadata`). **pass**
  - claude.ai's add dialog **auto-detects "No sign-in"**, because anonymous `initialize` returns 200. Pick **Sign in when needed** by hand. In the portal, Step 6's answer still applies.
  - The tool list showed before sign-in: 7 read-only + 9 write/delete tools, all titled.
  - Lazy auth: the first `vault_stats` call showed "Authorization required … A connector needs your permission to continue" with **Connect**. After consent the call ran again and returned the vault's stats (226 concepts, 765 edges).
  - Consent page: "Connect claude.ai to Brainz", the account email, the can/can't box, a vault picker (first vault pre-ticked, plus "All my vaults…"), "+ New vault", and sends you back to `claude.ai`.
- **Multi-vault (two vaults ticked).** **pass**. The grant was stored as `selected` with 2 `oauth_grant_vault` rows. claude.ai re-fetched the tools (17, including `list_vaults`). `list_vaults` returned both vaults with role `owner`, `includesFutureVaults: false`. `vault_stats` without `vault` failed with `MCP error -32602: Input validation error: Invalid arguments for tool vault_stats: … "path": ["vault"], "message": "Required"`. `vault_stats {vault: "brainz"}` succeeded.
- **Duplicate consent submits (found live, fix in progress).** Allow was posted more than once per consent: 3 codes in the first flow and 2 in the second, a few seconds apart, each a separate `?/approve` POST. claude.ai exchanged the **first** code and dropped the rest. In the second flow the first code was `single` (only the pre-ticked vault) and the later code was `selected`, so the connection silently got one vault instead of two. A clean retry with one click gave the right `selected` grant. Nothing is broken (each code is single-use, and the unused ones expire after 5 minutes), but the consent should not mint a code per click.
- **Claude Code.** **pass**. `claude mcp add --transport http --scope local brainz-test https://brainz.brownmatter.ai/mcp` → `claude mcp list` shows "✔ Connected" (anonymous handshake). A headless `claude -p` call to `vault_stats` returned `MCP server "brainz-test" needs you to sign in again (run /mcp to re-authenticate)`. In an interactive session, `/mcp` → Authenticate used CIMD `https://claude.ai/oauth/claude-code-client-metadata` with redirect `http://localhost:<port>/callback`. The consent page showed the loopback warning ("This app runs on your own computer…") and, per the CIMD rule, named the client by host ("claude.ai", not "Claude Code"). After Allow came "Authentication successful. Connected to brainz-test.", then `vault_stats` returned 232 concepts and 780 edges. Removed with `claude mcp remove brainz-test`.
- **Not run:** every remaining tool from a Claude client. The task was stopped once the goal was clarified as the public directory listing, not a custom connector.

## Evidence: every tool through MCP Inspector, 2026-10-29

As the reviewer account, over a fresh OAuth grant (password sign-in, DCR, one vault, S256), with
`@modelcontextprotocol/inspector@2.11.0 --cli --transport http`. The script is kept out of the
repo, and it printed no secrets. `tools/list` returned 16 tools. All 16 were called once and every
call returned ok: `vault_stats`, `search_concepts`, `get_concept`, `get_related`,
`get_context`, `list_concepts`, `list_tasks`, `upsert_concept` (a self-test decision),
`link_concepts`, `create_task`, `take_task`, `complete_task`, `onboard status`, `sync status`,
`dream status`, and `delete_concept` (for both the decision and the task). Reading the deleted id
back gave the actionable `isError`. Afterwards the vault was back to 31 concepts / 114 edges with
the seeded task states (4 open, 1 taken, 1 done), so it needed no reseed, and the grant was
revoked (200).

Note: `dream status` reported dreaming **enabled** on the reviewer vault (24 h cadence). A nightly
sweep could merge or tombstone seeded concepts while a review is in progress. It was turned off on
2026-10-30 (see "Reviewer vault upkeep").

## Screenshots

`screens/claude-ai-tool-list.png`: the claude.ai connector page listing the 16 tools (7 read-only, 9
write/delete) with their titles, captured 2026-10-29. It has no account or vault data. Other captures
from that run (the consent page, tool results) show James's account and vault names and are kept out
of the repo.

Not required: Brainz is not an MCP App, so there is no carousel. The demo video in the OpenAI
packet covers the flow. Optional captures for marketing or docs: the consent screen with the
vault picker, and a Claude conversation running `get_context`.

## Reviewer vault upkeep

- Seed or reset: `node docs/submissions/seed-reviewer-vault.mjs ~/.config/brainz-reviewers/anthropic.json`. This runs on top of `apps/cloud/scripts/reviewer-account.mjs --seed`, is idempotent, and puts the tasks back to their seeded states.
- If the account is ever re-created, mark the vault onboarded again (`onboard {action:"complete"}` over an OAuth connection) so tool results carry no onboarding notice.
- Delete anything a review created, e.g. the PostHog decision, by hand or from the reviewer's own Claude connection.
- **Dreaming is OFF** on this vault (and on the OpenAI reviewer vault) since 2026-10-30, with James's approval. It was done with the reviewer's own access: a password session minted a temporary vault key, called `dream {action:"configure", enabled:false}` on `/mcp`, and revoked the key. `dream status` now shows `enabled: false`, `nextDreamAt: null`. **Turn it back on after both reviews** the same way with `enabled: true` (24 h cadence). The last sweep, on 2026-10-29 at 09:53 UTC, changed 24 concepts in its light stage.
