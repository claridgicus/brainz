import { describe, expect, it } from "vitest";
import {
  SYNC_STALENESS_DAYS,
  SYNC_STALENESS_MS,
  SYNC_STALENESS_NOTICE,
  SYNC_STALENESS_NUDGE,
  isSyncStale,
  syncPlaybook,
} from "../src/sync.js";

describe("syncPlaybook", () => {
  const playbook = syncPlaybook({ onboarded: true });

  it("is a Sync playbook, NOT the onboarding playbook", () => {
    expect(playbook).toMatch(/^# Sync playbook/);
    expect(playbook).not.toMatch(/^# Onboarding playbook/m);
  });

  it("teaches diff-since-last-sync → update-stale → index-new", () => {
    // Step 1: diff since last sync (agent runs git, supplies changed paths).
    expect(playbook).toContain("Diff the codebase since the last sync");
    expect(playbook).toContain('git log --since=');
    expect(playbook).toContain("git diff --name-only");
    expect(playbook).toContain("changedPaths");
    // Step 3: update stale concepts in place (no duplication).
    expect(playbook).toContain("Update stale concepts whose code_areas changed");
    expect(playbook).toContain("UPDATE the concept in place");
    expect(playbook).toContain("it does not fork");
    // Step 4: index new / un-mapped work + file tasks for incomplete work.
    expect(playbook).toContain("Index new / un-mapped work as new concepts");
    expect(playbook).toContain("create_task");
    // Fan out over CHANGED areas only, not a full re-survey.
    expect(playbook).toContain("CHANGED areas only");
    expect(playbook).toContain("Do NOT re-survey the whole tree");
  });

  it("finishes by appending to the running sync log via sync complete", () => {
    expect(playbook).toContain('{"action": "complete"');
    expect(playbook).toContain("last_synced_at = now");
    expect(playbook).toContain("APPENDS your summary to the `product-onboarding-summary`");
    expect(playbook).toContain("running sync log");
  });

  it("embeds a coverage map from the vault's concepts vs the areaList", () => {
    const withCoverage = syncPlaybook({
      onboarded: true,
      areaList: ["packages/engine", "packages/core", "apps/cloud/src"],
      concepts: [{ codeAreas: ["packages/engine/src/sync.ts"] }],
    });
    expect(withCoverage).toContain("## Coverage map");
    // engine covered, the other two are gaps; reuses computeCoverage.
    expect(withCoverage).toContain("**Covered areas:** packages/engine");
    expect(withCoverage).toContain("packages/core, apps/cloud/src");
    expect(withCoverage).toMatch(/Coverage:\*\* 33%/);
  });

  it("focuses the fan-out on supplied changedPaths", () => {
    const focused = syncPlaybook({
      onboarded: true,
      changedPaths: ["apps/cloud/src/lib/server/mcp.ts"],
    });
    expect(focused).toContain("focus the fan-out on the areas they fall under");
    expect(focused).toContain("apps/cloud/src/lib/server/mcp.ts");
  });

  it("echoes lastSyncedAt and productName, and warns when not onboarded", () => {
    const custom = syncPlaybook({
      productName: "Acme CRM",
      lastSyncedAt: "2026-06-01T00:00:00.000Z",
      onboarded: false,
    });
    expect(custom).toContain("# Sync playbook — Acme CRM");
    expect(custom).toContain("2026-06-01T00:00:00.000Z");
    expect(custom).toContain("NOT onboarded");
    expect(playbook).not.toContain("NOT onboarded");
  });

  it("notes the first sync when never synced", () => {
    expect(playbook).toContain("never synced");
  });
});

describe("SYNC_STALENESS_NUDGE", () => {
  it("is one line and points at the sync tool", () => {
    expect(SYNC_STALENESS_NUDGE).not.toContain("\n");
    expect(SYNC_STALENESS_NUDGE).toMatch(/sync/);
    expect(SYNC_STALENESS_NUDGE).toContain(String(SYNC_STALENESS_DAYS));
  });

  it("has a one-line neutral form that names no tool to call", () => {
    expect(SYNC_STALENESS_NOTICE).not.toContain("\n");
    expect(SYNC_STALENESS_NOTICE).toContain(String(SYNC_STALENESS_DAYS));
    expect(SYNC_STALENESS_NOTICE).not.toMatch(/\bcall\b|tool/i);
  });

  it("SYNC_STALENESS_MS is 14 days in ms", () => {
    expect(SYNC_STALENESS_DAYS).toBe(14);
    expect(SYNC_STALENESS_MS).toBe(14 * 24 * 60 * 60 * 1000);
  });
});

describe("isSyncStale", () => {
  const now = Date.parse("2026-07-12T00:00:00.000Z");

  it("is never stale when un-onboarded (onboarding nudge takes precedence)", () => {
    expect(isSyncStale(false, null, now)).toBe(false);
    expect(isSyncStale(false, "2020-01-01T00:00:00.000Z", now)).toBe(false);
  });

  it("is stale when onboarded but never synced", () => {
    expect(isSyncStale(true, null, now)).toBe(true);
    expect(isSyncStale(true, undefined, now)).toBe(true);
  });

  it("is not stale within the threshold, stale beyond it", () => {
    // 13 days ago → fresh; 15 days ago → stale.
    const thirteen = new Date(now - 13 * 24 * 60 * 60 * 1000).toISOString();
    const fifteen = new Date(now - 15 * 24 * 60 * 60 * 1000).toISOString();
    expect(isSyncStale(true, thirteen, now)).toBe(false);
    expect(isSyncStale(true, fifteen, now)).toBe(true);
  });

  it("treats an unparseable timestamp as stale", () => {
    expect(isSyncStale(true, "not-a-date", now)).toBe(true);
  });
});
