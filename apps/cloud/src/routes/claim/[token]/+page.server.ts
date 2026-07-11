/**
 * /claim/[token] — the claim-approval page (Wave G). The ONLY consumer of the
 * emailed claim link: the human reviews what an agent provisioned (the email
 * being bound, vault name, API key name + prefix, workspace created date) and
 * approves or declines.
 *
 * Contract with the UI (+page.svelte is UI-agent-owned; do not deviate):
 * - load →
 *     { status: "valid", email, vaultName, keyName, keyPrefix,
 *       createdAt, expiresAt }            (createdAt/expiresAt ISO strings)
 *   | { status: "invalid" }
 * - action `approve` → on success redirect(303) to a server-minted magic-link
 *   verify URL that signs THIS browser in and lands on /dashboard (the URL
 *   never appears anywhere else); on failure fail(400, { error: string }).
 * - action `decline` → { declined: true } (idempotent; deletes the pending
 *   claim — the workspace then simply expires on schedule).
 *
 * Approval is atomic + single-use (see $lib/server/claim.approveClaim): it
 * binds the email, flips emailVerified, clears the owner's expiry, fixes the
 * placeholder name, stamps approved_at, and deletes other pending claims.
 */
import { fail, redirect } from "@sveltejs/kit";
import type { Actions, PageServerLoad } from "./$types";
import { requirePlatform } from "$lib/server/api-util";
import { approveClaim, claimDbFrom, declineClaim, validateClaimToken } from "$lib/server/claim";
import { createDb } from "$lib/server/db";
import { magicLinkMinter } from "$lib/server/magic-link";

export const load: PageServerLoad = async (event) => {
  const platform = requirePlatform(event);
  const db = claimDbFrom(createDb(platform.env.DB));
  const summary = await validateClaimToken(db, event.params.token, new Date());
  if (!summary) return { status: "invalid" as const };
  return {
    status: "valid" as const,
    email: summary.email,
    vaultName: summary.vaultName,
    keyName: summary.keyName,
    keyPrefix: summary.keyPrefix,
    createdAt: summary.createdAt.toISOString(),
    expiresAt: summary.expiresAt.toISOString(),
  };
};

export const actions: Actions = {
  approve: async (event) => {
    const platform = requirePlatform(event);
    const db = claimDbFrom(createDb(platform.env.DB));
    const result = await approveClaim(db, event.params.token, new Date());
    if (!result.ok) return fail(400, { error: result.message });
    // Sign the approving human straight in: mint a single-use verify URL
    // (short APPROVE_REDIRECT_TTL_SECONDS) and send THIS browser through it —
    // it lands on /dashboard with a session. The URL exists only as this
    // redirect Location.
    const mint = magicLinkMinter(platform.env, event.url.origin);
    const verifyUrl = await mint(result.email);
    redirect(303, verifyUrl);
  },
  decline: async (event) => {
    const platform = requirePlatform(event);
    const db = claimDbFrom(createDb(platform.env.DB));
    await declineClaim(db, event.params.token);
    return { declined: true as const };
  },
};
