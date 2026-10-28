/**
 * Dynamic client registration (RFC 7591, Wave OA). JSON in, 201 + client info
 * out. Unauthenticated, so: tight field caps (contracts), a durable limit
 * (REGISTER_RATE_LIMIT/hour per IPv4 address or IPv6 /48, plus a high global
 * backstop; Anthropic's and OpenAI's published egress exempt — they register
 * on every fresh connection), and a purge of idle grantless DCR clients, run
 * alongside each registration.
 */
import type { RequestHandler } from "@sveltejs/kit";
import { requirePlatform } from "$lib/server/api-util";
import { isProductionEnv } from "$lib/server/auth";
import {
  OAuthError,
  oauthJson,
  oauthPreflight,
  purgeUnusedClients,
  registerClient,
  registrationThrottled,
} from "$lib/server/oauth";
import { resolveRateLimitIp } from "$lib/server/rate-limit";

export const POST: RequestHandler = async (event) => {
  const platform = requirePlatform(event);
  const now = new Date();
  const clientIp = event.request.headers.get("cf-connecting-ip");
  // Fail closed without the edge header in production (shared helper); the
  // limiter itself buckets the raw address (IPv4, or IPv6 by /48) and exempts
  // directory egress.
  const ip = resolveRateLimitIp(clientIp, isProductionEnv(platform.env));
  if (!ip.ok || (await registrationThrottled(platform.env.DB, clientIp ?? ip.ip, now))) {
    return oauthJson(
      { error: "invalid_request", error_description: "too many client registrations from this address; retry later" },
      429,
      { "retry-after": "3600" },
    );
  }
  platform.context.waitUntil(purgeUnusedClients(platform.env.DB, now).catch(() => {}));
  let body: unknown;
  try {
    body = await event.request.json();
  } catch {
    return oauthJson({ error: "invalid_client_metadata", error_description: "body must be JSON" }, 400);
  }
  try {
    return oauthJson(await registerClient(platform.env.DB, body, now), 201, {
      "cache-control": "no-store",
    });
  } catch (err) {
    if (err instanceof OAuthError) return oauthJson(err.body(), err.status);
    console.error("oauth register error:", err);
    return oauthJson({ error: "server_error", error_description: "registration failed" }, 500);
  }
};

export const OPTIONS: RequestHandler = () => oauthPreflight();
