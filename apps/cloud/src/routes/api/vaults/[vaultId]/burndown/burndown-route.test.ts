/**
 * Route-level test for GET /api/vaults/:vaultId/burndown: the real tenancy
 * gate, query parsing (burndownQuerySchema) and the `guarded` error mapping,
 * over a stubbed drizzle + in-memory vault client (same seams as
 * tasks-route.test.ts). The body must parse with the contract schema.
 */
import type { RequestEvent } from "@sveltejs/kit";
import { burndownResponseSchema } from "@brainz/contracts";
import { beforeEach, describe, expect, it, vi } from "vitest";

let vaultRows: unknown[] = [];
let lastQuery: Record<string, unknown> | null = null;

vi.mock("$lib/server/db", () => {
  const chain: Record<string, unknown> = {};
  for (const m of ["select", "from", "where", "limit", "innerJoin", "update", "set"]) {
    chain[m] = () => chain;
  }
  (chain as { then: unknown }).then = (resolve: (rows: unknown[]) => unknown) => resolve(vaultRows);
  return {
    createDb: () => chain,
    schema: { vault: {}, apiKey: {}, vaultMember: { role: {}, vaultId: {}, userId: {} }, vaultInvite: {} },
  };
});

vi.mock("$lib/server/vault-client", async () => {
  const actual = await vi.importActual<typeof import("$lib/server/vault-client")>(
    "$lib/server/vault-client",
  );
  return {
    ...actual,
    vaultClient: () => ({
      burndown: async (q: Record<string, unknown>) => {
        lastQuery = q;
        if (q.scope === "ghost") throw new actual.VaultDoError('unknown burndown scope: "ghost"', 404);
        return {
          scope: { id: (q.scope as string) ?? null, kind: q.scope ? "concept" : "vault", title: "S" },
          window: {
            from: "2026-11-01T00:00:00.000Z",
            to: "2026-11-08T00:00:00.000Z",
            now: "2026-11-03T00:00:00.000Z",
            bucket: "day",
            unit: (q.unit as string) ?? "tasks",
          },
          totals: { scope: 1, done: 0, open: 1, taken: 0, unestimated: 1 },
        };
      },
    }),
  };
});

const { GET } = await import("./+server");

function getEvent(qs: string, role = "viewer"): RequestEvent {
  vaultRows = [{ vault: { id: "vault-1", ownerId: "user-9" }, role }];
  const request = new Request(`https://x/api/vaults/vault-1/burndown${qs}`);
  return {
    request,
    params: { vaultId: "vault-1" },
    url: new URL(request.url),
    locals: { user: { id: "user-1" } },
    platform: { env: { DB: {}, VAULT_DO: {} }, context: { waitUntil: () => {} } },
  } as unknown as RequestEvent;
}

describe("GET /api/vaults/:vaultId/burndown", () => {
  beforeEach(() => {
    lastQuery = null;
  });

  it("lets a viewer read it and parses the query (metrics comma-separated)", async () => {
    const res = await GET(getEvent("?scope=s1&unit=points&staleAfterHours=12&metrics=series,stale"));
    expect(res.status).toBe(200);
    expect(burndownResponseSchema.safeParse(await res.json()).success).toBe(true);
    expect(lastQuery).toEqual({ scope: "s1", unit: "points", staleAfterHours: 12, metrics: ["series", "stale"] });
  });

  it("rejects a bad query with 400 and maps an unknown scope to 404", async () => {
    expect((await GET(getEvent("?unit=hours"))).status).toBe(400);
    expect((await GET(getEvent("?metrics=series,bogus"))).status).toBe(400);
    expect((await GET(getEvent("?from=yesterday"))).status).toBe(400);
    expect((await GET(getEvent("?scope=ghost"))).status).toBe(404);
  });

  it("hides another tenant's vault (no membership row → 404)", async () => {
    const ev = getEvent("");
    vaultRows = [];
    expect((await GET(ev)).status).toBe(404);
  });
});
