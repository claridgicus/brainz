/**
 * Connecting an AI app: the app registers itself (OAuth dynamic client
 * registration) and sends the person to Brainz's consent page, which names
 * the app, says what it may do and asks which vaults. Seven vaults put the
 * picker in search mode: search, pick two, allow — and the app's callback
 * receives the code.
 *
 * The app is a stand-in on a domain nobody owns (`agent.acme.example`). The
 * approval's 303 to it is taken from Brainz's real answer and the browser is
 * shown a plain "connected" page in the app's place (a route never sees a
 * redirect's target, so the approve POST itself is answered).
 */
import type { Context } from "../manifest.js";
import type { Take } from "../take.js";
import { card } from "./cards.js";

const CALLBACK = "https://agent.acme.example/oauth/callback";

const pkce = async () => {
  const verifier = `${crypto.randomUUID()}-${crypto.randomUUID()}`;
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier));
  return { verifier, challenge: Buffer.from(digest).toString("base64url") };
};

export const consentAndConnect = async (take: Take, context: Context): Promise<void> => {
  const registered = await fetch(`${context.origin}/oauth/register`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ client_name: "Acme Agent", redirect_uris: [CALLBACK], token_endpoint_auth_method: "none" }),
  });
  if (registered.status !== 201) throw new Error(`client registration failed (${registered.status}): ${await registered.text()}`);
  const { client_id } = (await registered.json()) as { client_id: string };
  const { challenge } = await pkce();
  const query = new URLSearchParams({
    response_type: "code",
    client_id,
    redirect_uri: CALLBACK,
    code_challenge: challenge,
    code_challenge_method: "S256",
    state: "demo",
    scope: "vault",
  });

  const callbacks: URL[] = [];
  await take.page.route(/\/oauth\/authorize\?\/approve/, async (route) => {
    const response = await route.fetch({ maxRedirects: 0 });
    const location = response.headers()["location"];
    if (location === undefined || !location.startsWith(CALLBACK)) {
      await route.fulfill({ response });
      return;
    }
    callbacks.push(new URL(location));
    await route.fulfill({
      contentType: "text/html",
      body: card({ eyebrow: "Acme Agent", heading: "Connected to Brainz", lines: ["Brainz demo and Mobile app are connected.", "You can close this tab."] }),
    });
  });

  await take.enter(`/oauth/authorize?${query}`);
  await take.begin();
  await take.pause(2200);

  // The list filters as the query lands: click a vault only once it is the one match left.
  const status = take.page.locator("#vault-picker-status");
  await take.type("#vault-search", "demo");
  await take.waitFor(status.getByText("1 of 7 vaults match"));
  await take.click('label.vault[data-slug="brainz-demo"]');
  await take.pause(500);
  await take.fill("#vault-search", "mobile");
  await take.waitFor(status.getByText("1 of 7 vaults match"));
  await take.click('label.vault[data-slug="mobile-app"]');
  await take.pause(500);
  // The page ticks the first vault for you; this app does not need it.
  await take.click('button[aria-label="Remove Billing platform"]');
  await take.pause(700);
  await take.reveal(1600);
  const chips = await take.page.locator('ul[aria-label="Selected vaults"] .chip span:first-child').allInnerTexts();
  if (chips.join(",") !== "Brainz demo,Mobile app") throw new Error(`picked ${chips.join(", ")} instead of Brainz demo and Mobile app`);

  await take.click(take.page.getByRole("button", { name: "Allow access" }));
  await take.waitFor(take.page.getByRole("heading", { name: "Connected to Brainz" }));
  await take.reveal(2400);

  const code = callbacks[0]?.searchParams.get("code");
  if (callbacks.length !== 1 || code === null || code === undefined) {
    throw new Error(`the app's callback should have received one code, got ${callbacks.map(String).join(", ") || "none"}`);
  }
};
