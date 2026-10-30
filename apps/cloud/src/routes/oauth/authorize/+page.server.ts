/**
 * /oauth/authorize — the OAuth 2.1 consent page (Wave OA, SPEC-CLOUD.md "OAuth
 * 2.1 for remote MCP").
 *
 * load:
 * - validates the authorization request ($lib/server/oauth). ANY invalid
 *   request renders `{status: "error"}` and NEVER redirects: anyone can
 *   register a client with their own redirect URI, so bouncing errors from a
 *   GET would be an open redirector (RFC 9700 §4.11.2). Errors only go back to
 *   the client from the consent actions, after the user signed in and acted.
 * - no session → 303 to /login?next=<this URL>; every login method returns here.
 * - else `{status: "consent", client, redirectHost, loopback, vaults, params}`:
 *   the vault picker lists the user's member vaults with their role, as
 *   checkboxes plus "All my vaults, including ones I create or join later"
 *   (multi-vault grants, SPEC-CLOUD.md "Multi-vault grants"). With more
 *   than 5 vaults the page adds search-and-select on top of the same
 *   checkboxes (progressive enhancement).
 *
 * actions (same-origin form POSTs; the request params ride hidden inputs):
 * - approve: re-validate, check membership on every ticked vault (`vault_id`,
 *   repeatable) or take `all_vaults=on`, mint a single-use code, 303 to
 *   `redirect_uri?code&state&iss`. Idempotent per authorize request: a
 *   duplicate approve gets the same code back (409 once it was exchanged).
 * - createVault ("+ New vault"): create a vault owned by the user (shared
 *   $lib/server/vaults code path, same slug rules as POST /api/vaults), then
 *   303 back here with `tick=<new id>` (plus the earlier ticks) so it is
 *   pre-ticked. Mints no code.
 * - deny: 303 to `redirect_uri?error=access_denied&state&iss`.
 */
import { fail, redirect } from "@sveltejs/kit";
import { vaultCreateRequestSchema, type VaultRole } from "@brainz/contracts";
import { asc, eq } from "drizzle-orm";
import type { Actions, PageServerLoad, RequestEvent } from "./$types";
import { HttpError, requirePlatform } from "$lib/server/api-util";
import { createDb, schema } from "$lib/server/db";
import { resolveSecret } from "$lib/server/auth";
import {
  AuthorizationAlreadyExchangedError,
  buildRedirect,
  createAuthorizationCode,
  isLoopbackHttp,
  issuerFor,
  touchClient,
  validateAuthorizeRequest,
  type AuthorizeValidation,
} from "$lib/server/oauth";
import { createVault } from "$lib/server/vaults";

/** Vault ids to pre-tick on the consent page (set by the "+ New vault" redirect). */
const TICK_PARAM = "tick";

/** The authorization-request params carried through the consent form. */
const PARAM_NAMES = [
  "response_type",
  "client_id",
  "redirect_uri",
  "code_challenge",
  "code_challenge_method",
  "state",
  "scope",
  "resource",
] as const;

async function validate(event: RequestEvent, params: URLSearchParams): Promise<AuthorizeValidation> {
  const platform = requirePlatform(event);
  return validateAuthorizeRequest(
    platform.env.DB,
    params,
    issuerFor(platform.env.BETTER_AUTH_URL, event.url.origin),
    fetch,
  );
}

/** The user's member vaults with their slug and role, by name (the consent picker's rows). */
async function memberVaultsOf(d1: App.Platform["env"]["DB"], userId: string) {
  const rows = await createDb(d1)
    .select({ id: schema.vault.id, name: schema.vault.name, slug: schema.vault.slug, role: schema.vaultMember.role })
    .from(schema.vaultMember)
    .innerJoin(schema.vault, eq(schema.vaultMember.vaultId, schema.vault.id))
    .where(eq(schema.vaultMember.userId, userId))
    .orderBy(asc(schema.vault.name));
  return rows.map((v) => ({ id: v.id, name: v.name, slug: v.slug, role: v.role as VaultRole }));
}

export const load: PageServerLoad = async (event) => {
  const result = await validate(event, event.url.searchParams);
  if (!result.ok) {
    return {
      status: "error" as const,
      message: result.fatal ? result.message : bouncedErrorMessage(result.redirectTo),
    };
  }

  if (!event.locals.user) {
    redirect(303, `/login?next=${encodeURIComponent(event.url.pathname + event.url.search)}`);
  }

  const { request } = result;
  const platform = requirePlatform(event);
  // Keep a DCR client that's still in use out of the 30-day idle purge.
  if (request.client.kind === "dcr") {
    platform.context.waitUntil(touchClient(platform.env.DB, request.client.clientId, new Date()).catch(() => {}));
  }
  const vaults = await memberVaultsOf(platform.env.DB, event.locals.user.id);

  const params: Record<string, string> = {};
  for (const name of PARAM_NAMES) {
    const v = event.url.searchParams.get(name);
    if (v !== null) params[name] = v;
  }
  // Pre-ticked vaults: `tick` (repeatable) after "+ New vault" carries the new
  // vault plus the earlier selection; else the first vault. Only member vaults.
  const ticks = new Set(event.url.searchParams.getAll(TICK_PARAM));
  const preTicked = vaults.filter((v) => ticks.has(v.id)).map((v) => v.id);
  const redirect_ = new URL(request.redirectUri);
  return {
    status: "consent" as const,
    preTicked: preTicked.length > 0 ? preTicked : vaults.slice(0, 1).map((v) => v.id),
    client: {
      name: request.client.displayName,
      selfAsserted: request.client.selfAsserted,
      // A client-ID metadata document: `name` is the URL's host. Claude Code
      // uses claude.ai's document with a loopback redirect, so "claude.ai" +
      // localhost means a program on this computer, not the claude.ai website.
      metadataDocument: request.client.kind !== "dcr",
    },
    redirectHost: redirect_.host,
    loopback: isLoopbackHttp(redirect_),
    userEmail: event.locals.user.email,
    vaults,
    params,
  };
};

