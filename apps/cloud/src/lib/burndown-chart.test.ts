import { describe, expect, it } from "vitest";
import type { BurndownResultWire } from "@brainz/contracts";
import { DEFAULT_BOX, chartModel, fmtHours, nearestPoint, niceStep, shortDay } from "./burndown-chart";

const base: BurndownResultWire = {
  scope: { id: "s1", kind: "concept", title: "Sprint 1", type: "iteration", startDate: "2026-11-02", endDate: "2026-11-05" },
  window: {
    from: "2026-11-02T00:00:00.000Z",
    to: "2026-11-06T00:00:00.000Z",
    now: "2026-11-04T00:00:00.000Z",
    bucket: "day",
    unit: "tasks",
  },
  totals: { scope: 4, done: 2, open: 2, taken: 1, unestimated: 0 },
  series: [
    { at: "2026-11-02T00:00:00.000Z", scope: 4, done: 0, open: 4, taken: 0, ideal: 4 },
    { at: "2026-11-03T00:00:00.000Z", scope: 4, done: 1, open: 3, taken: 1, ideal: 3 },
    { at: "2026-11-04T00:00:00.000Z", scope: 4, done: 2, open: 2, taken: 1, ideal: 2 },
    { at: "2026-11-05T00:00:00.000Z", scope: null, done: null, open: null, taken: null, ideal: 1 },
    { at: "2026-11-06T00:00:00.000Z", scope: null, done: null, open: null, taken: null, ideal: 0 },
  ],
  scopeChanges: [
    { at: "2026-11-03T00:00:00.000Z", task: "t9", title: "Late add", change: "added", points: null },
    { at: "2026-11-03T00:00:00.000Z", task: "t8", title: "Dropped", change: "removed", points: null },
  ],
};

describe("burndown chart model", () => {
  it("maps the window onto the plot and stops actuals at now", () => {
    const m = chartModel(base)!;
    expect(m.points).toHaveLength(3);
    expect(m.points[0].x).toBe(DEFAULT_BOX.left);
    expect(m.points[2].x).toBeCloseTo(DEFAULT_BOX.left + (DEFAULT_BOX.width - DEFAULT_BOX.left - DEFAULT_BOX.right) / 2);
    expect(m.remaining.startsWith("M40,")).toBe(true);
    expect(m.ideal).not.toBeNull();
    expect(m.nowX).toBeCloseTo(m.points[2].x);
    expect(m.last).toMatchObject({ remaining: 2, done: 2, scope: 4 });
    expect(m.yTicks.map((t) => t.value)).toEqual([0, 1, 2, 3, 4]);
    expect(m.xTicks[0].label).toBe("Nov 2");
    expect(m.changes).toEqual([
      expect.objectContaining({ added: 1, removed: 1, titles: ["+ Late add", "− Dropped"] }),
    ]);
  });

  it("is null without a series and has no ideal without dates", () => {
    expect(chartModel({ ...base, series: undefined })).toBeNull();
    const m = chartModel({ ...base, series: base.series!.map((p) => ({ ...p, ideal: null })) })!;
    expect(m.ideal).toBeNull();
  });

  it("picks the nearest hover point and formats", () => {
    const m = chartModel(base)!;
    expect(nearestPoint(m, m.points[1].x + 3)?.point.done).toBe(1);
    expect(niceStep(23)).toBe(10);
    expect(niceStep(0)).toBe(1);
    expect(shortDay(null)).toBe("—");
    expect(fmtHours(5)).toBe("5.0h");
    expect(fmtHours(72)).toBe("3.0d");
  });
});
