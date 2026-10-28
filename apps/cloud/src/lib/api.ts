/**
 * Typed fetch client over the REST API (src/routes/api/**). Every response is
 * parsed with its `@brainz/contracts` schema, so the UI can never silently
 * drift from the wire contract. Works both in the browser and in SvelteKit
 * `load` functions (pass the event's `fetch` so SSR forwards cookies).
 */
import type { z } from "zod";
import {
  accountDreamingSchema,
  apiConceptSchema,
  apiErrorSchema,
  apiKeyCreateResponseSchema,
  apiKeyListResponseSchema,
  conceptListResponseSchema,
  conceptTypeEntrySchema,
  conceptTypeListSchema,
  graphResponseSchema,
  searchResponseSchema,
  statsResponseSchema,
  taskListResponseSchema,
  taskMoveResponseSchema,
  inviteCreateResponseSchema,
  inviteListResponseSchema,
  publicEnableResponseSchema,
  publicStatusSchema,
  vaultListResponseSchema,
  memberListResponseSchema,
  vaultMemberSchema,
  vaultSchema,
  type AccountDreaming,
  type ApiConcept,
  type ApiKey,
  type ConceptTypeCreateRequest,
  type ConceptTypeEntry,
  type ConceptTypeUpdateRequest,
  type GraphPayload,
  type LlmKeyPutRequest,
  type PublicEnableResponse,
  type PublicStatus,
  type TaskMeta,
  type TaskMoveRequest,
  type Vault,
  type VaultInvite,
  type VaultMember,
  type VaultRole,
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
  /** A concept-type registry key (built-in or custom). An unknown/removed type
   * falls back to "concept" server-side (registry-based validation, Wave TR). */
  type?: string;
  status?: "active" | "draft" | "deprecated";
  product?: string;
  tags?: string[];
  codeAreas?: string[];
  taskStatus?: "open" | "taken" | "done";
  relations?: Record<string, string[]>;
}

export interface CreateTaskBody {
  title: string;
  body: string;
  domain?: string;
  realizes?: string[];
  governedBy?: string[];
  codeAreas?: string[];
  tags?: string[];
}

export interface VaultStats {
  concepts: number;
  edges: number;
  products: string[];
  tags: string[];
  byType: Record<string, number>;
  onboarded: boolean;
  openTasks: number;
  embeddings: "ready" | "unavailable" | "rate-limited";
  /** From the x-brainz-keyword-index response header. */
  keywordIndex: "fts5" | "like";
}

export type Task = TaskMeta;

