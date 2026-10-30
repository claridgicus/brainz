import { describe, expect, it } from "vitest";
import { CANVAS, VIEWPORT, magnification, project, windowRadius, windowRect } from "../src/layout.js";

describe("windowRect", () => {
  it("bleeds edge to edge, or sits centred with a margin at the viewport's aspect", () => {
    expect(windowRect("bleed")).toEqual({ x: 0, y: 0, width: 1920, height: 1080 });
    const backdrop = windowRect("backdrop");
    expect(backdrop.y).toBe(81);
    expect(backdrop.height).toBe(1080 - 162);
    expect(backdrop.width / backdrop.height).toBeCloseTo(VIEWPORT.width / VIEWPORT.height, 2);
    expect(backdrop.x).toBe(Math.round((CANVAS.width - backdrop.width) / 2));
    expect(windowRadius("bleed")).toBe(0);
    expect(windowRadius("backdrop")).toBeGreaterThan(0);
  });
});

describe("project", () => {
  const window = { x: 100, y: 50, width: 800, height: 450 };
  it("maps a viewport point through the camera's view into the window", () => {
    const whole = { x: 0, y: 0, width: 1600, height: 900 };
    expect(project({ x: 0, y: 0 }, whole, window)).toEqual({ x: 100, y: 50 });
    expect(project({ x: 1600, y: 900 }, whole, window)).toEqual({ x: 900, y: 500 });
    const zoomed = { x: 400, y: 225, width: 800, height: 450 };
    expect(project({ x: 800, y: 450 }, zoomed, window)).toEqual({ x: 500, y: 275 });
    expect(magnification(whole, window)).toBe(0.5);
    expect(magnification(zoomed, window)).toBe(1);
  });
});
