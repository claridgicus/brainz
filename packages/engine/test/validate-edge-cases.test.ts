/**
 * validateGraph edge cases beyond validate.test.ts: mixed error+warning
 * graphs, per-edge warnings, and which side of an edge is checked.
 */
import { describe, expect, it } from "vitest";
import { validateGraph } from "../src/validate.js";

describe("validateGraph edge cases", () => {
  it("reports duplicates AND broken links from the same graph", () => {
    const { errors, warnings } = validateGraph(
      [{ id: "a" }, { id: "a" }, { id: "b" }],
      [
        { from: "a", to: "b", relation: "references" },
        { from: "b", to: "ghost", relation: "depends_on" },
      ],
    );
    expect(errors).toHaveLength(1);
    expect(errors[0].message).toContain('duplicate id "a"');
    expect(warnings).toHaveLength(1);
    expect(warnings[0].message).toContain("ghost");
  });

  it("warns once per broken edge, even for the same missing target", () => {
    const { warnings } = validateGraph(
      [{ id: "a" }, { id: "b" }],
      [
        { from: "a", to: "ghost", relation: "references" },
        { from: "b", to: "ghost", relation: "depends_on" },
      ],
    );
    expect(warnings).toHaveLength(2);
    expect(warnings[0].message).toContain("a —references→ ghost");
    expect(warnings[1].message).toContain("b —depends_on→ ghost");
  });

  it("only the edge TARGET is checked — unknown sources never warn", () => {
    // Edges are extracted from existing notes, so `from` always exists in
    // practice; the validator's contract is to flag missing targets only.
    const { errors, warnings } = validateGraph(
      [{ id: "b" }],
      [{ from: "nowhere", to: "b", relation: "references" }],
    );
    expect(errors).toEqual([]);
    expect(warnings).toEqual([]);
  });

  it("a self-referencing edge to an existing id is clean", () => {
    const { errors, warnings } = validateGraph(
      [{ id: "a" }],
      [{ from: "a", to: "a", relation: "related_to" }],
    );
    expect(errors).toEqual([]);
    expect(warnings).toEqual([]);
  });

  it("edges to a duplicated id do not warn (the id exists, however many times)", () => {
    const { errors, warnings } = validateGraph(
      [{ id: "dup" }, { id: "dup" }, { id: "a" }],
      [{ from: "a", to: "dup", relation: "references" }],
    );
    expect(errors).toHaveLength(1);
    expect(warnings).toEqual([]);
  });
});
