/**
 * Remote MCP — the AGENT endpoint: https://brainz.brownmatter.ai/mcp/agent
 * (AGENT_MCP_PATH in @brainz/contracts).
 *
 * Unauthenticated callers get the public `signup` / `sign_in` tools (agent
 * self-signup, Wave G); `bz_` keys and public-vault tokens work exactly as on
 * `/mcp`. OAuth access tokens are for `/mcp` only. See
 * $lib/server/mcp-endpoint.
 */
import type { RequestHandler } from "@sveltejs/kit";
import { handleMcpRequest } from "$lib/server/mcp-endpoint";

const handleMcp: RequestHandler = (event) => handleMcpRequest(event, "agent");

export const POST = handleMcp;
export const GET = handleMcp;
export const DELETE = handleMcp;
