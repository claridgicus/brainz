#!/usr/bin/env node
/**
 * Top up a directory reviewer's "Brainz demo" vault with the concepts the
 * review test cases in anthropic.md / openai.md rely on: domains, stories,
 * specs, a workflow, a decision, a constraint, and a task pile in every
 * lifecycle state. It runs on top of the examples/demo-vault seed that
 * `apps/cloud/scripts/reviewer-account.mjs --seed` already wrote.
 *
 * Usage (repo root):
 *   node docs/submissions/seed-reviewer-vault.mjs ~/.config/brainz-reviewers/anthropic.json
 *
 * The credentials file is the one reviewer-account.mjs's operator saved
 * ({email, password, origin, vaultId, ...}). Nothing from it is printed.
 * Upserts by explicit id, so re-running is idempotent.
 */
import { readFileSync } from "node:fs";

const PRODUCT = "acme-crm";

/** @type {Array<Record<string, unknown>>} */
export const SEED = [
  // ---------------------------------------------------------------- domains
  {
    id: "sales-pipeline",
    title: "Sales Pipeline",
    type: "domain",
    tags: ["sales"],
    relations: { related_to: ["marketing-automation"] },
    body: `Everything between a qualified [[lead]] and a closed deal: scoring, routing,
the marketing-to-sales handoff and the rep's working views.

Owned by the Revenue squad. Key features: [[lead-scoring]], [[lead-routing]].
The handoff from marketing is the [[lead-handoff]] workflow.`,
  },
  {
    id: "marketing-automation",
    title: "Marketing Automation",
    type: "domain",
    tags: ["marketing"],
    relations: { related_to: ["sales-pipeline", "data-platform"] },
    body: `Segments, campaigns and nurture sequences. Main feature: [[email-campaigns]].
Every send is gated by [[email-consent]]. Engagement events feed
[[lead-scoring]] in the [[sales-pipeline]] domain.`,
  },
  {
    id: "data-platform",
    title: "Data Platform",
    type: "domain",
    tags: ["platform"],
    relations: { related_to: ["sales-pipeline"] },
    body: `Contact storage, imports, exports and the event pipeline. Owns the
[[contact-model]] and [[contact-import]], and enforces [[gdpr-data-residency]]
for every copy of personal data.`,
  },

  // ---------------------------------------------------------------- stories
  {
    id: "story-explain-score-change",
    title: "Story: a rep can see why a lead's score changed",
    type: "story",
    tags: ["sales", "lead-scoring"],
    relations: { part_of: ["sales-pipeline"], realized_by: ["lead-scoring"] },
    body: `**As** an account executive, **I want** the lead detail page to show the top
three signals behind a score change since yesterday, **so that** I can open the
call with what the prospect actually did.

Acceptance:
- Shows old score, new score and the three largest signal deltas, worded for
  humans ("Opened pricing email 3x").
- Only for changes of 10 points or more (smaller moves are noise).
- Uses the 12-month score history that [[lead-scoring]] already keeps.`,
  },
  {
    id: "story-import-without-duplicates",
    title: "Story: importing a CSV never creates duplicate contacts",
    type: "story",
    tags: ["contacts", "ingestion"],
    relations: { part_of: ["data-platform"], realized_by: ["contact-import"] },
    body: `**As** a sales-ops admin, **I want** a re-imported trade-show list to update the
contacts we already have, **so that** reps never see two records for one person.

Acceptance:
- Matching follows [[spec-import-dedupe]].
- The dedupe preview lists "will update" and "will create" counts before commit.
- Rollback restores updated contacts to their pre-import values.`,
  },

  // ---------------------------------------------------------------- specs
  {
    id: "spec-lead-scoring-model",
    title: "Spec: lead scoring model v2",
    type: "spec",
    tags: ["sales", "lead-scoring"],
    relations: { governs: ["lead-scoring", "lead-routing"] },
    body: `Score = clamp(0, 100, fit + engagement - decay).

| Signal | Points | Cap |
|---|---|---|
| Firmographic fit (industry, size, region) | 0-40 | 40 |
| Email open / click | +2 / +5 | 25 |
| Pricing page visit | +8 | 24 |
| Demo request | +30 | 30 |
| Inactivity decay | -5 per 14 days | none |

Tiers: **hot** >= 70, **warm** 40-69, **cold** < 40. Hot leads go to
[[lead-routing]] within 5 minutes. Weights change only through a decision note,
and a weight change triggers a score-history backfill.`,
  },
  {
    id: "spec-import-dedupe",
    title: "Spec: contact import dedupe rules",
    type: "spec",
    tags: ["contacts", "ingestion"],
    relations: { governs: ["contact-import"] },
    body: `A row matches an existing contact when any of these hold, checked in order:

1. Lower-cased, trimmed email equals a stored email (primary or secondary).
2. Phone normalised to E.164 equals a stored phone **and** the last name matches.
3. External CRM id (\`external_ref\`) equals a stored one.

A match updates only empty fields unless the admin picks "overwrite". Rows
matching two different contacts are listed as conflicts and skipped. Matching
runs inside the tenant only; it never crosses tenants or residency regions
([[gdpr-data-residency]]).`,
  },

  // ---------------------------------------------------------------- feature / workflow / decision / constraint
  {
    id: "lead-routing",
    title: "Lead Routing",
    type: "feature",
    tags: ["sales"],
    status: "active",
    relations: { part_of: ["sales-pipeline"], depends_on: ["lead-scoring"] },
    body: `Assigns hot leads (see [[spec-lead-scoring-model]]) to a rep: round-robin
inside the lead's territory, skipping reps marked out of office. Unassigned hot
leads after 5 minutes page the sales manager.`,
  },
  {
    id: "lead-handoff",
    title: "Workflow: marketing-to-sales lead handoff",
    type: "workflow",
    tags: ["sales", "marketing"],
    relations: { part_of: ["sales-pipeline"], depends_on: ["lead-routing"] },
    body: `1. A lead crosses 70 points and becomes an MQL ([[spec-lead-scoring-model]]).
2. [[lead-routing]] assigns an owner and notifies them in the CRM inbox.
3. The rep accepts (SQL) or rejects with a reason within **24 business hours**.
4. Rejected leads return to nurture in [[email-campaigns]] with the reason
   attached; three rejections in 90 days suppress the lead for a quarter.`,
  },
  {
    id: "decision-nightly-score-batch",
    title: "Decision: nightly batch scoring plus hot-event recompute",
    type: "decision",
    tags: ["sales", "lead-scoring", "architecture"],
    relations: { governs: ["lead-scoring"], related_to: ["outbox-pattern"] },
    body: `**Decision.** Scores are recomputed in a nightly batch, plus an immediate
recompute for "hot" events (demo request, pricing visit) delivered through the
[[outbox-pattern]].

**Why.** Full streaming scoring needed a second datastore and doubled cost for
about 2% of score changes that matter same-day. The hot-event path covers those.

**Consequences.** Score-change explanations
([[story-explain-score-change]]) compare against the previous nightly snapshot.`,
  },
  {
    id: "email-consent",
    title: "Constraint: campaign sends need recorded consent",
    type: "constraint",
    tags: ["compliance", "marketing"],
    relations: { constrains: ["email-campaigns"] },
    body: `A contact receives marketing email only if \`consent_at\` is set and
\`unsubscribed_at\` is empty. Imported contacts arrive **without** consent unless
the import maps a consent column with a source. Transactional email is exempt.
Applies in every region; EU tenants also need the consent source stored in the
EU ([[gdpr-data-residency]]).`,
  },

  // ---------------------------------------------------------------- tasks
  {
    id: "task-score-change-explanations",
    title: "Show score-change explanations on the lead detail page",
    type: "task",
    taskStatus: "open",
    tags: ["high", "sales"],
    codeAreas: ["services/scoring/src/history.ts", "web/src/routes/leads/[id]/**"],
    relations: {
      part_of: ["sales-pipeline"],
      realizes: ["story-explain-score-change"],
      governed_by: ["spec-lead-scoring-model"],
    },
    body: `Add a "Why did this change?" panel to the lead detail page, per
[[story-explain-score-change]]. Read the nightly snapshots from score history,
diff signal contributions, show the top three deltas. Hide below a 10-point move.`,
  },
  {
    id: "task-import-dedupe-by-email",
    title: "Match imported rows to existing contacts by email and phone",
    type: "task",
    taskStatus: "open",
    tags: ["high", "contacts"],
    codeAreas: ["services/import/src/match.ts", "services/import/src/preview.ts"],
    relations: {
      part_of: ["data-platform"],
      realizes: ["story-import-without-duplicates"],
      governed_by: ["spec-import-dedupe"],
    },
    body: `Implement the three match rules in [[spec-import-dedupe]] in the import
matcher, and surface "will update / will create / conflicts" counts in the
dedupe preview.`,
  },
  {
    id: "task-handoff-sla-alerts",
    title: "Alert managers when a handed-off lead passes the 24h SLA",
    type: "task",
    taskStatus: "open",
    tags: ["medium", "sales"],
    codeAreas: ["services/routing/src/sla.ts"],
    relations: { part_of: ["sales-pipeline"], realizes: ["lead-handoff"] },
    body: `Step 3 of [[lead-handoff]] has no enforcement today. Add a job that finds
assigned leads with no accept/reject after 24 business hours and notifies the
rep's manager once.`,
  },
  {
    id: "task-eu-export-residency",
    title: "Keep contact CSV exports for EU tenants inside the EU",
    type: "task",
    taskStatus: "open",
    tags: ["medium", "compliance"],
    codeAreas: ["services/export/src/storage.ts"],
    relations: { part_of: ["data-platform"], related_to: ["gdpr-data-residency"] },
    body: `Export files are written to a US bucket for every tenant. EU tenants must
write to the \`eu-central-1\` bucket and get signed URLs from there
([[gdpr-data-residency]]).`,
  },
  {
    id: "task-campaign-consent-filter",
    title: "Exclude contacts without consent from campaign audiences",
    type: "task",
    taskStatus: "taken",
    takenBy: "agent:campaigns",
    takenAt: "2026-10-27T09:12:00.000Z",
    tags: ["high", "marketing"],
    codeAreas: ["services/campaigns/src/audience.ts"],
    relations: { part_of: ["marketing-automation"], related_to: ["email-consent"] },
    body: `Apply [[email-consent]] when building a campaign audience, and show the
excluded count on the send-review screen.`,
  },
  {
    id: "task-routing-out-of-office",
    title: "Skip out-of-office reps in round-robin routing",
    type: "task",
    taskStatus: "done",
    takenBy: "agent:routing",
    takenAt: "2026-10-20T03:40:00.000Z",
    doneAt: "2026-10-21T06:05:00.000Z",
    tags: ["medium", "sales"],
    codeAreas: ["services/routing/src/round-robin.ts"],
    relations: { part_of: ["sales-pipeline"], realizes: ["lead-routing"] },
    body: `[[lead-routing]] kept assigning hot leads to reps on leave.

## Outcome

Round-robin now reads the calendar's out-of-office flag and skips those reps;
if a whole territory is out, the lead goes to the manager queue. Covered by
\`round-robin.test.ts\`.`,
  },
];

