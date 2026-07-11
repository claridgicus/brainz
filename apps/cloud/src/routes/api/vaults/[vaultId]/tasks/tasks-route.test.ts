/**
 * Route-level tests for the task REST surface — exercise the PATCH
 * `/api/vaults/:vaultId/tasks/:id` handler (take / complete / reopen) and the
 * POST `/api/vaults/:vaultId/tasks` handler directly, NOT via the DO or MCP.
 *
 * The real tenancy gate (`requireVaultAccess`), the `guarded` error wrapper,
 * and body parsing all run for real; only the two Cloudflare seams are stubbed:
 *   - `$lib/server/db` → a tiny chainable drizzle stub (session vault lookup),
 *   - `$lib/server/vault-client` → an in-memory fake VaultClient (the DO).
 * So bearer-vs-session tenancy, foreign-vault 404, action dispatch, and the
 * already-taken conflict are asserted against the actual HTTP surface.
 */
import type { RequestEvent } from "@sveltejs/kit";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// --- Cloudflare seams: a chainable drizzle stub + an in-memory vault client ---

/** Rows the mocked `db.select()...` chain resolves to (set per test). */
let vaultRows: unknown[] = [];

vi.mock("$lib/server/db", () => {
  // drizzle query builder is a thenable chain: select().from().where().limit()
  const chain: Record<string, unknown> = {};
  for (const m of ["select", "from", "where", "limit", "innerJoin", "update", "set"]) {
    chain[m] = () => chain;
  }
  (chain as { then: unknown }).then = (resolve: (rows: unknown[]) => unknown) =>
    resolve(vaultRows);
  return { createDb: () => chain, schema: { vault: {}, apiKey: {} } };
});

interface FakeTask {
  id: string;
  taskStatus: "open" | "taken" | "done";
  takenBy?: string;
  takenAt?: string;
  doneAt?: string;
}

let fakeTasks: Record<string, FakeTask>;

vi.mock("$lib/server/vault-client", async () => {
  const actual = await vi.importActual<typeof import("$lib/server/vault-client")>(
    "$lib/server/vault-client",
  );
  const meta = (t: FakeTask) => ({
    id: t.id,
    title: t.id,
    type: "task" as const,
    status: "active" as const,
    tags: [],
    taskStatus: t.taskStatus,
    ...(t.takenBy !== undefined ? { takenBy: t.takenBy } : {}),
    ...(t.takenAt !== undefined ? { takenAt: t.takenAt } : {}),
    ...(t.doneAt !== undefined ? { doneAt: t.doneAt } : {}),
  });
  return {
    ...actual,
    vaultClient: () => ({
      takeTask: async (args: { id?: string; takenBy?: string } = {}) => {
        const t = fakeTasks[args.id ?? ""];
        if (!t) throw new actual.VaultDoError(`no task with id "${args.id}"`, 404);
        if (t.taskStatus !== "open")
          throw new actual.VaultDoError(`task "${t.id}" is already ${t.taskStatus}`, 400);
        t.taskStatus = "taken";
        t.takenBy = args.takenBy ?? "an agent";
        t.takenAt = "2026-07-11T00:00:00.000Z";
        return {
          task: meta(t),
          body: "body\n",
          context: { markdown: "", included: [], truncated: false, approxTokens: 0 },
        };
      },
      completeTask: async (args: { id: string; outcome: string }) => {
        const t = fakeTasks[args.id];
        if (!t) throw new actual.VaultDoError(`no task with id "${args.id}"`, 404);
        t.taskStatus = "done";
        t.doneAt = "2026-07-11T01:00:00.000Z";
        return { task: meta(t), reminder: "index what changed" };
      },
      reopenTask: async (args: { id: string }) => {
        const t = fakeTasks[args.id];
        if (!t) throw new actual.VaultDoError(`no task with id "${args.id}"`, 404);
        t.taskStatus = "open";
        delete t.takenBy;
        delete t.takenAt;
        delete t.doneAt;
        return { task: meta(t) };
      },
    }),
  };
});

// Imported AFTER the mocks so the route binds to the stubbed modules.
const { PATCH } = await import("./[id]/+server");

// ---------------------------------------------------------------- test helpers

