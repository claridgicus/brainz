/**
 * Typed fetch client over the REST API (src/routes/api/**). Every response is
 * parsed with its `@brainz/contracts` schema, so the UI can never silently
 * drift from the wire contract. Works both in the browser and in SvelteKit
 * `load` functions (pass the event's `fetch` so SSR forwards cookies).
 */
import type { z } from "zod";
import {
  apiConceptSchema,
  apiErrorSchema,
  apiKeyCreateResponseSchema,
  apiKeyListResponseSchema,
  conceptListResponseSchema,
  graphResponseSchema,
  searchResponseSchema,
  statsResponseSchema,
  vaultListResponseSchema,
  vaultSchema,
  type ApiConcept,
  type ApiKey,
  type GraphPayload,
  type Vault,
} from "@brainz/contracts";
import { slugify } from "@brainz/engine";

export type Fetch = typeof globalThis.fetch;

export class ApiError extends Error {
  status: number;
  constructor(message: string, status: number) {
    super(message);
    this.name = "ApiError";
    this.status = status;
  }
}

export interface UpsertConceptBody {
  id?: string;
  title: string;
  body: string;
  type?:
    | "concept"
    | "domain"
    | "feature"
    | "story"
    | "spec"
    | "workflow"
    | "decision"
    | "constraint"
    | "pattern"
    | "glossary";
  status?: "active" | "draft" | "deprecated";
  product?: string;
  tags?: string[];
  codeAreas?: string[];
  relations?: Record<string, string[]>;
}

export interface VaultStats {
  concepts: number;
  edges: number;
  products: string[];
  tags: string[];
  byType: Record<string, number>;
  onboarded: boolean;
  embeddings: "ready" | "unavailable";
  /** From the x-brainz-keyword-index response header. */
  keywordIndex: "fts5" | "like";
}

export type SearchHit = z.infer<typeof searchResponseSchema>["hits"][number];

/** Parse a response: non-2xx → ApiError with the server's `{error}` message;
 * 2xx bodies must parse with the contract schema. */
async function parse<T>(res: Response, schema: z.ZodType<T>, path: string): Promise<T> {
  let data: unknown = null;
  try {
    data = await res.json();
  } catch {
    /* empty / non-JSON body */
  }
  if (!res.ok) {
    const err = apiErrorSchema.safeParse(data);
    throw new ApiError(err.success ? err.data.error : `HTTP ${res.status}`, res.status);
  }
  const parsed = schema.safeParse(data);
  if (!parsed.success) {
    throw new ApiError(`unexpected response shape from ${path}`, res.status);
  }
  return parsed.data;
}

function createRequest(fetchFn: Fetch) {
  return async function request<T>(
    schema: z.ZodType<T>,
    path: string,
    init?: { method?: string; body?: unknown },
  ): Promise<T> {
    const res = await fetchFn(path, {
      method: init?.method ?? "GET",
      headers: init?.body !== undefined ? { "content-type": "application/json" } : undefined,
      body: init?.body !== undefined ? JSON.stringify(init.body) : undefined,
    });
    return parse(res, schema, path);
  };
}

async function expectNoContent(res: Response): Promise<void> {
  if (res.ok) return;
  let data: unknown = null;
  try {
    data = await res.json();
  } catch {
    /* ignore */
  }
  const err = apiErrorSchema.safeParse(data);
  throw new ApiError(err.success ? err.data.error : `HTTP ${res.status}`, res.status);
}

/** Build the typed client. Pass SvelteKit's `event.fetch` in load functions. */
export function createApi(fetchFn: Fetch) {
  const request = createRequest(fetchFn);
  const enc = encodeURIComponent;

  return {
    // ------------------------------------------------------------- vaults
    async listVaults(): Promise<Vault[]> {
      return (await request(vaultListResponseSchema, "/api/vaults")).vaults;
    },
    createVault(body: { name: string; slug?: string }): Promise<Vault> {
      return request(vaultSchema, "/api/vaults", { method: "POST", body });
    },
    updateVault(vaultId: string, body: { name?: string; slug?: string }): Promise<Vault> {
      return request(vaultSchema, `/api/vaults/${enc(vaultId)}`, { method: "PATCH", body });
    },
    async deleteVault(vaultId: string): Promise<void> {
      await expectNoContent(await fetchFn(`/api/vaults/${enc(vaultId)}`, { method: "DELETE" }));
    },

    // ----------------------------------------------------------- concepts
    async listConcepts(vaultId: string) {
      return request(conceptListResponseSchema, `/api/vaults/${enc(vaultId)}/concepts`);
    },
    getConcept(vaultId: string, id: string): Promise<ApiConcept> {
      return request(apiConceptSchema, `/api/vaults/${enc(vaultId)}/concepts/${enc(id)}`);
    },
    upsertConcept(vaultId: string, body: UpsertConceptBody): Promise<ApiConcept> {
      return body.id !== undefined
        ? request(apiConceptSchema, `/api/vaults/${enc(vaultId)}/concepts/${enc(body.id)}`, {
            method: "PUT",
            body,
          })
        : request(apiConceptSchema, `/api/vaults/${enc(vaultId)}/concepts`, {
            method: "POST",
            body,
          });
    },
    async deleteConcept(vaultId: string, id: string): Promise<void> {
      await expectNoContent(
        await fetchFn(`/api/vaults/${enc(vaultId)}/concepts/${enc(id)}`, { method: "DELETE" }),
      );
    },

    // -------------------------------------------------- graph/search/stats
    graph(vaultId: string): Promise<GraphPayload> {
      return request(graphResponseSchema, `/api/vaults/${enc(vaultId)}/graph`);
    },
    async search(vaultId: string, q: string, limit = 8): Promise<SearchHit[]> {
      const path = `/api/vaults/${enc(vaultId)}/search?q=${enc(q)}&limit=${limit}`;
      return (await request(searchResponseSchema, path)).hits;
    },
    async stats(vaultId: string): Promise<VaultStats> {
      const path = `/api/vaults/${enc(vaultId)}/stats`;
      const res = await fetchFn(path);
      const stats = await parse(res, statsResponseSchema, path);
      const keywordIndex = res.headers.get("x-brainz-keyword-index") === "like" ? "like" : "fts5";
      return { ...stats, keywordIndex };
    },

    // ------------------------------------------------------------ api keys
    async listKeys(vaultId: string): Promise<ApiKey[]> {
      return (await request(apiKeyListResponseSchema, `/api/vaults/${enc(vaultId)}/keys`)).keys;
    },
    createKey(vaultId: string, name: string) {
      return request(apiKeyCreateResponseSchema, `/api/vaults/${enc(vaultId)}/keys`, {
        method: "POST",
        body: { name },
      });
    },
    async revokeKey(keyId: string): Promise<void> {
      await expectNoContent(await fetchFn(`/api/keys/${enc(keyId)}`, { method: "DELETE" }));
    },
  };
}

export type Api = ReturnType<typeof createApi>;

/** slug → vault. REST routes take the vault *id*; slugs only exist in URLs. */
export function vaultBySlug(vaults: Vault[], slug: string): Vault | null {
  return vaults.find((v) => v.slug === slug) ?? null;
}

/** Auto-slug for the create-vault form — same `slugify` the server applies. */
export function autoSlug(name: string): string {
  return slugify(name);
}