/** POST create/resend invite response: the ONLY place the invite URL appears. */
export type InviteWithUrl = z.infer<typeof inviteCreateResponseSchema>;

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

    // ------------------------------------------------ concept-type registry
    async listTypes(vaultId: string): Promise<ConceptTypeEntry[]> {
      return (await request(conceptTypeListSchema, `/api/vaults/${enc(vaultId)}/types`)).types;
    },
    createType(vaultId: string, body: ConceptTypeCreateRequest): Promise<ConceptTypeEntry> {
      return request(conceptTypeEntrySchema, `/api/vaults/${enc(vaultId)}/types`, {
        method: "POST",
        body,
      });
    },
    updateType(
      vaultId: string,
      key: string,
      body: ConceptTypeUpdateRequest,
    ): Promise<ConceptTypeEntry> {
      return request(conceptTypeEntrySchema, `/api/vaults/${enc(vaultId)}/types/${enc(key)}`, {
        method: "PATCH",
        body,
      });
    },
    async deleteType(vaultId: string, key: string): Promise<void> {
      await expectNoContent(
        await fetchFn(`/api/vaults/${enc(vaultId)}/types/${enc(key)}`, { method: "DELETE" }),
      );
    },

    // --------------------------------------------------------------- tasks
    async listTasks(
      vaultId: string,
      filter: { taskStatus?: "open" | "taken" | "done"; domain?: string } = {},
    ): Promise<Task[]> {
      const params = new URLSearchParams();
      if (filter.taskStatus) params.set("taskStatus", filter.taskStatus);
      if (filter.domain) params.set("domain", filter.domain);
      const qs = params.toString();
      const path = `/api/vaults/${enc(vaultId)}/tasks${qs ? `?${qs}` : ""}`;
      return (await request(taskListResponseSchema, path)).tasks;
    },
    createTask(vaultId: string, body: CreateTaskBody): Promise<Task> {
      return request(taskMoveResponseSchema, `/api/vaults/${enc(vaultId)}/tasks`, {
        method: "POST",
        body,
      });
    },
    moveTask(vaultId: string, id: string, move: TaskMoveRequest): Promise<Task> {
      return request(taskMoveResponseSchema, `/api/vaults/${enc(vaultId)}/tasks/${enc(id)}`, {
        method: "PATCH",
        body: move,
      });
    },

    // ------------------------------------------------------------- members
    async listMembers(vaultId: string): Promise<VaultMember[]> {
      return (await request(memberListResponseSchema, `/api/vaults/${enc(vaultId)}/members`))
        .members;
    },
    updateMemberRole(vaultId: string, userId: string, role: VaultRole): Promise<VaultMember> {
      return request(vaultMemberSchema, `/api/vaults/${enc(vaultId)}/members/${enc(userId)}`, {
        method: "PATCH",
        body: { role },
      });
    },
    /** Remove a member — also the self-leave path (userId = the caller). */
    async removeMember(vaultId: string, userId: string): Promise<void> {
      await expectNoContent(
        await fetchFn(`/api/vaults/${enc(vaultId)}/members/${enc(userId)}`, { method: "DELETE" }),
      );
    },

    // ------------------------------------------------------------- invites
    async listInvites(vaultId: string): Promise<VaultInvite[]> {
      return (await request(inviteListResponseSchema, `/api/vaults/${enc(vaultId)}/invites`))
        .invites;
    },
    /** The returned `url` is shown exactly once — never listed again. */
    createInvite(vaultId: string, body: { email: string; role: VaultRole }): Promise<InviteWithUrl> {
      return request(inviteCreateResponseSchema, `/api/vaults/${enc(vaultId)}/invites`, {
        method: "POST",
        body,
      });
    },
    /** Re-send the invite email; returns a fresh one-time URL. */
    resendInvite(vaultId: string, inviteId: string): Promise<InviteWithUrl> {
      return request(
        inviteCreateResponseSchema,
        `/api/vaults/${enc(vaultId)}/invites/${enc(inviteId)}/resend`,
        { method: "POST" },
      );
    },
    async revokeInvite(vaultId: string, inviteId: string): Promise<void> {
      await expectNoContent(
        await fetchFn(`/api/vaults/${enc(vaultId)}/invites/${enc(inviteId)}`, {
          method: "DELETE",
        }),
      );
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

    // ---------------------------------------------- account dreaming / BYOK
    /** The caller's dream provider, key hint, today's spend vs cap, kill switch. */
    getAccountDreaming(): Promise<AccountDreaming> {
      return request(accountDreamingSchema, "/api/account/dreaming");
    },
    /** Set or replace the caller's dream LLM key (the plaintext is never returned). */
    setLlmKey(body: LlmKeyPutRequest): Promise<AccountDreaming> {
      return request(accountDreamingSchema, "/api/account/llm-key", { method: "PUT", body });
    },
    removeLlmKey(): Promise<AccountDreaming> {
      return request(accountDreamingSchema, "/api/account/llm-key", { method: "DELETE" });
    },

    // ------------------------------------------------------ public access
    /** Owner-only: current public-access status for this vault. */
    getPublicStatus(vaultId: string): Promise<PublicStatus> {
      return request(publicStatusSchema, `/api/vaults/${enc(vaultId)}/public`);
    },
    /** Enable public access — returns the one-time token + /public/<token> URL. */
    enablePublic(vaultId: string): Promise<PublicEnableResponse> {
      return request(publicEnableResponseSchema, `/api/vaults/${enc(vaultId)}/public`, {
        method: "POST",
      });
    },
    /** Rotate the token — old link dies; returns a fresh one-time token + URL. */
    rotatePublic(vaultId: string): Promise<PublicEnableResponse> {
      return request(publicEnableResponseSchema, `/api/vaults/${enc(vaultId)}/public/rotate`, {
        method: "POST",
      });
    },
    /** Disable public access (revoke the token). */
    async disablePublic(vaultId: string): Promise<void> {
      await expectNoContent(
        await fetchFn(`/api/vaults/${enc(vaultId)}/public`, { method: "DELETE" }),
      );
    },
  };
}

export type Api = ReturnType<typeof createApi>;

/**
 * Read-only client for the ANONYMOUS public-vault surface (public vaults).
 * Every path is `/api/public/<token>/…` — no session, no bearer, READ tools
 * only (graph/stats/search/context/concept). There is deliberately NO write,
 * members, keys, or invites method here: the public surface never exposes them.
 */
export function createPublicApi(fetchFn: Fetch, token: string) {
  const request = createRequest(fetchFn);
  const enc = encodeURIComponent;
  const base = `/api/public/${enc(token)}`;
  return {
    getConcept(id: string): Promise<ApiConcept> {
      return request(apiConceptSchema, `${base}/concepts/${enc(id)}`);
    },
    graph(): Promise<GraphPayload> {
      return request(graphResponseSchema, `${base}/graph`);
    },
    async search(q: string, limit = 8): Promise<SearchHit[]> {
      const path = `${base}/search?q=${enc(q)}&limit=${limit}`;
      return (await request(searchResponseSchema, path)).hits;
    },
    async stats(): Promise<VaultStats> {
      const path = `${base}/stats`;
      const res = await fetchFn(path);
      const stats = await parse(res, statsResponseSchema, path);
      const keywordIndex = res.headers.get("x-brainz-keyword-index") === "like" ? "like" : "fts5";
      return { ...stats, keywordIndex };
    },
  };
}

export type PublicApi = ReturnType<typeof createPublicApi>;

/** The caller's role on a vault (from GET /api/vaults); defaults to "owner"
 * so a response predating the membership rollout keeps today's behavior. */
export function roleOf(vault: Vault): VaultRole {
  return vault.role ?? "owner";
}

/** slug → vault. REST routes take the vault *id*; slugs only exist in URLs. */
export function vaultBySlug(vaults: Vault[], slug: string): Vault | null {
  return vaults.find((v) => v.slug === slug) ?? null;
}

/** Auto-slug for the create-vault form — same `slugify` the server applies. */
export function autoSlug(name: string): string {
  return slugify(name);
}
