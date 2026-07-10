/** A fused ranking entry: the first-seen item for an id plus its RRF score. */
export interface FusedResult<T> {
  item: T;
  score: number;
}

/**
 * Reciprocal rank fusion of two ranked lists. Items are keyed by `idOf`;
 * each list position contributes 1 / (k + rank + 1). Results are sorted by
 * fused score descending, ties broken by id ascending (deterministic).
 */
export function rrfFuse<T>(a: T[], b: T[], idOf: (item: T) => string, k = 60): FusedResult<T>[] {
  const fused = new Map<string, FusedResult<T>>();
  for (const list of [a, b]) {
    list.forEach((item, i) => {
      const id = idOf(item);
      const entry = fused.get(id) ?? { item, score: 0 };
      entry.score += 1 / (k + i + 1);
      fused.set(id, entry);
    });
  }
  return [...fused.values()].sort(
    (x, y) => y.score - x.score || idOf(x.item).localeCompare(idOf(y.item)),
  );
}

/** Cosine similarity of two vectors (0 when either has zero norm). */
export function cosineSim(a: Float32Array, b: Float32Array): number {
  const n = Math.min(a.length, b.length);
  let dot = 0;
  let na = 0;
  let nb = 0;
  for (let i = 0; i < n; i++) {
    dot += a[i] * b[i];
    na += a[i] * a[i];
    nb += b[i] * b[i];
  }
  if (na === 0 || nb === 0) return 0;
  return dot / (Math.sqrt(na) * Math.sqrt(nb));
}

/** Pack a Float32Array into a little-endian byte view suitable for BLOB storage (no copy). */
export function packVector(vec: Float32Array): Uint8Array {
  return new Uint8Array(vec.buffer, vec.byteOffset, vec.byteLength);
}

/**
 * Unpack a BLOB (Uint8Array/Buffer view or ArrayBuffer) back into a
 * Float32Array. Returns a view when the input is 4-byte aligned, otherwise a
 * copy.
 */
export function unpackVector(blob: Uint8Array | ArrayBuffer): Float32Array {
  if (blob instanceof ArrayBuffer) {
    return new Float32Array(blob, 0, Math.floor(blob.byteLength / 4));
  }
  if (blob.byteOffset % 4 === 0 && blob.byteLength % 4 === 0) {
    return new Float32Array(blob.buffer, blob.byteOffset, blob.byteLength / 4);
  }
  const copy = new Uint8Array(blob); // copies into a fresh, aligned buffer
  return new Float32Array(copy.buffer, 0, Math.floor(copy.byteLength / 4));
}
