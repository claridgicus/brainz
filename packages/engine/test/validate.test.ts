import { describe, expect, it } from "vitest";
import { validateGraph } from "../src/validate.js";
import type { Edge } from "../src/types.js";

const EDGES: Edge[] = [
  { from: "a", to: "b", relation: "references" },
  { from: "b", to: "ghost", relation: "depends_on" },
];

describe("validateGraph", () => {
  it("passes a clean graph", () => {
    const result = validateGraph([{ id: "a" }, { id: "b" }], [
      { from: "a", to: "b", relation: "references" },
    ]);
    expect(result).toEqual({ errors: [], warnings: [] });
  });

  it("reports duplicate ids as errors", () => {
    const { errors, warnings } = validateGraph(
      [{ id: "a" }, { id: "a" }, { id: "a" }, { id: "b" }],
      [],
    );
    expect(errors).toHaveLength(1);
    expect(errors[0].message).toContain('duplicate id "a"');
    expect(errors[0].message).toContain("3");
    expect(warnings).toEqual([]);
  });

  it("reports broken links as warnings (pending concepts, never errors)", () => {
    const { errors, warnings } = validateGraph([{ id: "a" }, { id: "b" }], EDGES);
    expect(errors).toEqual([]);
    expect(warnings).toHaveLength(1);
    expect(warnings[0].message).toContain("b —depends_on→ ghost");
    expect(warnings[0].message).toContain("pending");
  });

  it("handles an empty graph", () => {
    expect(validateGraph([], [])).toEqual({ errors: [], warnings: [] });
  });
});
