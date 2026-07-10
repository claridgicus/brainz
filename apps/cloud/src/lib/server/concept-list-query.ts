/**
 * Query-param filter for GET /api/vaults/:vaultId/concepts.
 *
 * Lives in its own module (not the +server.ts route, which may only export
 * handlers) so tests can exercise it directly — see
 * concept-list-query.test.ts. Uses the full 10-type ontology via
 * conceptTypeSchema, matching upsert / MCP list_concepts / REST search.
 */
import { conceptTypeSchema } from "@brainz/contracts";
import { z } from "zod";

export const listQuerySchema = z.object({
  product: z.string().optional(),
  // Full 10-type ontology (domain/story/spec/workflow included) — matches
  // upsert / MCP list_concepts / REST search, which all use conceptTypeSchema.
  type: conceptTypeSchema.optional(),
  tag: z.string().optional(),
});
