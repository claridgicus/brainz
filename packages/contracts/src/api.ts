/**
 * REST API schemas for the apps/cloud endpoints (SPEC-CLOUD.md).
 *
 * Wherever a shipped wire shape already exists, these REUSE it rather than
 * inventing a variant:
 * - search/related/stats responses and the concept upsert / context requests
 *   are the MCP tool shapes from ./mcp.js
 * - the graph payload is exactly packages/web's /api/graph shape
 *
 * Cloud concepts live in a per-vault Durable Object, not on disk, so cloud
 * concept metadata is the tool-compact shape (no filePath) plus timestamps.
 */
import { z } from "zod";
import { conceptTypeSchema, edgeSchema, searchModeSchema, taskStatusSchema } from "./domain.js";
import {
  createTaskInputSchema,
  getContextInputSchema,
  getRelatedOutputSchema,
  listConceptsOutputSchema,
  listTasksOutputSchema,
  searchConceptsOutputSchema,
  taskMetaSchema,
  toolConceptMetaSchema,
  upsertConceptInputSchema,
  vaultStatsOutputSchema,
} from "./mcp.js";

/** Every non-2xx JSON body: `{ error }`. */
export const apiErrorSchema = z.object({ error: z.string() });
export type ApiError = z.infer<typeof apiErrorSchema>;

// ------------------------------------------------------------------- vaults

/**
 * Vault membership roles (Wave M):
 * - owner  — everything: rename/delete vault, manage keys, members, invites.
 * - editor — read + write concepts/tasks; no keys/members/invites/delete/rename.
 * - viewer — read-only: browse/search/context; no writes of any kind.
 */
export const vaultRoleSchema = z.enum(["owner", "editor", "viewer"]);
export type VaultRole = z.infer<typeof vaultRoleSchema>;

export const vaultSchema = z.object({
  id: z.string(),
  slug: z.string(),
  name: z.string(),
  createdAt: z.string(),
  /** The CALLER's role on this vault (bearer-key access reports "editor"). */
  role: vaultRoleSchema,
  /** Total members (cheap D1 count; may be omitted where not computed). */
  memberCount: z.number().int().optional(),
});
export type Vault = z.infer<typeof vaultSchema>;

export const vaultCreateRequestSchema = z.object({
  name: z.string().min(1),
  slug: z.string().min(1).optional(),
});
export const vaultUpdateRequestSchema = z.object({
  name: z.string().min(1).optional(),
  slug: z.string().min(1).optional(),
});
export const vaultListResponseSchema = z.object({ vaults: z.array(vaultSchema) });

// ---------------------------------------------------------- members (Wave M)

/** One vault member — GET /api/vaults/:id/members list item. */
export const vaultMemberSchema = z.object({
  userId: z.string(),
  email: z.string(),
  name: z.string(),
  role: vaultRoleSchema,
  createdAt: z.string(),
});
export type VaultMember = z.infer<typeof vaultMemberSchema>;

export const memberListResponseSchema = z.object({ members: z.array(vaultMemberSchema) });

/** PATCH /api/vaults/:id/members/:userId body (owner-only role change). */
export const memberUpdateRequestSchema = z.object({ role: vaultRoleSchema });
/** PATCH response: the updated member. */
export const memberUpdateResponseSchema = vaultMemberSchema;

// ---------------------------------------------------------- invites (Wave M)

/**
 * A pending email invite. `invitedBy` is the INVITER's display name (not a
 * user id — it feeds the "invited by …" line in the UI and invite page).
 * NOTE: the shape never carries the invite URL — tokens are SHA-256-hashed at
 * rest, so the one-time URL exists only in the create/resend responses.
 */
export const vaultInviteSchema = z.object({
  id: z.string(),
  email: z.string(),
  role: vaultRoleSchema,
  createdAt: z.string(),
  expiresAt: z.string(),
  invitedBy: z.string(),
});
export type VaultInvite = z.infer<typeof vaultInviteSchema>;

/** GET /api/vaults/:id/invites — pending (unaccepted, unexpired) only. */
export const inviteListResponseSchema = z.object({ invites: z.array(vaultInviteSchema) });

/** POST /api/vaults/:id/invites body (owner-only). */
export const inviteCreateRequestSchema = z.object({
  email: z.string().email(),
  role: vaultRoleSchema,
});

/**
 * POST /api/vaults/:id/invites (and .../invites/:inviteId/resend) response.
 * `url` is the ONE-TIME invite link (`<origin>/invite/<token>`) — shown
 * exactly here and emailed; the list endpoint can never reproduce it because
 * only the token's hash is stored.
 */
export const inviteCreateResponseSchema = z.object({
  invite: vaultInviteSchema,
  url: z.string(),
});

/** POST /api/invites/:token/accept response — where to go next. */
export const inviteAcceptResponseSchema = z.object({
  vaultId: z.string(),
  slug: z.string(),
  role: vaultRoleSchema,
  /** True when the acceptor was already a member (idempotent success). */
  alreadyMember: z.boolean(),
});

// ----------------------------------------------------------------- concepts

/** Cloud concept metadata: the MCP compact shape (no filePath — no files in the cloud). */
export const apiConceptMetaSchema = toolConceptMetaSchema;
export type ApiConceptMeta = z.infer<typeof apiConceptMetaSchema>;

