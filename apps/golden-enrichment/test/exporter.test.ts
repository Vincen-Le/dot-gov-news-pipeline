import { describe, expect, it } from "vitest";

import { assertExpectedTasksStillCurrent } from "../src/exporter.js";

const current = [
  { eventCardId: "card-a", inputHash: "a".repeat(64) },
  { eventCardId: "card-b", inputHash: "b".repeat(64) },
];

describe("publish-time hosted revalidation", () => {
  it("accepts an exported task only while its card identity and input hash remain current", () => {
    expect(() =>
      assertExpectedTasksStillCurrent(current, [current[0]!]),
    ).not.toThrow();
  });

  it("rejects a card that stopped being eligible", () => {
    expect(() =>
      assertExpectedTasksStillCurrent(current, [
        { eventCardId: "card-c", inputHash: "c".repeat(64) },
      ]),
    ).toThrow("is no longer eligible");
  });

  it("rejects a card whose trusted input changed after export", () => {
    expect(() =>
      assertExpectedTasksStillCurrent(current, [
        { eventCardId: "card-a", inputHash: "c".repeat(64) },
      ]),
    ).toThrow("changed after");
  });
});
