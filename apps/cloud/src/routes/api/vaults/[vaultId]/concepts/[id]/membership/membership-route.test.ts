/**
 * POST /api/vaults/:vaultId/concepts/:id/membership — editor-gated, body
 * validated against conceptMembershipRequestSchema, DO errors mapped. Same
 * seams as tasks-route.test.ts (stubbed drizzle + in-memory vault client).
 */
import type { RequestEvent } from "@sveltejs/kit";
import { apiConceptSchema } from "@brainz/contracts";
import { describe, expect, it, vi } from "vitest";

let vaultRows: unknown[] = [];
let lastArgs: Record<string, unknown> | null = null;

vi.mock("$lib/server/db", () => {
  const chain: Record<string, unknown> = {};
  for (const m of ["select", "from", "where", "limit", "innerJoin", "update", "set"]) chain[m] = () => chain;
  (chain as { then: unknown }).then = (resolve: (rows: unknown[]) => unknown) => resolve(vaultRows);
  return {
    createDb: () => chain,
    schema: { vault: {}, apiKey: {}, vaultMember: { role: {}, vaultId: {}, userId: {} }, vaultInvite: {} },
  };
});

vi.mock("$lib/server/vault-client", async () => {
  const actual = await vi.importActual<typeof import("$lib/server/vault-client")>("$lib/server/vault-client");
  return {
    ...actual,
    vaultClient: () => ({
      setMembership: async (args: Record<string, unknown>) => {
        lastArgs = args;
        if (args.target === "ghost") throw new actual.VaultDoError('no concept with id "ghost"', 404);
        return {
          concept: { id: args.id, title: "T", type: "task", status: "active", tags: [], body: "b\n" },
        };
      },
    }),
  };
});

const { POST } = await import("./+server");

function postEvent(body: unknown, role: string): RequestEvent {
  vaultRows = [{ vault: { id: "vault-1", ownerId: "user-9" }, role }];
  const request = new Request("https://x/api/vaults/vault-1/concepts/t/membership", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  return {
    request,
    params: { vaultId: "vault-1", id: "t" },
    url: new URL(request.url),
    locals: { user: { id: "user-1" } },
    platform: { env: { DB: {}, VAULT_DO: {} }, context: { waitUntil: () => {} } },
  } as unknown as RequestEvent;
}

describe("POST /api/vaults/:vaultId/concepts/:id/membership", () => {
  it("lets an editor swap the container and returns the concept", async () => {
    const res = await POST(postEvent({ type: "iteration", target: "s2" }, "editor"));
    expect(res.status).toBe(200);
    expect(apiConceptSchema.safeParse(await res.json()).success).toBe(true);
    expect(lastArgs).toEqual({ id: "t", type: "iteration", target: "s2" });
  });

  it("refuses a viewer, a bad body and an unknown target", async () => {
    expect((await POST(postEvent({ type: "iteration", target: "s2" }, "viewer"))).status).toBe(403);
    expect((await POST(postEvent({ type: "iteration" }, "editor"))).status).toBe(400);
    expect((await POST(postEvent({ type: "iteration", target: "s2", relation: "depends_on" }, "editor"))).status).toBe(400);
    expect((await POST(postEvent({ type: "iteration", target: "ghost" }, "editor"))).status).toBe(404);
  });
});
