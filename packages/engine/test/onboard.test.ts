import { describe, expect, it } from "vitest";
import { ONBOARDING_NUDGE, ONBOARDING_SUMMARY_ID, onboardingPlaybook } from "../src/onboard.js";

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

  it("carries the exclusions, the 20–60 target, and the complete call", () => {
    for (const excl of ["node_modules", "dist", ".git", "lockfiles", "binaries"]) {
      expect(playbook).toContain(excl);
    }
    expect(playbook).toContain("20–60 concepts");
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
