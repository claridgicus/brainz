/**
 * The Brainz-side shots of the OpenAI review video (docs/submissions/openai.md,
 * "Demo video script"): shot 1's title card, shot 11's graph view with the
 * decision ChatGPT recorded in shot 10 linked to lead scoring, and shot 15's
 * end card. Everything between them happens in ChatGPT and is screen-recorded
 * by hand (see "Recording the demo video" there): OpenAI's terms rule out
 * driving chatgpt.com with a script.
 *
 * The decision is upserted before the clock, with the id, title and link P5
 * asks ChatGPT for, so the graph shows what a reviewer's run leaves behind.
 */
import type { Context } from "../manifest.js";
import type { Take } from "../take.js";
import { DEMO_VAULT, upsertConcepts } from "../tenant.js";
import { card } from "./cards.js";

/** What test case P5 ("Record a decision in Brainz: we will use PostHog …") writes. */
export const POSTHOG_DECISION = {
  id: "decision-posthog-product-analytics",
  title: "Decision: use PostHog for product analytics",
  type: "decision",
  product: "acme-crm",
  status: "active",
  relations: { related_to: ["lead-scoring"] },
  body: "We will use PostHog for product analytics because it can self-host in the EU.\n\nRelated: [[lead-scoring]].",
} as const;

export const openaiReview = async (take: Take, context: Context): Promise<void> => {
  const vault = context.tenant.vaults.find((v) => v.slug === DEMO_VAULT.slug)!;
  await upsertConcepts(context.api, vault.id, [POSTHOG_DECISION]);

  await take.enter(`/v/${DEMO_VAULT.slug}`);
  // The cards are centred: the pointer waits in a corner, off the words.
  await take.moveTo({ x: 1480, y: 820 });

  // Shot 1: title card, on screen before the clock starts so the clip opens on it.
  await take.card(
    card({
      mark: true,
      eyebrow: "brownmatter.ai",
      heading: "Brainz for ChatGPT — review walkthrough",
      lines: ["A shared product-knowledge graph, connected over MCP."],
    }),
  );
  await take.begin();
  await take.pause(5000);

  // Shot 11: the decision in the Brainz graph, linked to lead scoring.
  await take.goto(`/v/${DEMO_VAULT.slug}`);
  await take.pause(3000);
  await take.type('input[aria-label="Search concepts"]', "PostHog");
  await take.click(take.page.locator('.results [role="option"]', { hasText: "PostHog" }));
  const panel = take.page.locator('aside[aria-label="Concept details"]');
  await take.waitFor(panel.getByText(POSTHOG_DECISION.title).first());
  await take.pause(2000);
  await take.click(panel.locator("button.edge-target", { hasText: "Lead Scoring" }).first());
  await take.pause(2400);
  await take.reveal(2000);

  // Shot 15: end card.
  await take.moveTo({ x: 1480, y: 820 });
  await take.card(
    card({
      mark: true,
      heading: "Thanks for reviewing Brainz",
      lines: [
        "Docs: brownmatter.ai/docs",
        "Support: support@brownmatter.ai",
        "Privacy: brownmatter.ai/privacy · Terms: brownmatter.ai/terms",
      ],
    }),
  );
  await take.pause(5000);
};
