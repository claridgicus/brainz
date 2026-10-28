/**
 * Remote MCP — the DIRECTORY endpoint: https://brainz.brownmatter.ai/mcp
 *
 * OAuth 2.1 + lazy auth for Claude / ChatGPT directory clients, plus `bz_`
 * keys and public-vault tokens. Hands out no API keys: agent self-signup lives
 * on `/mcp/agent`. The handler and the full auth split are in
 * $lib/server/mcp-endpoint.
 *
 * Client wiring:
 *   claude mcp add --transport http brainz https://brainz.brownmatter.ai/mcp
 *     (OAuth sign-in on first gated call), or with a key:
 *   claude mcp add --transport http brainz https://brainz.brownmatter.ai/mcp \
 *     --header "Authorization: Bearer bz_..."
 */
import type { RequestHandler } from "@sveltejs/kit";
import { handleMcpRequest } from "$lib/server/mcp-endpoint";

const handleMcp: RequestHandler = (event) => handleMcpRequest(event, "directory");

export const POST = handleMcp;
export const GET = handleMcp;
export const DELETE = handleMcp;
