import { describe, expect, it } from "vitest";
import { TASK_COMPLETE_NOTICE, TASK_COMPLETE_REMINDER } from "../src/index.js";

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
