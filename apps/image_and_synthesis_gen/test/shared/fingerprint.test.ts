import { describe, expect, it } from "vitest";

import {
  canonicalJson,
  fingerprint,
  partitionFor,
} from "../../src/shared/fingerprint.js";

describe("stable fingerprinting", () => {
  it("sorts object keys recursively without reordering arrays", () => {
    const left = { a: [{ y: 2, x: 1 }], b: "value" };
    const right = { b: "value", a: [{ x: 1, y: 2 }] };
    expect(canonicalJson(left)).toBe(canonicalJson(right));
    expect(fingerprint(left)).toBe(fingerprint(right));
  });

  it("assigns the same sha256 to the same deterministic partition", () => {
    const hash = fingerprint({ stable: true });
    expect(partitionFor(hash, 16)).toBe(partitionFor(hash, 16));
    expect(partitionFor(hash, 16)).toBeGreaterThanOrEqual(0);
    expect(partitionFor(hash, 16)).toBeLessThan(16);
  });
});
