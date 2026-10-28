/**
 * RFC 9728 protected-resource metadata for /mcp (Wave OA). Served here and at
 * the path-suffixed `/.well-known/oauth-protected-resource/mcp`, which clients
 * try first and which the /mcp 401 challenge points at.
 */
import type { RequestHandler } from "@sveltejs/kit";
import { issuerFor, oauthJson, oauthPreflight, protectedResourceMetadata } from "$lib/server/oauth";

export const GET: RequestHandler = ({ platform, url }) =>
  oauthJson(protectedResourceMetadata(issuerFor(platform?.env.BETTER_AUTH_URL, url.origin)));

export const OPTIONS: RequestHandler = () => oauthPreflight();
