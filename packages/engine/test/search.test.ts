import { describe, expect, it } from "vitest";
import { cosineSim, packVector, rrfFuse, unpackVector } from "../src/search.js";

const id = (s: string): string => s;

describe("rrfFuse", () => {
  it("fuses two ranked lists with reciprocal-rank scores (k = 60)", () => {
    const fused = rrfFuse(["a", "b"], ["b", "c"], id);
    expect(fused.map((e) => e.item)).toEqual(["b", "a", "c"]);
    const scores = Object.fromEntries(fused.map((e) => [e.item, e.score]));
    expect(scores.a).toBeCloseTo(1 / 61, 10);
    expect(scores.b).toBeCloseTo(1 / 62 + 1 / 61, 10);
    expect(scores.c).toBeCloseTo(1 / 62, 10);
  });

  it("breaks score ties deterministically by id", () => {
    // a and b appear at mirrored ranks, so their scores tie exactly.
    const fused = rrfFuse(["b", "a"], ["a", "b"], id);
    expect(fused.map((e) => e.item)).toEqual(["a", "b"]);
  });

  it("keeps the first-seen item for each id and respects a custom k", () => {
    type Hit = { key: string; label: string };
    const a: Hit[] = [{ key: "x", label: "from-a" }];
    const b: Hit[] = [{ key: "x", label: "from-b" }];
    const fused = rrfFuse(a, b, (h) => h.key, 1);
    expect(fused).toHaveLength(1);
    expect(fused[0].item.label).toBe("from-a");
    expect(fused[0].score).toBeCloseTo(1 / 2 + 1 / 2, 10);
  });

  it("handles empty lists", () => {
    expect(rrfFuse([], [], id)).toEqual([]);
    expect(rrfFuse(["a"], [], id).map((e) => e.item)).toEqual(["a"]);
  });
});

describe("cosineSim", () => {
  it("computes similarity for identical, orthogonal and opposite vectors", () => {
    const a = Float32Array.from([1, 2, 3]);
    expect(cosineSim(a, a)).toBeCloseTo(1, 6);
    expect(
      cosineSim(Float32Array.from([1, 0]), Float32Array.from([0, 1])),
    ).toBeCloseTo(0, 6);
    expect(
      cosineSim(Float32Array.from([1, 0]), Float32Array.from([-1, 0])),
    ).toBeCloseTo(-1, 6);
  });

  it("returns 0 when either vector has zero norm", () => {
    expect(cosineSim(Float32Array.from([0, 0]), Float32Array.from([1, 1]))).toBe(0);
    expect(cosineSim(Float32Array.from([1, 1]), new Float32Array(0))).toBe(0);
  });
});

describe("packVector / unpackVector", () => {
  it("round-trips exactly", () => {
    const vec = Float32Array.from([0.25, -1.5, 3.75, 1e-8, 123456.5]);
    const packed = packVector(vec);
    expect(packed.byteLength).toBe(vec.length * 4);
    expect([...unpackVector(packed)]).toEqual([...vec]);
  });

  it("unpacks from an ArrayBuffer (async D1-style blobs)", () => {
    const vec = Float32Array.from([1, 2, 3]);
    const packed = packVector(vec);
    const ab = packed.buffer.slice(packed.byteOffset, packed.byteOffset + packed.byteLength);
    expect([...unpackVector(ab as ArrayBuffer)]).toEqual([1, 2, 3]);
  });

  it("copies when the byte view is not 4-byte aligned", () => {
    const vec = Float32Array.from([7, -8]);
    const packed = packVector(vec);
    // Re-house the bytes at an odd offset inside a larger buffer.
    const raw = new Uint8Array(packed.byteLength + 1);
    raw.set(packed, 1);
    const unaligned = new Uint8Array(raw.buffer, 1, packed.byteLength);
    expect([...unpackVector(unaligned)]).toEqual([7, -8]);
  });
});
