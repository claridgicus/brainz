import { describe, expect, it } from "vitest";
import { TakeClock, capturedAt } from "../src/clock.js";

describe("the take clock", () => {
  it("runs in real time until something is credited", () => {
    const clock = new TakeClock();
    clock.start(1000);
    expect(clock.at(1000)).toBe(0);
    expect(clock.at(1250)).toBe(250);
  });

  it("moves everything after a credit later by the credit, and nothing before it", () => {
    const clock = new TakeClock();
    clock.start(1000);
    clock.credit(3000, 1500);
    expect(clock.at(1499)).toBe(499);
    expect(clock.at(1500)).toBe(3500);
    clock.credit(1000, 2000);
    expect(clock.at(1800)).toBe(3800);
    expect(clock.at(2100)).toBe(5100);
    expect(clock.credited).toBe(4000);
  });

  it("ignores a credit of nothing", () => {
    const clock = new TakeClock();
    clock.start(0);
    clock.credit(0, 10);
    clock.credit(-5, 20);
    expect(clock.credited).toBe(0);
  });
});

describe("a frame's capture time", () => {
  const origin = 1_700_000_000_000;
  it("reads the browser's timestamp onto the performance timeline", () => {
    expect(capturedAt((origin + 5000) / 1000, 5040, origin, 0)).toBe(5000);
  });

  it("falls back to when it arrived when the timestamp is missing or impossible", () => {
    expect(capturedAt(undefined, 5040, origin, 0)).toBe(5040);
    expect(capturedAt((origin + 6000) / 1000, 5040, origin, 0)).toBe(5040);
    expect(capturedAt((origin + 1000) / 1000, 5040, origin, 4000)).toBe(5040);
  });
});