/** The human-readable reason carried by a would-be error redirect. */
function bouncedErrorMessage(redirectTo: string): string {
  const params = new URL(redirectTo).searchParams;
  return `The app sent an invalid request (${params.get("error")}: ${params.get("error_description") ?? "no detail"}).`;
}

/** Rebuild the authorization request from the consent form's hidden inputs. */
function paramsFrom(form: FormData): URLSearchParams {
  const params = new URLSearchParams();
  for (const name of PARAM_NAMES) {
    const v = form.get(name);
    if (typeof v === "string") params.set(name, v);
  }
  return params;
}

export const actions: Actions = {
  approve: async (event) => {
    const form = await event.request.formData();
    const result = await validate(event, paramsFrom(form));
    if (!result.ok && result.fatal) return fail(400, { error: result.message });
    if (!result.ok) redirect(303, result.redirectTo);
    const user = event.locals.user;
    if (!user) return fail(401, { error: "Your session ended. Sign in again and retry." });

    // Multi-vault grants: the ticked vaults (each re-checked for membership),
    // or "all my vaults, including ones I create or join later".
    const platform = requirePlatform(event);
    const all = form.get("all_vaults") === "on";
    const ticked = [...new Set(form.getAll("vault_id").filter((v): v is string => typeof v === "string"))];
    const memberVaults = await memberVaultsOf(platform.env.DB, user.id);
    const memberIds = new Set(memberVaults.map((v) => v.id));
    if (ticked.some((id) => !memberIds.has(id))) {
      return fail(400, { error: "Pick from your own vaults." });
    }
    // "All" still anchors on a ticked vault when there is one.
    const anchorVaultId = ticked[0] ?? (all ? memberVaults[0]?.id : undefined);
    if (!anchorVaultId) return fail(400, { error: "Pick at least one vault." });
    const { request } = result;
    // Idempotent per authorize request: a double click or resubmit gets the
    // same code (with the latest selection), never a second one.
    let code: string;
    try {
      code = await createAuthorizationCode(platform.env.DB, {
        request,
        userId: user.id,
        selection: { all, vaultIds: all ? [] : ticked },
        anchorVaultId,
        now: new Date(),
        secret: resolveSecret(platform.env),
      });
    } catch (err) {
      if (err instanceof AuthorizationAlreadyExchangedError) return fail(409, { error: err.message });
      throw err;
    }
    redirect(
      303,
      buildRedirect(request.redirectUri, {
        code,
        state: request.state,
        iss: issuerFor(platform.env.BETTER_AUTH_URL, event.url.origin),
      }),
    );
  },
  // "+ New vault" (SPEC-CLOUD.md "Multi-vault grants"): create a vault the
  // same way POST /api/vaults does (owner = the session user), then 303 back
  // to this consent page with it pre-ticked. It never mints a code: the user
  // still has to Approve. A named form action, so hooks.server.ts's CSRF
  // re-check applies.
  createVault: async (event) => {
    const form = await event.request.formData();
    const params = paramsFrom(form);
    const result = await validate(event, params);
    if (!result.ok && result.fatal) return fail(400, { error: result.message });
    if (!result.ok) redirect(303, result.redirectTo);
    const user = event.locals.user;
    if (!user) return fail(401, { error: "Your session ended. Sign in again and retry." });
    const parsed = vaultCreateRequestSchema.safeParse({ name: String(form.get("name") ?? "").trim() });
    if (!parsed.success) return fail(400, { createError: "Give the new vault a name." });
    let vaultId: string;
    try {
      vaultId = (await createVault(createDb(requirePlatform(event).env.DB), user.id, parsed.data)).id;
    } catch (err) {
      if (err instanceof HttpError) return fail(err.status, { createError: err.message });
      throw err;
    }
    // Back to consent: the new vault plus whatever was ticked before.
    for (const id of new Set([vaultId, ...form.getAll(TICK_PARAM).filter((v): v is string => typeof v === "string")])) {
      params.append(TICK_PARAM, id);
    }
    redirect(303, `${event.url.pathname}?${params}`);
  },
  deny: async (event) => {
    const form = await event.request.formData();
    const result = await validate(event, paramsFrom(form));
    if (!result.ok && result.fatal) return fail(400, { error: result.message });
    if (!result.ok) redirect(303, result.redirectTo);
    const platform = requirePlatform(event);
    redirect(
      303,
      buildRedirect(result.request.redirectUri, {
        error: "access_denied",
        error_description: "the user declined",
        state: result.request.state,
        iss: issuerFor(platform.env.BETTER_AUTH_URL, event.url.origin),
      }),
    );
  },
};

