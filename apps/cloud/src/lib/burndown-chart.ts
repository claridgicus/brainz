// Pure geometry for the burndown chart (unit-tested in burndown-chart.test.ts).
// The Svelte component only maps this model to SVG; nothing here touches the DOM.

import type { BurndownResultWire } from "@brainz/contracts";

export type SeriesPoint = NonNullable<BurndownResultWire["series"]>[number];

export interface ChartBox {
  width: number;
  height: number;
  /** Plot insets: room for the y-axis labels (left) and the x-axis labels (bottom). */
  left: number;
  right: number;
  top: number;
  bottom: number;
}

export const DEFAULT_BOX: ChartBox = { width: 720, height: 280, left: 40, right: 16, top: 12, bottom: 28 };

export interface Tick {
  value: number;
  pos: number;
  label: string;
}

export interface ChartModel {
  box: ChartBox;
  /** Plot rect. */
  x0: number;
  x1: number;
  y0: number;
  y1: number;
  /** Remaining (open), as a polyline path; actuals only. */
  remaining: string;
  /** Scope as a step path (scope only changes at events). */
  scope: string;
  /** Done as a closed area path down to the baseline. */
  doneArea: string;
  /** Done top edge (line). */
  doneLine: string;
  /** Ideal guide (null when the scope has no dates). */
  ideal: string | null;
  /** Last actual point, for the end markers and direct labels. */
  last: { x: number; remaining: number; done: number; scope: number; yRemaining: number; yDone: number; yScope: number } | null;
  nowX: number | null;
  xTicks: Tick[];
  yTicks: Tick[];
  /** Scope-change ticks on the x-axis, grouped per position. */
  changes: { x: number; added: number; removed: number; titles: string[] }[];
  /** Hover targets: one per series point. */
  points: { x: number; point: SeriesPoint }[];
}

/** "Nice" tick step for a 0..max axis with about `count` ticks. */
export function niceStep(max: number, count = 4): number {
  if (max <= 0) return 1;
  const raw = max / count;
  const pow = 10 ** Math.floor(Math.log10(raw));
  const n = raw / pow;
  const mult = n <= 1 ? 1 : n <= 2 ? 2 : n <= 5 ? 5 : 10;
  return Math.max(mult * pow, 1);
}

const DAY = 86_400_000;

function fmtDay(t: number): string {
  return new Date(t).toLocaleDateString("en", { month: "short", day: "numeric", timeZone: "UTC" });
}

/** Build the chart model. Returns null when there is no series to draw. */
export function chartModel(r: BurndownResultWire, box: ChartBox = DEFAULT_BOX): ChartModel | null {
  const series = r.series ?? [];
  if (series.length < 2) return null;
  const x0 = box.left;
  const x1 = box.width - box.right;
  const y0 = box.height - box.bottom;
  const y1 = box.top;
  const t0 = Date.parse(r.window.from);
  const t1 = Date.parse(r.window.to);
  const span = Math.max(t1 - t0, 1);
  const X = (t: number) => x0 + ((t - t0) / span) * (x1 - x0);

  let max = 0;
  for (const p of series) {
    max = Math.max(max, p.scope ?? 0, p.ideal ?? 0, p.open ?? 0, p.done ?? 0);
  }
  const step = niceStep(max);
  const top = Math.max(step, Math.ceil(max / step) * step);
  const Y = (v: number) => y0 - (v / top) * (y0 - y1);

  const actual = series.filter((p) => p.open !== null);
  const fmt = (n: number) => n.toFixed(1).replace(/\.0$/, "");
  const line = (pts: [number, number][]) =>
    pts.map(([x, y], i) => `${i === 0 ? "M" : "L"}${fmt(x)},${fmt(y)}`).join("");

  const remaining = line(actual.map((p) => [X(Date.parse(p.at)), Y(p.open as number)]));
  const doneLine = line(actual.map((p) => [X(Date.parse(p.at)), Y(p.done as number)]));
  const doneArea =
    actual.length > 0
      ? `${doneLine}L${fmt(X(Date.parse(actual[actual.length - 1].at)))},${fmt(y0)}L${fmt(X(Date.parse(actual[0].at)))},${fmt(y0)}Z`
      : "";
  // Step: hold the previous value until the next point.
  const stepPts: [number, number][] = [];
  actual.forEach((p, i) => {
    const x = X(Date.parse(p.at));
    const y = Y(p.scope as number);
    if (i > 0) stepPts.push([x, stepPts[stepPts.length - 1][1]]);
    stepPts.push([x, y]);
  });
  const scope = line(stepPts);

  const idealPts = series
    .filter((p) => p.ideal !== null)
    .map((p) => [X(Date.parse(p.at)), Y(p.ideal as number)] as [number, number]);
  const ideal = idealPts.length >= 2 ? line(idealPts) : null;

  const lastP = actual[actual.length - 1];
  const last = lastP
    ? {
        x: X(Date.parse(lastP.at)),
        remaining: lastP.open as number,
        done: lastP.done as number,
        scope: lastP.scope as number,
        yRemaining: Y(lastP.open as number),
        yDone: Y(lastP.done as number),
        yScope: Y(lastP.scope as number),
      }
    : null;

  const now = Date.parse(r.window.now);
  const nowX = now > t0 && now < t1 ? X(now) : null;

  // ~6 date ticks on whole days.
  const days = Math.max(1, Math.round(span / DAY));
  const every = Math.max(1, Math.ceil(days / 6));
  const xTicks: Tick[] = [];
  const firstDay = Math.ceil(t0 / DAY) * DAY;
  for (let t = firstDay, i = 0; t <= t1; t += DAY, i++) {
    if (i % every === 0) xTicks.push({ value: t, pos: X(t), label: fmtDay(t) });
  }
  const yTicks: Tick[] = [];
  for (let v = 0; v <= top + 1e-9; v += step) yTicks.push({ value: v, pos: Y(v), label: fmt(v) });

  const byX = new Map<number, { x: number; added: number; removed: number; titles: string[] }>();
  for (const c of r.scopeChanges ?? []) {
    const x = Math.round(X(Date.parse(c.at)));
    const g = byX.get(x) ?? { x, added: 0, removed: 0, titles: [] };
    if (c.change === "added") g.added++;
    else g.removed++;
    g.titles.push(`${c.change === "added" ? "+" : "−"} ${c.title}`);
    byX.set(x, g);
  }

  return {
    box,
    x0,
    x1,
    y0,
    y1,
    remaining,
    scope,
    doneArea,
    doneLine,
    ideal,
    last,
    nowX,
    xTicks,
    yTicks,
    changes: [...byX.values()].sort((a, b) => a.x - b.x),
    points: actual.map((p) => ({ x: X(Date.parse(p.at)), point: p })),
  };
}

/** The hover target nearest to an x position (in chart units). */
export function nearestPoint(model: ChartModel, x: number): ChartModel["points"][number] | null {
  let best: ChartModel["points"][number] | null = null;
  for (const p of model.points) {
    if (!best || Math.abs(p.x - x) < Math.abs(best.x - x)) best = p;
  }
  return best;
}

/** "14 Nov" style day, or "—". */
export function shortDay(iso: string | null | undefined): string {
  if (!iso) return "—";
  return fmtDay(Date.parse(iso));
}

/** Hours as "5.2h" or "3.1d". */
export function fmtHours(h: number | null | undefined): string {
  if (h === null || h === undefined) return "—";
  return h >= 48 ? `${(h / 24).toFixed(1)}d` : `${h.toFixed(1)}h`;
}
