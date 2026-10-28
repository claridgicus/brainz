# Brainz — ChatGPT plugin directory submission packet

Prepared 2026-10-28 against production (deploy 093faaf: cloud a929f671, marketing 07ea880c).
Portal: <https://platform.openai.com/plugins> → **Upload new or existing plugin**.
Submitter: an organization Owner, or a member with **Apps Management Write**, in a verified org,
using a **global** data-residency project ("Projects with EU data residency can't submit plugins
with MCP servers").

Sources, all official and fetched 2026-10-28:
[submission](https://developers.openai.com/plugins/deploy/submission) ·
[app review](https://developers.openai.com/plugins/deploy/app-review) ·
[guidelines](https://developers.openai.com/apps-sdk/app-submission-guidelines) ·
[package / MCP auth reference](https://developers.openai.com/plugins/build/plugins).
Anything the docs don't state is marked **UNCONFIRMED**.

No secrets are in this file or in `openai-plugin/`. The reviewer credentials live in
`~/.config/brainz-reviewers/openai.json` (mode 0600) and go only into the portal's
**Review details** form. The ZIP format rejects `test_credentials` and `reviewer_instructions`.

---

## Before you start

| # | Item | State | Tracking task |
|---|---|---|---|
| 1 | Verify the OpenAI Platform org (business: Plutocracy Pty Ltd, or individual) | **gap** (takes days, start first) | `james-verify-the-openai-platform-organization-for-the-brainz-listing` |
| 2 | Serve the domain-verification token at `/.well-known/openai-apps-challenge` (it 404s today) | **code done, needs deploy + secret** (route returns `OPENAI_APPS_CHALLENGE` as text/plain, 404 while unset) | `serve-the-openai-domain-verification-token-at-well-known-openai-apps-challenge` |
| 3 | Run the 8 test cases in ChatGPT (developer mode) as the OpenAI reviewer | **gap** (read cases verified over curl) | `james-live-client-tests-claude-ai-claude-code-and-chatgpt-against-production` |
| 4 | Record and host the demo video; add its URL to `plugin.json` | **gap** | `james-record-and-host-the-openai-review-demo-video` |
| 5 | No Cloudflare WAF/bot rule blocks ChatGPT's egress | **unknown** | `james-confirm-no-cloudflare-waf-bot-rule-blocks-claude-or-chatgpt-on-brainz-brownmatter-ai` |
| 6 | support@brownmatter.ai monitored (review feedback arrives by email) | **unknown** | `james-make-support-brownmatter-ai-a-monitored-inbox` |
| 7 | Docs: "Connect from ChatGPT" section | **gap** | `docs-add-connect-from-claude-and-connect-from-chatgpt-setup-sections` |
| 8 | Privacy policy discloses OAuth connector data ("Undisclosed user data" is a listed rejection reason) | **gap** | `privacy-policy-disclose-oauth-connector-data-needs-james-s-approval` |
| 9 | Neutral onboard/sync notices in tool results | **gap** (advised; reviewer vault unaffected) | `make-the-onboard-sync-notices-in-tool-results-neutral-on-directory-surfaces` |
| 10 | Refresh the OpenAI egress snapshot (`apps/cloud/scripts/refresh-openai-egress.mjs`) | **pass** on 2026-10-28 (no diff) | re-run right before submitting |

---

## Step 1 — Build and upload the ZIP

The package is committed at `docs/submissions/openai-plugin/` in the portable (Agent Plugins)
format:

```
openai-plugin/
  plugin.json            listing, review cases, release notes (extensions.com.openai)
  mcp.json               one remote server, OAuth via DCR, scope "vault"
  assets/logo.png        512×512 PNG (primary listing icon)
  assets/composer-icon.png 256×256 PNG
```

It has no skills, hooks or `.app.json`: hooks make a package ineligible, and skills add a scan
for no gain. Before zipping, add `"demo_recording_url": "<video URL>"` under
`extensions.com.openai.review` (item 4). Then:

```sh
cd docs/submissions/openai-plugin && zip -r -X ../brainz-openai-plugin.zip plugin.json mcp.json assets
```

Upload it, choose the verified **Developer identity** (the directory shows that name, not
`developerName`), and fix anything **Metadata & Skills** flags.

### Listing fields (from `plugin.json`)

| Field | Limit | Value |
|---|---|---|
| `name` | 64, `[a-z0-9-]` | `brainz` |
| `version` | semver | `1.0.0` |
| `displayName` | 30 | `Brainz`. OpenAI: don't append "MCP" or "Plugin", and avoid generic dictionary words; "Brainz" is a coined brand. |
| `shortDescription` | 30 | `Your product knowledge graph` (28) |
| `longDescription` | 4000 | Tasks, intended users and limitations, about 1,640 chars (see `plugin.json`). No pricing or comparisons. |
| `developerName` | 80 | `Brownmatter` (overridden by the verified identity) |
| `category` | dashboard list | `Developer Tools`. The full list is only in the dashboard (**UNCONFIRMED**); `Productivity` is the fallback. |
| `capabilities` | ≤ 20 × 120 | Search product knowledge · Assemble task briefings · Record concepts and decisions · Manage a task pile |
| `websiteURL` | HTTPS | `https://brownmatter.ai` |
| `supportURL` | HTTPS | `https://brownmatter.ai/support` |
| `privacyPolicyURL` | HTTPS | `https://brownmatter.ai/privacy` |
| `termsOfServiceURL` | HTTPS | `https://brownmatter.ai/terms` |
| `defaultPrompt` | ≤ 3 × 128 | "What's in my Brainz vault?" · "Brief me from Brainz on the lead scoring work before I start coding." · "List the open tasks in my Brainz vault." |
| `brandColor` | ≥ 2:1 on white | `#C24D6F` (4.58:1) |
| `brandColorDark` | ≥ 2:1 on #212121 | `#F58EA8` (7.14:1) |
| `logo` / `composerIcon` | square, ≥ 48 px, ≤ 5 MiB | `assets/logo.png` (512²), `assets/composer-icon.png` (256²): the mark on the app's dark tile, which reads on light and dark themes, so there are no `*Dark` variants |
| `screenshots` | optional | **Omitted.** "Don't provide screenshots if the plugin has no UI." |
| `publication.countries` | optional | **Omitted** (keeps the dashboard's targeting). James's call: `[]` means everywhere; a list like `["AU","US","GB","NZ","CA"]` means only those. |
| `publication.release_notes` | | Initial-release summary |
| `review.commerce` | | `false`, with "Brainz does not sell anything or process payments, and no tool shows plans, prices or upgrades." |

## Step 2 — Connect and scan the MCP server

| Field | Value |
|---|---|
| MCP Server URL | `https://brainz.brownmatter.ai/mcp` (universal URL, not a template) |
| Authentication | **OAuth**. Every tool call needs a vault; unauthenticated `tools/list` works and `tools/call` gets a 401 challenge. Declared `auth.type: "oauth"` in `mcp.json`. **Mixed** would also be accepted, but `/mcp` has no callable public tool. |
| Client registration | `client.mode: "dcr"`. Discovery supplies `registration_endpoint`, so there are no endpoint overrides, no client ID and no secret field. The server also supports CIMD if OpenAI prefers it. |
| Scopes | `baseScopes: ["vault"]` |
| Callback URL | ChatGPT registers its own through DCR, and redirect URIs are matched exactly, so there is no allowlist to maintain. The exact ChatGPT callback is **UNCONFIRMED** in OpenAI's docs. |
| Server headers | None (public submission rejects nonempty headers) |
| Domain verification | Portal shows a token → serve it at `https://brainz.brownmatter.ai/.well-known/openai-apps-challenge` as plain text (item 2: route is on branch `openai-challenge` and ships with the next deploy; then `wrangler secret put OPENAI_APPS_CHALLENGE`). Parent `brownmatter.ai` is also allowed but is a different worker. |
| Account used to connect and scan | The OpenAI reviewer account (consent screen → "Brainz demo"), or James's own account with a vault |

Discovery as verified live: PRM at `/.well-known/oauth-protected-resource/mcp`
(`resource` = the MCP URL), AS metadata at `/.well-known/oauth-authorization-server` (S256
PKCE, `authorization_code` + `refresh_token`, rotating refresh tokens, revocation endpoint).
DCR from OpenAI's published egress skips the registration rate limit
(`apps/cloud/src/lib/server/openai-egress.ts`).

### Tool annotations and justifications

The dashboard shows what the server advertises. Justifications go in the scan review. OpenAI's
definitions: readOnly = "strictly reads data"; destructive = "can cause irreversible outcomes";
openWorld = "accesses the public internet or open-ended external entities", false for "a
bounded private account or workspace".

| Tool | RO | Destr. | Open | Justification to paste |
|---|---|---|---|---|
| `search_concepts` | T | F | F | Ranked search over the connected vault's own index. Reads only; scoped to one private vault. |
| `get_concept` | T | F | F | Returns one concept and its direct neighbours from the connected vault. Reads only. |
| `get_related` | T | F | F | Walks the connected vault's graph from one concept. Reads only. |
| `get_context` | T | F | F | Assembles a markdown briefing from the connected vault's concepts, trimmed to a token budget. Writes nothing. |
| `list_concepts` | T | F | F | Lists concept metadata (no bodies) from the connected vault. Reads only. |
| `vault_stats` | T | F | F | Counts and facets of the connected vault. Reads only. |
| `list_tasks` | T | F | F | Lists the connected vault's task concepts and their lifecycle state. Reads only. |
| `upsert_concept` | F | **T** | F | Creates a concept, or **overwrites** an existing concept's title, body and fields when the id already exists. The previous text is not kept, so an overwrite is irreversible. Scoped to the connected vault; requires owner or editor role. |
| `delete_concept` | F | **T** | F | Permanently removes a concept and its outgoing edges from the connected vault. Irreversible. Owner or editor only. |
| `link_concepts` | F | F | F | Adds one typed edge between two existing concepts. Additive: removes or overwrites nothing. |
| `create_task` | F | F | F | Creates a new task concept. Additive. |
| `take_task` | F | F | F | Moves a task from open to taken and records who took it. Reversible state change (it can be reopened); no content lost. |
| `complete_task` | F | F | F | Marks a task done and **appends** an Outcome section. Existing text is kept. |
| `onboard` | F | F | F | `start`/`status` return a playbook or a coverage report; `complete` stamps the vault as onboarded and writes or appends the vault's own summary note. No user content is removed. |
| `sync` | F | F | F | Same as onboard, for re-indexing after code changes. |
| `dream` | F | **T** | **T** | `run` can merge duplicate concepts and tombstone the losers. A `revert` exists, but OpenAI says undo alone doesn't justify false, so destructive is true. The REM stage sends vault concept text (never conversation content) to an LLM provider outside Brainz: Cloudflare Workers AI, or the vault owner's own Anthropic/OpenAI key. That is why openWorld is true. `status`/`configure` don't merge. |

Not exposed on `/mcp` for OAuth connections: `session_hook`, `signup`, `sign_in` and `claim`.
`signup` returns an API key in the tool result, and OpenAI forbids plugins that "collect, solicit,
or process" API keys.

## Step 3 — Review details

### Reviewer credentials (portal form only)

Fill from `~/.config/brainz-reviewers/openai.json`:

```text
Login URL:  https://brainz.brownmatter.ai/login   (ChatGPT's OAuth flow lands here too)
Email:      <email from the credentials file>
Password:   <password from the credentials file>
Workspace:  vault "Brainz demo" (owner) — pick it on the consent screen

Sign-in: on the Brainz sign-in page choose "Sign in with a password". No MFA, no email or SMS
code, no magic link, works from any network. The consent screen shows the client, what is
granted (read and write the concepts and tasks in one vault, as you) and the vault picker;
select "Brainz demo" and Approve.
Sample data: a fictional product (Acme CRM), with 31 concepts and 6 tasks (4 open, 1 taken, 1 done).
Write test cases change only this vault; we reset it between reviews.
```

The account is a password login created by `apps/cloud/scripts/reviewer-account.mjs` (sign-up
is disabled for passwords). Its address is unguessable, so nobody can lock it out with failed
attempts.

### Test cases (in `plugin.json`, imported read-only)

Exactly five positive and three negative cases, matching the seeded vault. Cases 1–3 were
checked live against the OpenAI reviewer vault on 2026-10-28.

| # | Prompt | Tools | Expected |
|---|---|---|---|
| P1 | What's in my Brainz vault? | `vault_stats` | About 31 concepts, 114+ edges, product acme-crm, breakdown by type; nothing changed |
| P2 | Search Brainz for the lead scoring model and tell me the score tiers. | `search_concepts`, `get_concept` | From spec-lead-scoring-model: hot ≥ 70, warm 40–69, cold < 40; hot leads routed within 5 min |
| P3 | Use Brainz to brief me on showing sales reps why a lead's score changed, including where in the code the work lands. | `get_context` | Briefing with the story, the spec, the nightly-batch decision and the open task, with code areas `services/scoring/src/history.ts` and `web/src/routes/leads/[id]/**` |
| P4 | List the open tasks in my Brainz vault, then take the high-priority one about lead score explanations. | `list_tasks`, `take_task` | 4 open tasks listed; task-score-change-explanations becomes taken, and its briefing is shown |
| P5 | Record a decision in Brainz: we will use PostHog for product analytics because it can self-host in the EU. Link it to lead scoring. | `upsert_concept`, `link_concepts` | New decision concept with the reason, linked to lead-scoring |
| N1 | What's the weather in Melbourne tomorrow? | none | Unrelated: Brainz not called |
| N2 | Show me what's in my colleague's Brainz vault called finance-brain. | none (or read tools on the connected vault only) | The grant covers one vault; explain that only the connected vault is reachable |
| N3 | Email the lead scoring spec from Brainz to sales@acme.example. | at most `search_concepts`/`get_concept` | No email tool exists; say it can't send email and offer the content |

After a review run, reset the vault (see "Reviewer vault upkeep").

### Demo video, release notes

- `review.demo_recording_url`: add it once recorded (script below).
- Release notes: already in `plugin.json`.

## Step 4 — Submit

**Submit for review** → complete the policy attestations. Status shows under **Review status**,
and feedback arrives by email (item 6). Once approved, James chooses when to **Publish plugin**.
Only one review can be active per plugin.

---

## Gap check against OpenAI's review criteria

| Requirement (source) | Brainz | Evidence / note |
|---|---|---|
| Verified individual or organization (guidelines, app review) | **gap** | Item 1 |
| Public HTTPS MCP endpoint, not local/testing (app review) | **pass** | `https://brainz.brownmatter.ai/mcp` |
| Auth is none / OAuth / mixed; no API key, no static headers (submission) | **pass** | OAuth (DCR/CIMD); `mcp.json` has no headers |
| Domain verification token served as plain text (submission) | **gap** | Item 2 |
| One MCP server per plugin (submission) | **pass** | One server in `mcp.json` |
| `readOnlyHint`/`destructiveHint`/`openWorldHint` explicit on every tool (guidelines) | **pass** | 16/16 explicit booleans, verified via `tools/list` |
| Annotations match behaviour (app review: a common rejection) | **pass**, with one judgement call | `dream` openWorld=true: an external LLM call. A reviewer might read "bounded workspace" as false; justification above. |
| Tool names plain verbs, unique, no promo terms (guidelines) | **pass** | `search_concepts`, `get_context`, `take_task`… |
| Descriptions match behaviour; no steering or over-broad triggering (guidelines) | **pass** for descriptions and instructions | Contracts lint test; neutral `serverInstructions()` |
| Address the request directly; no unrelated content (guidelines) | **gap** (advised) | Onboard/sync notices in results (item 9); the reviewer vault is onboarded |
| Transparent auth; users told every permission (guidelines) | **pass** | Consent screen names the client and the grant, with a vault picker and Deny |
| Test credentials: no MFA / email / magic link; work off-network; sample data (app review, submission) | **pass** | Password reviewer login; seeded sample vault; verified live |
| 5 positive + 3 negative test cases (submission) | **pass** (written), **gap** (not yet run in ChatGPT) | `plugin.json`; item 3 |
| Demo recording URL (submission) | **gap** | Item 4 |
| Privacy, terms, support and website URLs, all HTTPS (submission) | **pass** | All four return 200 |
| Privacy policy covers categories, purposes, recipients, retention, controls (guidelines) | **pass** for accounts and vault content; **gap** for OAuth grants and clients | Item 8 |
| No restricted data (API keys, passwords, PHI, PCI, government IDs) (guidelines) | **pass** | No key-returning tools on `/mcp`; no tool takes credentials |
| No conversation history or precise location in inputs (guidelines) | **pass** | No such parameters |
| Tool responses avoid request/trace IDs, timestamps and logging metadata unless needed (guidelines) | **unknown** | Responses carry concept and task timestamps (`createdAt`, `takenAt`, `doneAt`, `lastDreamAt`). They are product data for the task lifecycle, not logging metadata. No request/trace IDs. Defend if asked. |
| No commerce, plans, upsell (guidelines) | **pass** | No pricing text in any tool or result; `review.commerce=false` |
| Suitable for 13+; no ads; no impersonation (guidelines) | **pass** | |
| Error handling with clear messages (guidelines) | **pass** | Unknown id → actionable `isError` |
| Accurate support contact (guidelines) | **unknown** | Item 6 |
| Logo square ≥ 48 px, ≤ 5 MiB (submission) | **pass** | 512² and 256² PNG |
| Screenshots only with UI (app review) | **pass** | None provided |
| Global data-residency project (app review) | **unknown** | Pick a global project at upload |

---

## Demo video script

Target length 3½–4 minutes, 1080p screen recording of chatgpt.com (desktop browser), signed in to
a ChatGPT account with developer mode on (or the approved test listing). Brainz is connected as
the **OpenAI reviewer**. Before recording, reset the vault
(`node docs/submissions/seed-reviewer-vault.mjs ~/.config/brainz-reviewers/openai.json`) and
remove any earlier Brainz connector so the sign-in shows. Expand tool-call details where ChatGPT
allows it, so reviewers see which tool ran. Don't show the password: type it off-camera or
blur it.

| # | Shot (what's on screen) | Narration | ~sec |
|---|---|---|---|
| 1 | Title card: Brainz zombie-brain logo, "Brainz for ChatGPT — review walkthrough", brownmatter.ai | "This is Brainz, a shared product-knowledge graph. I'll connect it to ChatGPT and run the review test cases on a sample vault." | 10 |
| 2 | ChatGPT → Settings → Apps & Connectors → add Brainz (`https://brainz.brownmatter.ai/mcp`), click Connect | "Brainz connects over OAuth. There's no API key to paste." | 15 |
| 3 | Brainz sign-in page → "Sign in with a password" → reviewer email; password entered off-camera | "Reviewers sign in with a password. No email codes, no MFA." | 15 |
| 4 | Consent screen: client name, "read and write the concepts and tasks in one vault, as you", vault picker showing "Brainz demo (owner)", Approve | "The consent screen says exactly what ChatGPT gets: one vault, read and write, as me. I pick the vault and approve." | 15 |
| 5 | Back in ChatGPT, Brainz connected; new chat | "Brainz is connected. The vault holds a fictional CRM product: domains, specs, decisions and a task pile." | 10 |
| 6 | **P1** "What's in my Brainz vault?" → `vault_stats` → answer | "First, an overview. vault_stats is read-only: 31 concepts, one product, broken down by type." | 20 |
| 7 | **P2** "Search Brainz for the lead scoring model and tell me the score tiers." → `search_concepts`, `get_concept` | "Search finds the scoring spec, and get_concept reads it: hot is 70 and up, warm 40 to 69, cold below 40." | 25 |
| 8 | **P3** "Use Brainz to brief me on showing sales reps why a lead's score changed, including where in the code the work lands." → `get_context` | "get_context assembles a briefing from the graph: the user story, the spec, the batch-scoring decision and the open task, with the code paths. You can hand it to a coding agent as is." | 30 |
| 9 | **P4** "List the open tasks in my Brainz vault, then take the high-priority one about lead score explanations." → `list_tasks`, `take_task`; scroll the briefing | "Brainz keeps a task pile that people and agents share. Taking a task marks it taken and returns its briefing." | 25 |
| 10 | **P5** "Record a decision in Brainz: we will use PostHog for product analytics because it can self-host in the EU. Link it to lead scoring." → confirmation prompt if shown → `upsert_concept`, `link_concepts` | "Knowledge flows back too. This records a decision and links it into the graph. Writes that can overwrite are marked destructive, so ChatGPT asks first." | 30 |
| 11 | Optional: brainz.brownmatter.ai graph view of the vault, showing the new PostHog node linked to Lead Scoring | "Here's the same decision in the Brainz app, linked to lead scoring." | 10 |
| 12 | **N1** "What's the weather in Melbourne tomorrow?" → answered without Brainz | "Unrelated questions don't touch Brainz." | 10 |
| 13 | **N2** "Show me what's in my colleague's Brainz vault called finance-brain." → explains only the connected vault is available | "A connection covers one vault. Brainz can't reach anyone else's." | 15 |
| 14 | **N3** "Email the lead scoring spec from Brainz to sales@acme.example." → says it can't send email, offers the content | "Brainz has no email or messaging tools, so it doesn't pretend to send anything." | 15 |
| 15 | End card: brownmatter.ai/docs, support@brownmatter.ai, privacy and terms URLs | "Docs, privacy policy and support are at brownmatter.ai. Thanks for reviewing Brainz." | 10 |

Afterwards, reset the reviewer vault, delete the PostHog decision by hand, and host the video
unlisted (YouTube unlisted, Loom or a public R2 object) so reviewers can open it without signing in.

## Screenshots to capture

None are required: the plugin has no UI, and OpenAI says not to send screenshots. The video
covers the flow. Keep stills of shots 4 (consent) and 8 (briefing) for the docs page (item 7).

## Reviewer vault upkeep

- Seed or reset: `node docs/submissions/seed-reviewer-vault.mjs ~/.config/brainz-reviewers/openai.json`. It upserts the 17 seed concepts on top of the demo-vault seed and reopens any seeded open task that was taken.
- The vault was marked onboarded on 2026-10-28. If the account is re-created, run `onboard {action:"complete"}` again over an OAuth connection.
- Concepts a review created, such as the PostHog decision, are not removed by the seed. Delete them by hand.
