/**
 * /invite/[token] — the invite-accept page (Wave M). The consumer of the
 * emailed `/invite/<token>` link: the human sees what they were invited to
 * (vault, role, who invited them), signs in as the INVITED email if needed,
 * and accepts.
 *
 * Contract with the UI (+page.svelte is UI-agent-owned; do not deviate):
 * - load →
 *     { status: "valid", vaultName: string, role: string, email: string,
 *       invitedByName: string, expiresAt: string (ISO),
 *       signedInEmail: string | null, emailMismatch: boolean }
 *   | { status: "invalid" }
 *   `email` is the INVITED address; `signedInEmail` the session's (null when
 *   signed out); `emailMismatch` is true when both exist and differ
 *   (case-insensitively — the shared normalizeEmail choke-point).
 * - action `accept` — requires a session whose email matches the invite's;
 *   on success redirect(303) to `/v/<slug>`; on failure
 *   fail(401 | 403 | 410, { error: string }) (401 signed out, 403 mismatch,
 *   410 invalid/expired/used token).
 * - action `sendLink` — emails a magic sign-in link to the INVITE's address
 *   (never the form's — there is no form input) with a callbackURL returning
 *   to THIS page; returns { linkSent: true }; rate-limited through the
 *   durable magic-link guard → fail(429, { error }) when throttled.
 *
 * Acceptance itself is single-use + atomic (see $lib/server/invites).
 */
import { fail, redirect } from "@sveltejs/kit";
import type { Actions, PageServerLoad } from "./$types";
import { requirePlatform } from "$lib/server/api-util";
import { createDb } from "$lib/server/db";
import { normalizeEmail } from "$lib/server/email";
import { acceptInvite, inviteDbFrom, validateInviteToken } from "$lib/server/invites";
import { guardMagicLinkRequest } from "$lib/server/magic-link-guard";
import { magicLinkSender } from "$lib/server/magic-link";
import { isProductionEnv } from "$lib/server/auth";
import { resolveRateLimitIp } from "$lib/server/rate-limit";

export const load: PageServerLoad = async (event) => {
  const platform = requirePlatform(event);
  const db = inviteDbFrom(createDb(platform.env.DB));
  const summary = await validateInviteToken(db, event.params.token, new Date());
  if (!summary) return { status: "invalid" as const };
  const signedInEmail = event.locals.user?.email ?? null;
  return {
    status: "valid" as const,
    vaultName: summary.vault.name,
    role: summary.invite.role as string,
    email: summary.invite.email,
    invitedByName: summary.invite.invitedByName,
    expiresAt: summary.invite.expiresAt.toISOString(),
    signedInEmail,
    emailMismatch:
      signedInEmail !== null && normalizeEmail(signedInEmail) !== summary.invite.email,
  };
};

export const actions: Actions = {
  accept: async (event) => {
    const platform = requirePlatform(event);
    if (!event.locals.user) {
      return fail(401, { error: "sign in as the invited email to accept this invite" });
    }
    const db = inviteDbFrom(createDb(platform.env.DB));
    const result = await acceptInvite(
      db,
      {
        token: event.params.token,
        userId: event.locals.user.id,
        userEmail: event.locals.user.email,
      },
      new Date(),
    );
    if (!result.ok) {
      return fail(result.reason === "invalid" ? 410 : 403, { error: result.message });
    }
    redirect(303, `/v/${result.slug}`);
  },

  sendLink: async (event) => {
    const platform = requirePlatform(event);
    const db = inviteDbFrom(createDb(platform.env.DB));
    const summary = await validateInviteToken(db, event.params.token, new Date());
    if (!summary) {
      return fail(410, { error: "this invite link is invalid, expired, or already used" });
    }
    // This action sends email on an unauthenticated request, and (like the
    // /mcp public surface) it bypasses the hooks.server.ts guard — so apply
    // the SAME durable magic-link rate limit here, failing closed on a
    // missing client IP in production.
    const resolvedIp = resolveRateLimitIp(
      event.request.headers.get("cf-connecting-ip"),
      isProductionEnv(platform.env),
    );
    if (!resolvedIp.ok) {
      return fail(429, { error: "rate limited: missing client IP; retry through the edge" });
    }
    const { throttled } = await guardMagicLinkRequest(db.guard, {
      email: summary.invite.email,
      ip: resolvedIp.ip,
    });
    if (throttled) {
      return fail(429, {
        error: "too many sign-in emails for this address — wait a bit and try again",
      });
    }
    // The link goes to the INVITE's address only (never caller-controlled),
    // and brings the human straight back to this invite page.
    const send = magicLinkSender(platform.env, event.url.origin);
    await send(summary.invite.email, `/invite/${event.params.token}`);
    return { linkSent: true as const };
  },
};
