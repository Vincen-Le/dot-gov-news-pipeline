import { describe, expect, it } from "vitest";

import {
  bucketHistogram,
  cosine,
  percentiles,
  unpackFp16,
} from "../src/lab/vectors";

describe("fp16 vectors", () => {
  it("decodes little-endian half floats", () => {
    // 0x3c00 = 1.0, 0xbc00 = -1.0, 0x3800 = 0.5 (little-endian byte pairs)
    const raw = new Uint8Array([0x00, 0x3c, 0x00, 0xbc, 0x00, 0x38]);
    expect(unpackFp16(raw)).toEqual([1, -1, 0.5]);
  });

  it("computes cosine with zero-norm and mismatch guards", () => {
    expect(cosine([1, 0], [1, 0])).toBe(1);
    expect(cosine([1, 0], [0, 1])).toBe(0);
    expect(cosine([1, 0], [0, 0])).toBe(0);
    expect(cosine([1, 0], [1])).toBe(0);
  });
});

describe("percentiles", () => {
  it("interpolates linearly like numpy", () => {
    const p = percentiles(Array.from({ length: 100 }, (_, i) => i + 1));
    expect(p.p50).toBe(50.5);
    expect(p.p5).toBeLessThan(p.p95 ?? Number.NaN);
  });

  it("returns empty object for no values", () => {
    expect(percentiles([])).toEqual({});
  });
});

describe("bucketHistogram", () => {
  it("clamps to the cap and counts ascending buckets", () => {
    expect(bucketHistogram([1, 1, 2, 12], 10)).toEqual([
      { bucket: 1, count: 2 },
      { bucket: 2, count: 1 },
      { bucket: 10, count: 1 },
    ]);
  });
});
