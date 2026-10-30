/**
 * The demos, declared.
 *
 * Each entry is a clip the marketing site (and the OpenAI submission) shows:
 * an id (the file name under apps/marketing/static/demos/), what it is for a
 * reader, the persona its demo account signs up as, the sources it depends
 * on (globs, beside the implicit set in `fingerprint.ts`) and the flow that
 * records it. `npm run demos:check` holds every entry's recorded fingerprint
 * against the tree; `npm run demos:record <id>` records one. Adding a demo is
 * adding an entry here and a flow beside the others.
 */
import type { Take } from "./take.js";
import type { Client, DemoTenant, Persona } from "./tenant.js";
import { consentAndConnect } from "./flows/consent-and-connect.js";
import { dashboardGraph } from "./flows/dashboard-graph.js";
import { openaiReview } from "./flows/openai-review.js";

/** What a flow has to hand while it prepares and records. */
export interface Context {
  /** The app on the demo stack. */
  readonly origin: string;
  readonly tenant: DemoTenant;
  /** The REST API, signed in as the demo account. */
  readonly api: Client;
  /** A scratch directory for files the flow makes. */
  readonly scratch: string;
}

export interface Demo {
  readonly id: string;
  readonly title: string;
  /** One sentence for the site: what the watcher will see. */
  readonly description: string;
  /** Who the demo account is. Unique per demo: every demo of a run signs up on the same fresh stack. */
  readonly persona: Persona;
  /** Vaults the account gets beside the seeded "Brainz demo" one (empty). */
  readonly extraVaults?: ReadonlyArray<{ readonly name: string; readonly slug: string }>;
  /** Sources the clip shows, as globs from the repository root. */
  readonly dependencies: ReadonlyArray<string>;
  /** Prepare what the flow needs (before the clock), then drive the take. */
  readonly run: (take: Take, context: Context) => Promise<void>;
}

export const DEMOS: ReadonlyArray<Demo> = [
  {
    id: "consent-and-connect",
    title: "Connect an AI app to a vault",
    description:
      "An AI app asks to connect over OAuth; the consent screen says what it gets, you search your vaults, pick two and allow it.",
    persona: { name: "Alex Morgan", email: "alex.morgan@acme.example" },
    // Seven vaults in all: more than five puts the consent page's picker in search mode.
    extraVaults: [
      { name: "Mobile app", slug: "mobile-app" },
      { name: "Billing platform", slug: "billing-platform" },
      { name: "Design system", slug: "design-system" },
      { name: "Data warehouse", slug: "data-warehouse" },
      { name: "Support tooling", slug: "support-tooling" },
      { name: "Growth experiments", slug: "growth-experiments" },
    ],
    dependencies: [
      "apps/cloud/src/routes/oauth/**",
      "apps/cloud/src/lib/server/oauth.ts",
    ],
    run: consentAndConnect,
  },
  {
    id: "dashboard-graph",
    title: "A vault's knowledge graph",
    description:
      "Open a vault from the dashboard, search the graph for the lead scoring spec, follow its links, and see the task board.",
    persona: { name: "Sam Rivera", email: "sam.rivera@acme.example" },
    dependencies: [
      "apps/cloud/src/routes/(app)/dashboard/**",
      "apps/cloud/src/routes/(app)/v/**",
      "apps/cloud/src/lib/graph-*.ts",
      "apps/cloud/src/lib/api.ts",
    ],
    run: dashboardGraph,
  },
  {
    id: "openai-review",
    title: "Brainz for ChatGPT: the review walkthrough's Brainz-side shots",
    description:
      "The title card, the decision ChatGPT recorded shown in the Brainz graph linked to lead scoring, and the end card: the shots of the OpenAI review video that are not ChatGPT itself (docs/submissions/openai.md).",
    persona: { name: "Jordan Lee", email: "jordan.lee@acme.example" },
    dependencies: [
      "apps/cloud/src/routes/(app)/v/[slug]/+page.svelte",
      "apps/cloud/src/routes/(app)/v/[slug]/+page.server.ts",
      "apps/cloud/src/lib/graph-*.ts",
    ],
    run: openaiReview,
  },
];

/** The files a demo's recording produces, relative to the marketing site. */
export const outputsOf = (id: string): ReadonlyArray<string> => [
  `static/demos/${id}.mp4`,
  `static/demos/${id}-bleed.mp4`,
  `static/demos/${id}.webp`,
  `static/demos/${id}-bleed.webp`,
];
