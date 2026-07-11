import { describe, expect, it } from "vitest";
import {
  ONBOARDING_NUDGE,
  ONBOARDING_SUMMARY_ID,
  computeCoverage,
  onboardingPlaybook,
} from "../src/onboard.js";

describe("onboardingPlaybook", () => {
  const playbook = onboardingPlaybook();

  it("is markdown, ontology-ordered: domains → features → stories → specs → workflows", () => {
    expect(playbook).toMatch(/^# Onboarding playbook/);
    const order = ["`domain`", "`feature`", "`story`", "`spec`", "`workflow`"];
    const positions = order.map((t) => playbook.indexOf(t));
    for (const pos of positions) expect(pos).toBeGreaterThan(-1);
    expect([...positions].sort((a, b) => a - b)).toEqual(positions);
  });

  it("teaches the canonical relations and code areas", () => {
    for (const rel of ["part_of", "realized_by", "governs", "depends_on"]) {
      expect(playbook).toContain(rel);
    }
    expect(playbook).toContain("codeAreas");
  });

  it("carries the exclusions and the complete call", () => {
    for (const excl of ["node_modules", "dist", ".git", "lockfiles", "binaries"]) {
      expect(playbook).toContain(excl);
    }
    expect(playbook).toContain('"action": "complete"');
    expect(playbook).toContain(ONBOARDING_SUMMARY_ID);
  });

  it("echoes productName and repoHint, and flags re-runs", () => {
    const custom = onboardingPlaybook({
      productName: "Acme CRM",
      repoHint: "github.com/acme/crm",
      onboarded: true,
    });
    expect(custom).toContain("# Onboarding playbook — Acme CRM");
    expect(custom).toContain("github.com/acme/crm");
    expect(custom).toContain("already onboarded");
    expect(playbook).not.toContain("already onboarded");
  });
});

describe("ONBOARDING_NUDGE", () => {
  it("is one line and points at the onboard tool", () => {
    expect(ONBOARDING_NUDGE).not.toContain("\n");
    expect(ONBOARDING_NUDGE).toMatch(/not onboarded/);
    expect(ONBOARDING_NUDGE).toMatch(/onboard/);
  });
});

describe("onboardingPlaybook — size-aware, no flat cap", () => {
  const playbook = onboardingPlaybook();

  it("dropped the flat 20–60 cap", () => {
    expect(playbook).not.toContain("20–60 concepts");
    expect(playbook).not.toContain("Target 20–60");
  });

  it("sets a large-repo expectation and forbids stopping early", () => {
    expect(playbook).toContain("200–800+ concepts");
    expect(playbook).toMatch(/do NOT stop at a few dozen/i);
    expect(playbook).toMatch(/saturation/i);
  });

  it("documents the continue loop: survey → index → status → repeat", () => {
    expect(playbook).toContain('"action": "status"');
    expect(playbook).toContain("areaList");
    expect(playbook).toMatch(/loop/i);
    // status must be taught before complete (the loop precedes sealing).
    expect(playbook.indexOf('"action": "status"')).toBeLessThan(
      playbook.lastIndexOf('"action": "complete"'),
    );
  });

  it("still teaches complete + the summary concept id", () => {
    expect(playbook).toContain('"action": "complete"');
    expect(playbook).toContain(ONBOARDING_SUMMARY_ID);
  });
});

describe("computeCoverage", () => {
  const areas = ["packages/engine", "packages/core", "apps/cloud/src"];

  it("marks an area covered when a concept's code_area is under it", () => {
    const cov = computeCoverage(
      [{ codeAreas: ["packages/engine/src/onboard.ts"] }],
      areas,
    );
    expect(cov.covered).toEqual(["packages/engine"]);
    expect(cov.uncovered).toEqual(["packages/core", "apps/cloud/src"]);
    expect(cov.conceptCount).toBe(1);
    expect(cov.coveragePct).toBe(33); // 1/3 rounded
  });

  it("matches an exact area path (not only descendants)", () => {
    const cov = computeCoverage([{ codeAreas: ["packages/engine"] }], areas);
    expect(cov.covered).toContain("packages/engine");
  });

  it("is segment-aware: a sibling prefix does not count", () => {
    // apps/cloud/src must NOT be covered by apps/cloud/src-legacy/...
    const cov = computeCoverage(
      [{ codeAreas: ["apps/cloud/src-legacy/foo.ts"] }],
      ["apps/cloud/src"],
    );
    expect(cov.uncovered).toEqual(["apps/cloud/src"]);
    expect(cov.covered).toEqual([]);
  });

  it("tolerates glob-ish code_areas and area globs", () => {
    const cov = computeCoverage(
      [{ codeAreas: ["packages/core/src/**"] }],
      ["packages/core/src/*", "packages/engine"],
    );
    expect(cov.covered).toEqual(["packages/core/src/*"]);
    expect(cov.uncovered).toEqual(["packages/engine"]);
  });

  it("normalizes leading ./ and backslashes", () => {
    const cov = computeCoverage(
      [{ codeAreas: ["./apps\\cloud\\src\\lib\\server\\mcp.ts"] }],
      ["apps/cloud/src"],
    );
    expect(cov.covered).toEqual(["apps/cloud/src"]);
  });

  it("dedupes the area list, preserving first-seen order", () => {
    const cov = computeCoverage([], ["packages/engine", "./packages/engine/", "packages/core"]);
    expect(cov.uncovered).toEqual(["packages/engine", "packages/core"]);
    expect(cov.coveragePct).toBe(0);
  });

  it("empty concepts → everything uncovered, 0%", () => {
    const cov = computeCoverage([], areas);
    expect(cov.covered).toEqual([]);
    expect(cov.uncovered).toEqual(areas);
    expect(cov.conceptCount).toBe(0);
    expect(cov.coveragePct).toBe(0);
  });

  it("empty areaList → covered/uncovered empty, 0% (no divide-by-zero)", () => {
    const cov = computeCoverage([{ codeAreas: ["packages/engine/x.ts"] }], []);
    expect(cov.covered).toEqual([]);
    expect(cov.uncovered).toEqual([]);
    expect(cov.conceptCount).toBe(1);
    expect(cov.coveragePct).toBe(0);
  });

  it("ignores empty/whitespace/null code_areas", () => {
    const cov = computeCoverage(
      [{ codeAreas: ["", "  ", null as unknown as string] }, { codeAreas: null }, {}],
      ["packages/engine"],
    );
    expect(cov.uncovered).toEqual(["packages/engine"]);
    expect(cov.conceptCount).toBe(3);
  });

  it("a nested area is covered by a concept anchored to a subdir of it", () => {
    const cov = computeCoverage(
      [{ codeAreas: ["apps/cloud/src/lib/server/mcp.ts"] }],
      ["apps/cloud/src", "apps/cloud/src/lib/server"],
    );
    // both the broad and the nested area are satisfied by the same code_area
    expect(cov.covered).toEqual(["apps/cloud/src", "apps/cloud/src/lib/server"]);
    expect(cov.coveragePct).toBe(100);
  });

  it("is deterministic across concept order", () => {
    const a = computeCoverage(
      [{ codeAreas: ["packages/core/x.ts"] }, { codeAreas: ["packages/engine/y.ts"] }],
      areas,
    );
    const b = computeCoverage(
      [{ codeAreas: ["packages/engine/y.ts"] }, { codeAreas: ["packages/core/x.ts"] }],
      areas,
    );
    expect(a).toEqual(b);
  });
});
