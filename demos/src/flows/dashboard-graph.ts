/**
 * A vault's graph: from the dashboard into the seeded vault, the graph
 * settling, a search for the lead scoring spec, its details and links, a
 * hop along one of them, and the vault's task board.
 */
import type { Context } from "../manifest.js";
import type { Take } from "../take.js";
import { DEMO_VAULT } from "../tenant.js";

export const dashboardGraph = async (take: Take, _context: Context): Promise<void> => {
  await take.enter("/dashboard");
  await take.begin();
  await take.pause(1400);

  await take.click(`a.vault-link[href="/v/${DEMO_VAULT.slug}"]`);
  await take.waitFor('svg[aria-label="Concept graph"]');
  // The force layout settles on screen: real motion, so it plays at its own pace.
  await take.pause(3200);
  await take.reveal(1200);

  await take.type('input[aria-label="Search concepts"]', "lead scoring");
  await take.click(take.page.locator('.results [role="option"]', { hasText: "lead scoring model v2" }));
  const panel = take.page.locator('aside[aria-label="Concept details"]');
  await take.waitFor(panel.getByText("Spec: lead scoring model v2").first());
  await take.pause(1800);
  await take.scrollTo(panel.locator(".edges"));
  await take.pause(900);
  await take.reveal(1400);

  await take.click(panel.locator("button.edge-target").first());
  await take.pause(2200);
  await take.reveal(1400);

  await take.click(`a[href="/v/${DEMO_VAULT.slug}/board"]`);
  await take.waitFor('[role="group"][aria-label="Group by"]');
  await take.reveal(2600);
};
