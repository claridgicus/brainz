/**
 * OpenAI plugin-portal domain verification: the portal shows a challenge token
 * at connect time and fetches it back from here. The body must be exactly the
 * token as plain text (no JSON, no trailing newline). The token is config
 * (`wrangler secret put OPENAI_APPS_CHALLENGE`), never hard-coded; unset → 404.
 */
import type { RequestHandler } from "@sveltejs/kit";

export const GET: RequestHandler = ({ platform }) => {
  const token = platform?.env.OPENAI_APPS_CHALLENGE?.trim();
  if (!token) {
    return new Response("Not Found", {
      status: 404,
      headers: { "content-type": "text/plain; charset=utf-8", "cache-control": "no-store" },
    });
  }
  return new Response(token, {
    headers: { "content-type": "text/plain; charset=utf-8", "cache-control": "no-store" },
  });
};