/** GET .../concepts/:id response body. */
export const apiConceptSchema = toolConceptMetaSchema.extend({
  createdAt: z.string().optional(),
  updatedAt: z.string().optional(),
  body: z.string(),
});
export type ApiConcept = z.infer<typeof apiConceptSchema>;

/** GET .../concepts response body — same shape as the list_concepts tool output. */
export const conceptListResponseSchema = listConceptsOutputSchema;

/** POST .../concepts / PUT .../concepts/:id body — same shape as the upsert_concept tool input. */
export const conceptUpsertRequestSchema = upsertConceptInputSchema;

// -------------------------------------------------------------------- tasks

/** GET .../tasks query params. `groupBy` is a board-layout hint; the server
 * returns the same task list regardless (grouping happens client-side). */
export const tasksQuerySchema = z.object({
  taskStatus: taskStatusSchema.optional(),
  domain: z.string().optional(),
  groupBy: z.enum(["status", "domain", "priority", "takenBy"]).optional(),
});

/** GET .../tasks response — same shape as the list_tasks tool output. */
export const taskListResponseSchema = listTasksOutputSchema;
export type TaskMeta = z.infer<typeof taskMetaSchema>;

/** POST .../tasks body — same shape as the create_task tool input. */
export const taskCreateRequestSchema = createTaskInputSchema;

/**
 * PATCH .../tasks/:id body — a card move on the board. `action` maps to a task
 * mutation: take (claim), complete (done + outcome), reopen (back to open).
 */
export const taskMoveRequestSchema = z.union([
  z.object({ action: z.literal("take"), takenBy: z.string().optional() }),
  z.object({ action: z.literal("complete"), outcome: z.string().min(1) }),
  z.object({ action: z.literal("reopen") }),
]);
export type TaskMoveRequest = z.infer<typeof taskMoveRequestSchema>;

/** PATCH .../tasks/:id response: the updated task meta. */
export const taskMoveResponseSchema = taskMetaSchema;

// ----------------------------------------------------------------- api keys

export const apiKeySchema = z.object({
  id: z.string(),
  vaultId: z.string(),
  name: z.string(),
  keyPrefix: z.string(),
  createdAt: z.string(),
  lastUsedAt: z.string().nullable(),
});
export type ApiKey = z.infer<typeof apiKeySchema>;

export const apiKeyCreateRequestSchema = z.object({ name: z.string().min(1) });

/**
 * POST .../keys response: the ONLY place the plaintext `key` (`bz_...`) ever
 * appears — shown exactly once at creation; only its SHA-256 hash is stored.
 */
export const apiKeyCreateResponseSchema = apiKeySchema.extend({ key: z.string() });

/** GET .../keys response — never includes plaintext keys. */
export const apiKeyListResponseSchema = z.object({ keys: z.array(apiKeySchema) });

// ----------------------------------------------------- search/related/context

/** GET .../search query params (`z.coerce` handles numeric strings). */
export const searchQuerySchema = z.object({
  q: z.string().min(1),
  mode: searchModeSchema.default("hybrid"),
  type: conceptTypeSchema.optional(),
  product: z.string().optional(),
  limit: z.coerce.number().int().min(1).max(50).default(10),
});

/** GET .../search response — same shape as the search_concepts tool output. */
export const searchResponseSchema = searchConceptsOutputSchema;

/** GET .../related/:id query params. */
export const relatedQuerySchema = z.object({
  depth: z.coerce.number().int().min(1).max(3).default(1),
  limit: z.coerce.number().int().min(1).optional(),
});

/** GET .../related/:id response — same shape as the get_related tool output. */
export const relatedResponseSchema = getRelatedOutputSchema;

/** POST .../context body — same shape as the get_context tool input. */
export const contextRequestSchema = getContextInputSchema;

/** POST .../context response: the ContextBundle with cloud (fileless) metas. */
export const contextResponseSchema = z
  .object({
    markdown: z.string(),
    included: z.array(apiConceptMetaSchema),
    truncated: z.boolean(),
    approxTokens: z.number(),
  })
  .strict();

// -------------------------------------------------------------------- graph

/**
 * Node in the graph payload — exactly packages/web's /api/graph shape.
 * Pending nodes are edge targets with no concept yet: `type: "pending"`,
 * `pending: true`, title falls back to the id.
 */
export const graphNodeSchema = z
  .object({
    id: z.string(),
    title: z.string(),
    type: z.union([conceptTypeSchema, z.literal("pending")]),
    product: z.string().optional(),
    tags: z.array(z.string()),
    degree: z.number().int(),
    pending: z.literal(true).optional(),
  })
  .strict();
export type GraphNode = z.infer<typeof graphNodeSchema>;

export const graphResponseSchema = z
  .object({
    nodes: z.array(graphNodeSchema),
    edges: z.array(edgeSchema),
  })
  .strict();
export type GraphPayload = z.infer<typeof graphResponseSchema>;

// -------------------------------------------------------------------- stats

/** GET .../stats response — same shape as the vault_stats tool output. */
export const statsResponseSchema = vaultStatsOutputSchema;
