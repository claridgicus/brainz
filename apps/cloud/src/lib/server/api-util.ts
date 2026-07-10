/** Small helpers shared by the REST routes: JSON errors `{error}` + zod boundaries. */
import { json, type RequestEvent } from "@sveltejs/kit";
import type { z } from "zod";
import { VaultDoError } from "./vault-client";

export class HttpError extends Error {
  status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

export function apiError(status: number, message: string): Response {
  return json({ error: message }, { status });
}

/** Wrap a route handler: HttpError/VaultDoError → `{error}` with status; anything else → 500. */
export function guarded(
  fn: (event: RequestEvent) => Promise<Response>,
): (event: RequestEvent) => Promise<Response> {
  return async (event) => {
    try {
      return await fn(event);
    } catch (err) {
      if (err instanceof HttpError) return apiError(err.status, err.message);
      if (err instanceof VaultDoError) return apiError(err.status, err.message);
      console.error("api error:", err);
      return apiError(500, "internal error");
    }
  };
}

/** Parse a JSON request body against a contract schema (400 on failure). */
export async function parseBody<S extends z.ZodTypeAny>(
  event: RequestEvent,
  schema: S,
): Promise<z.infer<S>> {
  let raw: unknown;
  try {
    raw = await event.request.json();
  } catch {
    throw new HttpError(400, "invalid JSON body");
  }
  const parsed = schema.safeParse(raw);
  if (!parsed.success) {
    throw new HttpError(400, `invalid request: ${parsed.error.issues[0]?.message ?? "bad body"}`);
  }
  return parsed.data;
}

/** Parse URL search params against a contract schema (400 on failure). */
export function parseQuery<S extends z.ZodTypeAny>(event: RequestEvent, schema: S): z.infer<S> {
  const raw: Record<string, string> = {};
  for (const [k, v] of event.url.searchParams) raw[k] = v;
  const parsed = schema.safeParse(raw);
  if (!parsed.success) {
    throw new HttpError(400, `invalid query: ${parsed.error.issues[0]?.message ?? "bad params"}`);
  }
  return parsed.data;
}

/** The request's platform (absent only during prerender — treat as a 500). */
export function requirePlatform(event: RequestEvent): App.Platform {
  if (!event.platform?.env) throw new HttpError(500, "platform bindings unavailable");
  return event.platform;
}
