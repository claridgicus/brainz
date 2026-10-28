/**
 * Dynamic client registration (RFC 7591, Wave OA). JSON in, 201 + client info
 * out. Not IP-rate-limited: Claude registers from one shared egress range on
 * every fresh connection; the request schema caps field sizes instead.
 */
import type { RequestHandler } from "@sveltejs/kit";
import { requirePlatform } from "$lib/server/api-util";
import { OAuthError, oauthJson, oauthPreflight, registerClient } from "$lib/server/oauth";

export const POST: RequestHandler = async (event) => {
  const platform = requirePlatform(event);
  let body: unknown;
  try {
    body = await event.request.json();
  } catch {
    return oauthJson({ error: "invalid_client_metadata", error_description: "body must be JSON" }, 400);
  }
  try {
    return oauthJson(await registerClient(platform.env.DB, body, new Date()), 201, {
      "cache-control": "no-store",
    });
  } catch (err) {
    if (err instanceof OAuthError) return oauthJson(err.body(), err.status);
    console.error("oauth register error:", err);
    return oauthJson({ error: "server_error", error_description: "registration failed" }, 500);
  }
};

export const OPTIONS: RequestHandler = () => oauthPreflight();
