/** RFC 8414 authorization-server metadata for the Brainz OAuth 2.1 AS (Wave OA). */
import type { RequestHandler } from "@sveltejs/kit";
import { authorizationServerMetadata, issuerFor, oauthJson, oauthPreflight } from "$lib/server/oauth";

export const GET: RequestHandler = ({ platform, url }) =>
  oauthJson(authorizationServerMetadata(issuerFor(platform?.env.BETTER_AUTH_URL, url.origin)));

export const OPTIONS: RequestHandler = () => oauthPreflight();
