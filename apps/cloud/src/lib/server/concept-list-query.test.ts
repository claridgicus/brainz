/**
 * REST concept-list filter vs the product ontology.
 *
 * KNOWN BUG (documented, intentionally NOT fixed here — see TESTING.md):
 * GET /api/vaults/:id/concepts?type=… inlines the ORIGINAL 6 concept types,
 * so filtering by the v3 ontology types (domain, story, spec, workflow)
 * returns 400 even though upsert accepts them, the MCP list_concepts tool
 * accepts them, and the search route's contract schema accepts them.
 *
 * The `it.fails` test below asserts the CORRECT behavior (every type in
 * CONCEPT_TYPES is a valid filter). It is expected to fail until the route
 * adopts `conceptTypeSchema` from @brainz/contracts; once fixed, vitest will
 * flag it so the `.fails` marker gets removed.
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

  // xfail: documents the v3-ontology gap without failing the gate.
  it.fails(
    "accepts EVERY contract concept type as a filter (v3 ontology) — known bug, see TESTING.md",
    () => {
      for (const type of CONCEPT_TYPES) {
        expect(listQuerySchema.safeParse({ type }).success, `type=${type} must be filterable`).toBe(
          true,
        );
      }
    },
  );
});
