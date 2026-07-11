import { describe, expect, it } from "vitest";
import { ApiError, autoSlug, createApi, vaultBySlug, type Fetch } from "./api";

const jsonResponse = (status: number, body: unknown, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json", ...headers },
  });

function fetchStub(handler: (url: string, init?: RequestInit) => Response): Fetch {
  return (async (input: RequestInfo | URL, init?: RequestInit) =>
    handler(String(input), init)) as Fetch;
}

const vault = {
  id: "v-1",
  slug: "acme-crm",
  name: "Acme CRM",
  createdAt: "2026-07-10T00:00:00.000Z",
  role: "owner" as const,
};

describe("createApi", () => {
  it("parses a valid vault list with the contract schema", async () => {
    const api = createApi(fetchStub(() => jsonResponse(200, { vaults: [vault] })));
    expect(await api.listVaults()).toEqual([vault]);
  });

  it("surfaces server {error} bodies as ApiError with the status", async () => {
    const api = createApi(
      fetchStub(() => jsonResponse(409, { error: 'a vault with slug "acme-crm" already exists' })),
    );
    const err = await api.createVault({ name: "Acme CRM" }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ApiError);
    expect((err as ApiError).status).toBe(409);
    expect((err as ApiError).message).toContain("already exists");
  });

  it("rejects 2xx bodies that do not match the contract shape", async () => {
    const api = createApi(fetchStub(() => jsonResponse(200, { vaults: [{ id: 1 }] })));
    await expect(api.listVaults()).rejects.toThrow(/unexpected response shape/);
  });

  it("POSTs new concepts and PUTs existing ones", async () => {
    const calls: { url: string; method?: string }[] = [];
    const concept = {
      id: "lead-scoring",
      title: "Lead scoring",
      type: "feature",
      status: "active",
      tags: [],
      body: "…",
    };
    const api = createApi(
      fetchStub((url, init) => {
        calls.push({ url, method: init?.method });
        return jsonResponse(200, concept);
      }),
    );
    await api.upsertConcept("v-1", { title: "Lead scoring", body: "…" });
    await api.upsertConcept("v-1", { id: "lead-scoring", title: "Lead scoring", body: "…" });
    expect(calls[0]).toEqual({ url: "/api/vaults/v-1/concepts", method: "POST" });
    expect(calls[1]).toEqual({ url: "/api/vaults/v-1/concepts/lead-scoring", method: "PUT" });
  });

  it("reads the keyword-index mode from the stats response header", async () => {
    const stats = { concepts: 2, edges: 1, products: [], tags: [], byType: {}, onboarded: false, openTasks: 0, embeddings: "unavailable" };
    const api = createApi(
      fetchStub(() => jsonResponse(200, stats, { "x-brainz-keyword-index": "like" })),
    );
    const result = await api.stats("v-1");
    expect(result.embeddings).toBe("unavailable");
    expect(result.keywordIndex).toBe("like");
  });
});

describe("vaultBySlug", () => {
  it("maps a slug to its vault (REST wants the id)", () => {
    expect(vaultBySlug([vault], "acme-crm")?.id).toBe("v-1");
    expect(vaultBySlug([vault], "nope")).toBeNull();
  });
});

describe("autoSlug", () => {
  it("derives the same slug the server would", () => {
    expect(autoSlug("Acme CRM")).toBe("acme-crm");
    expect(autoSlug("  Weird -- Name!! ")).toBe(autoSlug("Weird -- Name!!"));
  });
});
