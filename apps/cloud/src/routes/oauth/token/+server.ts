/**
 * OAuth 2.1 token endpoint (Wave OA): authorization_code + PKCE S256 and
 * rotating refresh tokens. Form-encoded per RFC 6749 §4.1.3 (JSON tolerated).
 * Exempt from the cross-site form check (hooks.server.ts) — it is called
 * server-to-server and authenticates the client itself.
 */
import type { RequestHandler } from "@sveltejs/kit";
import { requirePlatform } from "$lib/server/api-util";
import {
  handleTokenRequest,
  oauthJson,
  oauthPreflight,
  readOAuthForm,
  refreshGraceFromEnv,
} from "$lib/server/oauth";

export const POST: RequestHandler = async (event) => {
  const platform = requirePlatform(event);
  const result = await handleTokenRequest(
    {
      db: platform.env.DB,
      now: new Date(),
      fetchImpl: fetch,
      refreshGraceSeconds: refreshGraceFromEnv(platform.env.OAUTH_REFRESH_GRACE_SECONDS),
    },
    await readOAuthForm(event.request),
    event.request.headers.get("authorization"),
  );
  return oauthJson(result.body, result.status, result.headers);
};

export const OPTIONS: RequestHandler = () => oauthPreflight();
