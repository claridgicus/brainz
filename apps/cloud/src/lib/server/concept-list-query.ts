/**
 * Query-param filter for GET /api/vaults/:vaultId/concepts.
 *
 * Lives in its own module (not the +server.ts route, which may only export
 * handlers) so tests can exercise it directly — see
 * routes/api/vaults/[vaultId]/concepts/list-query.test.ts, which documents a
 * known drift from the 10-type ontology in @brainz/contracts.
 */
import { z } from "zod";

export const listQuerySchema = z.object({
  product: z.string().optional(),
  type: z.enum(["concept", "feature", "decision", "constraint", "pattern", "glossary"]).optional(),
  tag: z.string().optional(),
});
