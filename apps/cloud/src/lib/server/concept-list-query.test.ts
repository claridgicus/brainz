/**
 * REST concept-list filter vs the product ontology.
 *
 * GET /api/vaults/:id/concepts?type=… uses conceptTypeSchema from
 * @brainz/contracts, so every type in the 10-type v3 ontology is a valid
 * filter — matching upsert, the MCP list_concepts tool, and the search route.
 */
import { CONCEPT_TYPES } from "@brainz/contracts";
import { describe, expect, it } from "vitest";
import { listQuerySchema } from "$lib/server/concept-list-query";

describe("concepts list query filter", () => {
  it("accepts the original 6 ontology types", () => {
    for (const type of ["concept", "feature", "decision", "constraint", "pattern", "glossary"]) {
      expect(listQuerySchema.safeParse({ type }).success, `type=${type}`).toBe(true);
    }
  });

  it("rejects garbage types", () => {
    expect(listQuerySchema.safeParse({ type: "banana" }).success).toBe(false);
  });

  it("accepts EVERY contract concept type as a filter (full v3 ontology)", () => {
    for (const type of CONCEPT_TYPES) {
      expect(listQuerySchema.safeParse({ type }).success, `type=${type} must be filterable`).toBe(
        true,
      );
    }
  });
});
