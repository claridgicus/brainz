import { describe, expect, it } from "vitest";
import {
  DEFAULT_ZOOM,
  cameraAt,
  cameraKeyframes,
  cursorAt,
  easeInOutCubic,
  frameAt,
  moveDuration,
  ripplesAt,
  viewRect,
  type CursorMove,
  type TakeEvent,
} from "../src/timeline.js";

const viewport = { width: 1600, height: 900 };

describe("cursorAt", () => {
  const moves: ReadonlyArray<CursorMove> = [
    { kind: "move", t: 1000, duration: 400, from: { x: 0, y: 0 }, to: { x: 100, y: 200 } },
    { kind: "move", t: 3000, duration: 500, from: { x: 100, y: 200 }, to: { x: 600, y: 200 } },
  ];
  it("rests before, glides on an ease, and rests after", () => {
    expect(cursorAt(moves, 0, { x: 5, y: 5 })).toEqual({ x: 5, y: 5 });
    expect(cursorAt(moves, 599, { x: 5, y: 5 })).toEqual({ x: 5, y: 5 });
    const mid = cursorAt(moves, 800, { x: 5, y: 5 });
    expect(mid.x).toBeCloseTo(50, 9);
    expect(mid.y).toBeCloseTo(100, 9);
    expect(cursorAt(moves, 1000, { x: 5, y: 5 })).toEqual({ x: 100, y: 200 });
    expect(cursorAt(moves, 2000, { x: 5, y: 5 })).toEqual({ x: 100, y: 200 });
    // A quarter of the way in time is well under a quarter of the way in space: it eases.
    expect(cursorAt(moves, 2625, { x: 5, y: 5 }).x).toBeLessThan(100 + 500 * 0.25);
    expect(cursorAt(moves, 4000, { x: 5, y: 5 })).toEqual({ x: 600, y: 200 });
  });
  it("eases symmetrically", () => {
    expect(easeInOutCubic(0)).toBe(0);
    expect(easeInOutCubic(0.5)).toBe(0.5);
    expect(easeInOutCubic(1)).toBe(1);
  });
  it("takes longer to cross further, within bounds", () => {
    expect(moveDuration(0)).toBe(320);
    expect(moveDuration(400)).toBe(480);
    expect(moveDuration(5000)).toBe(900);
  });
});

describe("ripplesAt", () => {
  const events: ReadonlyArray<TakeEvent> = [{ kind: "click", t: 1000, at: { x: 10, y: 10 } }];
  it("grows and fades after a click, and only then", () => {
    expect(ripplesAt(events, 999)).toEqual([]);
    const early = ripplesAt(events, 1000)[0]!;
    const late = ripplesAt(events, 1300)[0]!;
    expect(early.radius).toBeLessThan(late.radius);
    expect(early.alpha).toBeGreaterThan(late.alpha);
    expect(ripplesAt(events, 1400)).toEqual([]);
  });
});