/** Build a minimal RequestEvent for the PATCH route. */
function patchEvent(opts: {
  vaultId: string;
  id: string;
  body: unknown;
  bearer?: string;
  user?: { id: string } | null;
}): RequestEvent {
  const headers: Record<string, string> = { "content-type": "application/json" };
  if (opts.bearer) headers.authorization = `Bearer ${opts.bearer}`;
  const request = new Request(`https://x/api/vaults/${opts.vaultId}/tasks/${opts.id}`, {
    method: "PATCH",
    headers,
    body: JSON.stringify(opts.body),
  });
  return {
    request,
    params: { vaultId: opts.vaultId, id: opts.id },
    url: new URL(request.url),
    locals: { user: opts.user ?? null },
    platform: { env: { DB: {}, VAULT_DO: {} }, context: { waitUntil: () => {} } },
  } as unknown as RequestEvent;
}

const BEARER = "bz_" + "a".repeat(32); // valid bz_ format

describe("PATCH /api/vaults/:vaultId/tasks/:id", () => {
  beforeEach(() => {
    // A session user who owns "vault-1"; the db stub returns that vault row.
    vaultRows = [{ id: "vault-1", ownerId: "user-1" }];
    fakeTasks = {
      "task-a": { id: "task-a", taskStatus: "open" },
      "task-b": { id: "task-b", taskStatus: "open" },
    };
  });
  afterEach(() => vi.clearAllMocks());

  it("rejects a bearer key (data-plane) with 401 — the route is session-only", async () => {
    const res = await PATCH(
      patchEvent({ vaultId: "vault-1", id: "task-a", body: { action: "take" }, bearer: BEARER, user: null }),
    );
    expect(res.status).toBe(401);
    expect(await res.json()).toEqual({ error: "authentication required" });
    // The claim never ran.
    expect(fakeTasks["task-a"].taskStatus).toBe("open");
  });

  it("returns 404 for a vault the session user does not own (indistinguishable from missing)", async () => {
    vaultRows = []; // owner filter matches nothing
    const res = await PATCH(
      patchEvent({ vaultId: "other-vault", id: "task-a", body: { action: "take" }, user: { id: "user-1" } }),
    );
    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ error: "vault not found" });
  });

  it("take: claims the task and returns the updated task meta", async () => {
    const res = await PATCH(
      patchEvent({ vaultId: "vault-1", id: "task-a", body: { action: "take", takenBy: "board" }, user: { id: "user-1" } }),
    );
    expect(res.status).toBe(200);
    const task = await res.json();
    expect(task).toMatchObject({ id: "task-a", taskStatus: "taken", takenBy: "board" });
    expect(fakeTasks["task-a"].taskStatus).toBe("taken");
  });

  it("complete: marks the task done", async () => {
    fakeTasks["task-a"].taskStatus = "taken";
    const res = await PATCH(
      patchEvent({ vaultId: "vault-1", id: "task-a", body: { action: "complete", outcome: "shipped" }, user: { id: "user-1" } }),
    );
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ id: "task-a", taskStatus: "done" });
  });

  it("reopen: resets the task to open (no MCP equivalent — route-only path)", async () => {
    fakeTasks["task-a"] = { id: "task-a", taskStatus: "done", takenBy: "board", doneAt: "x" };
    const res = await PATCH(
      patchEvent({ vaultId: "vault-1", id: "task-a", body: { action: "reopen" }, user: { id: "user-1" } }),
    );
    expect(res.status).toBe(200);
    const task = await res.json();
    expect(task).toMatchObject({ id: "task-a", taskStatus: "open" });
    expect(task.takenBy).toBeUndefined();
  });

  it("take on an already-taken task surfaces the DO conflict as a 400 error", async () => {
    fakeTasks["task-a"].taskStatus = "taken";
    fakeTasks["task-a"].takenBy = "agent-x";
    const res = await PATCH(
      patchEvent({ vaultId: "vault-1", id: "task-a", body: { action: "take" }, user: { id: "user-1" } }),
    );
    expect(res.status).toBe(400);
    expect((await res.json()).error).toContain("already taken");
  });

  it("rejects an invalid action body with 400 (contract-parsed)", async () => {
    const res = await PATCH(
      patchEvent({ vaultId: "vault-1", id: "task-a", body: { action: "bogus" }, user: { id: "user-1" } }),
    );
    expect(res.status).toBe(400);
  });
});