async function main() {
  const file = process.argv[2];
  if (!file) {
    console.error("usage: seed-reviewer-vault.mjs <credentials.json>");
    process.exit(2);
  }
  const creds = JSON.parse(readFileSync(file, "utf8"));
  const origin = String(creds.origin ?? "https://brainz.brownmatter.ai").replace(/\/+$/, "");
  const headers = { origin, "content-type": "application/json" };

  const signIn = await fetch(`${origin}/api/auth/sign-in/email`, {
    method: "POST",
    headers,
    body: JSON.stringify({ email: creds.email, password: creds.password }),
  });
  if (signIn.status !== 200) throw new Error(`sign-in failed: HTTP ${signIn.status}`);
  const cookie = signIn.headers
    .getSetCookie()
    .map((c) => c.split(";")[0])
    .join("; ");
  const authed = { ...headers, cookie };

  const list = await (await fetch(`${origin}/api/vaults`, { headers: authed })).json();
  const vault = list.vaults?.find((v) => v.id === creds.vaultId) ?? list.vaults?.find((v) => v.slug === "brainz-demo");
  if (!vault) throw new Error("reviewer has no Brainz demo vault; run reviewer-account.mjs --seed first");

  for (const c of SEED) {
    const res = await fetch(`${origin}/api/vaults/${vault.id}/concepts`, {
      method: "POST",
      headers: authed,
      body: JSON.stringify({ product: PRODUCT, status: "active", ...c }),
    });
    if (res.status !== 200 && res.status !== 201) {
      throw new Error(`upsert ${c.id} failed: HTTP ${res.status} ${await res.text()}`);
    }
  }
  // Upsert keeps an existing takenBy/takenAt, so a task a reviewer took goes back to open here.
  const { tasks = [] } = await (await fetch(`${origin}/api/vaults/${vault.id}/tasks`, { headers: authed })).json();
  const seededOpen = new Set(SEED.filter((c) => c.taskStatus === "open").map((c) => c.id));
  let reopened = 0;
  for (const t of tasks) {
    if (!seededOpen.has(t.id) || (t.taskStatus === "open" && !t.takenBy)) continue;
    const res = await fetch(`${origin}/api/vaults/${vault.id}/tasks/${t.id}`, {
      method: "PATCH",
      headers: authed,
      body: JSON.stringify({ action: "reopen" }),
    });
    if (res.status !== 200) throw new Error(`reopen ${t.id} failed: HTTP ${res.status} ${await res.text()}`);
    reopened++;
  }
  if (reopened) console.log(`reopened ${reopened} task(s)`);

  const stats = await (await fetch(`${origin}/api/vaults/${vault.id}/stats`, { headers: authed })).json();
  console.log(`${creds.directory ?? file}: upserted ${SEED.length}; vault now ${stats.concepts ?? stats.conceptCount ?? "?"} concepts, ${stats.edges ?? stats.edgeCount ?? "?"} edges`);
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((err) => {
    console.error(err.message);
    process.exit(1);
  });
}
