/** RFC 7009 token revocation (Wave OA): revokes the token's whole grant. */
import type { RequestHandler } from "@sveltejs/kit";
import { requirePlatform } from "$lib/server/api-util";
import { handleRevokeRequest, oauthJson, oauthPreflight, readOAuthForm } from "$lib/server/oauth";

export const POST: RequestHandler = async (event) => {
  const platform = requirePlatform(event);
  const result = await handleRevokeRequest(
    { db: platform.env.DB, now: new Date(), fetchImpl: fetch },
    await readOAuthForm(event.request),
    event.request.headers.get("authorization"),
  );
  return oauthJson(result.body, result.status, result.headers);
};

export const OPTIONS: RequestHandler = () => oauthPreflight();
