import { describe, expect, it } from "vitest";

import { assertImmutableInputHashes } from "../../src/legacy/publisher.js";

const expected = new Map([["card-a", "a".repeat(64)]]);

describe("immutable serving-row preflight", () => {
  it("accepts an idempotent retry with the same input hash", () => {
    expect(() =>
      assertImmutableInputHashes(
        "example",
        [{ event_card_id: "card-a", input_hash: "a".repeat(64) }],
        expected,
      ),
    ).not.toThrow();
  });

  it("rejects reuse of a card ID for different trusted input", () => {
    expect(() =>
      assertImmutableInputHashes(
        "example",
        [{ event_card_id: "card-a", input_hash: "b".repeat(64) }],
        expected,
      ),
    ).toThrow("already contains a different input hash");
  });
});
