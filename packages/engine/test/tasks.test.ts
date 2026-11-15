import { describe, expect, it } from "vitest";
import { TASK_COMPLETE_NOTICE, TASK_COMPLETE_REMINDER, createTaskRelations } from "../src/index.js";

describe("TASK_COMPLETE_REMINDER", () => {
  it("is a one-line directive naming upsert_concept", () => {
    expect(TASK_COMPLETE_REMINDER).not.toContain("\n");
    expect(TASK_COMPLETE_REMINDER).toContain("upsert_concept");
  });

  it("has a one-line neutral form that names no tool to call", () => {
    expect(TASK_COMPLETE_NOTICE).not.toContain("\n");
    expect(TASK_COMPLETE_NOTICE).toMatch(/done/);
    expect(TASK_COMPLETE_NOTICE).not.toMatch(/\bcall\b|\bnow\b|tool|upsert_concept/i);
  });
});

describe("createTaskRelations", () => {
  it("puts the domain then the epic under part_of", () => {
    expect(createTaskRelations({ domain: "auth", epic: "checkout-v2" })).toEqual({
      part_of: ["auth", "checkout-v2"],
    });
    expect(createTaskRelations({ epic: "checkout-v2" })).toEqual({ part_of: ["checkout-v2"] });
    expect(createTaskRelations({ domain: "x", epic: "x" })).toEqual({ part_of: ["x"] });
  });

  it("carries realizes / governed_by and is undefined with no links", () => {
    expect(createTaskRelations({ realizes: ["f"], governedBy: ["s"] })).toEqual({
      realizes: ["f"],
      governed_by: ["s"],
    });
    expect(createTaskRelations({ realizes: [], governedBy: [] })).toBeUndefined();
    expect(createTaskRelations({})).toBeUndefined();
  });
});
