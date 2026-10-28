/**
 * /oauth/authorize — the OAuth 2.1 consent page (Wave OA, SPEC-CLOUD.md "OAuth
 * 2.1 for remote MCP").
 *
 * load:
 * - validates the authorization request ($lib/server/oauth). An unknown client
 *   or unregistered redirect renders `{status: "error"}` and NEVER redirects;
 *   other request errors bounce back to the client's redirect URI.
 * - no session → 303 to /login?next=<this URL>; every login method returns here.
 * - else `{status: "consent", client, redirectHost, loopback, vaults, params}`:
 *   the vault picker lists the user's member vaults with their role.
 *
 * actions (same-origin form POSTs; the request params ride hidden inputs):
 * - approve: re-validate, check membership on the picked vault, mint a
 *   single-use code, 303 to `redirect_uri?code&state&iss`.
 * - deny: 303 to `redirect_uri?error=access_denied&state&iss`.
 */
import { fail, redirect } from "@sveltejs/kit";
import type { VaultRole } from "@brainz/contracts";
import { asc, eq } from "drizzle-orm";
import type { Actions, PageServerLoad, RequestEvent } from "./$types";
import { requirePlatform } from "$lib/server/api-util";
import { createDb, schema } from "$lib/server/db";
import {
  buildRedirect,
  createAuthorizationCode,
  isLoopbackHttp,
  issuerFor,
  validateAuthorizeRequest,
  type AuthorizeValidation,
} from "$lib/server/oauth";
import { memberRole } from "$lib/server/vault-access";

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

export const load: PageServerLoad = async (event) => {
  const result = await validate(event, event.url.searchParams);
  if (!result.ok && result.fatal) return { status: "error" as const, message: result.message };
  if (!result.ok) redirect(303, result.redirectTo);

  if (!event.locals.user) {
    redirect(303, `/login?next=${encodeURIComponent(event.url.pathname + event.url.search)}`);
  }

  const { request } = result;
  const db = createDb(requirePlatform(event).env.DB);
  const vaults = await db
    .select({ id: schema.vault.id, name: schema.vault.name, role: schema.vaultMember.role })
    .from(schema.vaultMember)
    .innerJoin(schema.vault, eq(schema.vaultMember.vaultId, schema.vault.id))
    .where(eq(schema.vaultMember.userId, event.locals.user.id))
    .orderBy(asc(schema.vault.name));

  const params: Record<string, string> = {};
  for (const name of PARAM_NAMES) {
    const v = event.url.searchParams.get(name);
    if (v !== null) params[name] = v;
  }
  const redirect_ = new URL(request.redirectUri);
  return {
    status: "consent" as const,
    client: {
      name: request.client.displayName,
      selfAsserted: request.client.selfAsserted,
    },
    redirectHost: redirect_.host,
    loopback: isLoopbackHttp(redirect_),
    userEmail: event.locals.user.email,
    vaults: vaults.map((v) => ({ id: v.id, name: v.name, role: v.role as VaultRole })),
    params,
  };
};

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

    const vaultId = form.get("vault_id");
    const platform = requirePlatform(event);
    if (typeof vaultId !== "string" || !(await memberRole(createDb(platform.env.DB), vaultId, user.id))) {
      return fail(400, { error: "Pick one of your vaults." });
    }
    const { request } = result;
    const code = await createAuthorizationCode(platform.env.DB, {
      request,
      userId: user.id,
      vaultId,
      now: new Date(),
    });
    redirect(
      303,
      buildRedirect(request.redirectUri, {
        code,
        state: request.state,
        iss: issuerFor(platform.env.BETTER_AUTH_URL, event.url.origin),
      }),
    );
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