describe("cameraKeyframes", () => {
  it("is on the click as it lands, pans ahead of the next, and zooms out on the reveal", () => {
    const events: ReadonlyArray<TakeEvent> = [
      { kind: "click", t: 1000, at: { x: 200, y: 300 } },
      { kind: "click", t: 2000, at: { x: 900, y: 300 } },
      { kind: "reveal", t: 5000 },
    ];
    const frames = cameraKeyframes(events, viewport);
    expect(frames.map((f) => [f.t, f.scale, f.focus.x])).toEqual([
      [0, 1, 800],
      [1000 - DEFAULT_ZOOM.zoomInMs, 1, 800],
      [1000, 1.8, 200],
      [2000 - DEFAULT_ZOOM.panMs, 1.8, 200],
      [2000, 1.8, 900],
      [5000, 1.8, 900],
      [5000 + DEFAULT_ZOOM.zoomOutMs, 1, 800],
    ]);
  });
  it("never departs before it last settled, and skips a moment already framed", () => {
    const events: ReadonlyArray<TakeEvent> = [
      { kind: "click", t: 300, at: { x: 200, y: 300 } },
      { kind: "key", t: 400, at: { x: 200, y: 300 } },
      { kind: "key", t: 500, at: { x: 200, y: 300 } },
      { kind: "reveal", t: 1000 },
      { kind: "click", t: 3000, at: { x: 900, y: 300 } },
    ];
    const frames = cameraKeyframes(events, viewport);
    expect(frames.map((f) => [f.t, f.scale, f.focus.x])).toEqual([
      [0, 1, 800],
      [300, 1.8, 200],
      [1000, 1.8, 200],
      [1000 + DEFAULT_ZOOM.zoomOutMs, 1, 800],
      [3000 - DEFAULT_ZOOM.zoomInMs, 1, 800],
      [3000, 1.8, 900],
    ]);
  });
  it("cuts a zoom-out short where it has got to when a click lands mid-flight", () => {
    const events: ReadonlyArray<TakeEvent> = [
      { kind: "click", t: 300, at: { x: 200, y: 300 } },
      { kind: "reveal", t: 1000 },
      { kind: "click", t: 1400, at: { x: 900, y: 300 } },
    ];
    const frames = cameraKeyframes(events, viewport);
    const turn = frames[frames.length - 2]!;
    expect(turn.t).toBe(1000);
    expect(turn.scale).toBe(1.8);
    expect(frames[frames.length - 1]).toEqual({ t: 1400, focus: { x: 900, y: 300 }, scale: 1.8 });
    // Landing later, part way through the ease-out: the turn is from the in-flight state.
    const later = cameraKeyframes([...events.slice(0, 2), { kind: "click", t: 1600, at: { x: 900, y: 300 } }], viewport);
    const mid = later[later.length - 2]!;
    expect(mid.t).toBe(1600 - DEFAULT_ZOOM.zoomInMs);
    expect(mid.scale).toBeGreaterThan(1);
    expect(mid.scale).toBeLessThan(1.8);
    expect(later.every((f, i) => i === 0 || f.t > later[i - 1]!.t)).toBe(true);
  });
  it("stays close through a long quiet stretch: only a reveal zooms out", () => {
    const events: ReadonlyArray<TakeEvent> = [
      { kind: "click", t: 1000, at: { x: 200, y: 300 } },
      { kind: "key", t: 8000, at: { x: 500, y: 300 } },
      { kind: "reveal", t: 8500 },
      { kind: "reveal", t: 9000 },
    ];
    const frames = cameraKeyframes(events, viewport);
    const scales = frames.map((f) => [f.t, f.scale]);
    // Seven seconds of stillness after the click: still close when the key lands, so it pans.
    expect(frames.filter((f) => f.t > 1000 && f.t < 8000 && f.scale === 1)).toEqual([]);
    expect(scales).toContainEqual([8000 - DEFAULT_ZOOM.panMs, 1.8]);
    expect(scales).toContainEqual([8000, 1.8]);
    expect(scales).toContainEqual([8500 + DEFAULT_ZOOM.zoomOutMs, 1]);
    // The second reveal, already wide, adds nothing.
    expect(frames[frames.length - 1]!.t).toBe(8500 + DEFAULT_ZOOM.zoomOutMs);
  });
  it("holds the zoom to the end of a take that never reveals", () => {
    const frames = cameraKeyframes([{ kind: "click", t: 1000, at: { x: 200, y: 300 } }], viewport);
    expect(frames[frames.length - 1]!.scale).toBe(1.8);
  });
  it("is wide throughout a take with no moments", () => {
    expect(cameraKeyframes([], viewport)).toEqual([{ t: 0, focus: { x: 800, y: 450 }, scale: 1 }]);
  });
});

describe("cameraAt", () => {
  const frames = cameraKeyframes(
    [
      { kind: "click", t: 1000, at: { x: 200, y: 300 } },
      { kind: "reveal", t: 4000 },
    ],
    viewport,
  );
  it("holds, eases, and holds", () => {
    expect(cameraAt(frames, 0).scale).toBe(1);
    expect(cameraAt(frames, 1000 - DEFAULT_ZOOM.zoomInMs).scale).toBe(1);
    const mid = cameraAt(frames, 1000 - DEFAULT_ZOOM.zoomInMs / 2);
    expect(mid.scale).toBeCloseTo(1.4, 5);
    expect(mid.focus.x).toBeCloseTo(500, 5);
    expect(cameraAt(frames, 1000).scale).toBe(1.8);
    expect(cameraAt(frames, 1600).scale).toBe(1.8);
    expect(cameraAt(frames, 99999).scale).toBe(1);
    expect(cameraAt([], 5)).toEqual({ focus: { x: 0, y: 0 }, scale: 1 });
  });
});

describe("viewRect", () => {
  it("centres on the focus and stops at the edges", () => {
    expect(viewRect({ focus: { x: 800, y: 450 }, scale: 1 }, viewport)).toEqual({ x: 0, y: 0, width: 1600, height: 900 });
    expect(viewRect({ focus: { x: 800, y: 450 }, scale: 2 }, viewport)).toEqual({ x: 400, y: 225, width: 800, height: 450 });
    expect(viewRect({ focus: { x: 10, y: 10 }, scale: 2 }, viewport)).toEqual({ x: 0, y: 0, width: 800, height: 450 });
    expect(viewRect({ focus: { x: 1590, y: 890 }, scale: 2 }, viewport)).toEqual({ x: 800, y: 450, width: 800, height: 450 });
  });
});

describe("frameAt", () => {
  const frames = [
    { t: 0, file: "0" },
    { t: 100, file: "1" },
    { t: 250, file: "2" },
  ];
  it("finds the latest frame painted at or before t", () => {
    expect(frameAt(frames, 0)?.file).toBe("0");
    expect(frameAt(frames, 99)?.file).toBe("0");
    expect(frameAt(frames, 100)?.file).toBe("1");
    expect(frameAt(frames, 1000)?.file).toBe("2");
    expect(frameAt([{ t: 50, file: "x" }], 0)?.file).toBe("x");
    expect(frameAt([], 0)).toBeUndefined();
  });
});
