/**
 * Typed client over a vault's Durable Object stub (fetch router — see
 * vault-do.ts for why fetch instead of RPC). This is the ONLY way Worker
 * code talks to vault content.
 */
import type { DurableObjectNamespace } from "@cloudflare/workers-types";
import type { ConceptType, TaskStatus, UpsertInput } from "@brainz/engine";
import type {
  ContextArgs,
  RelatedArgs,
  SearchArgs,
  WireConcept,
  WireHit,
  WireNeighbor,
  WireRelated,
} from "./vault-do";
import type { GraphPayload, ToolConceptMeta } from "@brainz/contracts";

export class VaultDoError extends Error {
  status: number;
  constructor(message: string, status: number) {
    super(message);
    this.status = status;
  }
}

export interface VaultStatsResult {
  concepts: number;
  edges: number;
  products: string[];
  tags: string[];
  byType: Record<string, number>;
  onboarded: boolean;
  openTasks: number;
  embeddings: "ready" | "unavailable" | "rate-limited";
  keywordIndex: "fts5" | "like";
}

export interface TakeTaskResult {
  task: ToolConceptMeta & { createdAt?: string; updatedAt?: string };
  body: string;
  context: {
    markdown: string;
    included: string[];
    truncated: boolean;
    approxTokens: number;
  };
}

export interface CompleteTaskResult {
  task: ToolConceptMeta & { createdAt?: string; updatedAt?: string };
  reminder: string;
}

export interface VaultClient {
  upsertConcept(input: UpsertInput): Promise<{ concept: WireConcept }>;
  deleteConcept(id: string): Promise<{ ok: true; deleted: boolean }>;
  getConcept(id: string): Promise<{ concept: (WireConcept & { neighbors: WireNeighbor[] }) | null }>;
  list(filter?: { product?: string; type?: ConceptType; tag?: string }): Promise<{
    count: number;
    concepts: ToolConceptMeta[];
  }>;
  listTasks(filter?: { taskStatus?: TaskStatus; domain?: string }): Promise<{
    count: number;
    tasks: (ToolConceptMeta & { createdAt?: string; updatedAt?: string; staleClaim?: boolean })[];
  }>;
  takeTask(args?: { id?: string; takenBy?: string }): Promise<TakeTaskResult>;
  completeTask(args: { id: string; outcome: string }): Promise<CompleteTaskResult>;
  reopenTask(args: { id: string }): Promise<{
    task: ToolConceptMeta & { createdAt?: string; updatedAt?: string };
  }>;
  search(args: SearchArgs): Promise<{ hits: WireHit[] }>;
  related(args: RelatedArgs): Promise<{ id: string; related: WireRelated[] }>;
  graph(): Promise<GraphPayload>;
  context(args: ContextArgs): Promise<{
    markdown: string;
    included: ToolConceptMeta[];
    truncated: boolean;
    approxTokens: number;
  }>;
  stats(): Promise<VaultStatsResult>;
  onboarding(): Promise<{ onboardedAt: string | null }>;
  setOnboardedAt(onboardedAt: string): Promise<{ ok: true; onboardedAt: string }>;
  link(args: { from: string; to: string; relation?: string }): Promise<{
    ok: true;
    from: string;
    to: string;
    relation: string;
  }>;
  destroy(): Promise<{ ok: true }>;
}

/** Get the typed client for a vault's DO. `vaultId` is the DO name. */
export function vaultClient(ns: DurableObjectNamespace, vaultId: string): VaultClient {
  const stub = ns.get(ns.idFromName(vaultId));

  async function call<T>(method: string, args: unknown = {}): Promise<T> {
    const res = await stub.fetch(`https://vault-do/${method}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(args ?? {}),
    });
    const data = (await res.json()) as T & { error?: string };
    if (!res.ok) throw new VaultDoError(data?.error ?? `VaultDO ${method} failed`, res.status);
    return data;
  }

  return {
    upsertConcept: (input) => call("upsertConcept", input),
    deleteConcept: (id) => call("deleteConcept", { id }),
    getConcept: (id) => call("getConcept", { id }),
    list: (filter = {}) => call("list", filter),
    listTasks: (filter = {}) => call("listTasks", filter),
    takeTask: (args = {}) => call("takeTask", args),
    completeTask: (args) => call("completeTask", args),
    reopenTask: (args) => call("reopenTask", args),
    search: (args) => call("search", args),
    related: (args) => call("related", args),
    graph: () => call("graph"),
    context: (args) => call("context", args),
    stats: () => call("stats"),
    onboarding: () => call("onboarding"),
    setOnboardedAt: (onboardedAt) => call("setOnboardedAt", { onboardedAt }),
    link: (args) => call("link", args),
    destroy: () => call("destroy"),
  };
}
