/** `/.well-known/openai-apps-challenge`: the exact token as text/plain, or 404 when unset. */
import type { RequestEvent } from "@sveltejs/kit";
import { describe, expect, it } from "vitest";
import { GET } from "./+server.js";

const get = (env: Record<string, unknown> | undefined) =>
  GET({ platform: env ? { env } : undefined } as unknown as RequestEvent) as Promise<Response>;

describe("GET /.well-known/openai-apps-challenge", () => {
  it("returns exactly the configured token as text/plain, uncached", async () => {
    const res = await get({ OPENAI_APPS_CHALLENGE: "tok_abc123\n" });
    expect(res.status).toBe(200);
    expect(await res.text()).toBe("tok_abc123");
    expect(res.headers.get("content-type")).toBe("text/plain; charset=utf-8");
    expect(res.headers.get("cache-control")).toBe("no-store");
  });

  it("404s when the token is unset or blank", async () => {
    for (const env of [{}, { OPENAI_APPS_CHALLENGE: "" }, { OPENAI_APPS_CHALLENGE: "  " }, undefined]) {
      const res = await get(env);
      expect(res.status).toBe(404);
      expect(res.headers.get("cache-control")).toBe("no-store");
    }
  });
});
