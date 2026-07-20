import { describe, expect, it } from "vitest";

import {
  articleOverviewCoverage,
  assertExpectedTasksStillCurrent,
  synthesisCardKindFilter,
} from "../../src/shared/exporter.js";
import { type OverviewTask } from "../../src/shared/types.js";

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

describe("article synthesis coverage", () => {
  const task = (eventCardId: string, inputHash: string): OverviewTask =>
    ({ eventCardId, inputHash }) as OverviewTask;

  it("recognizes exact v2 rows across overview and episode task identities", () => {
    const tasks = [
      task("card-a", "a".repeat(64)),
      task("card-b", "b".repeat(64)),
    ];
    const coverage = articleOverviewCoverage(tasks, [
      {
        enrichment_version: 2,
        event_card_id: "card-a",
        input_hash: "a".repeat(64),
        prompt_version: 2,
      },
      {
        enrichment_version: 2,
        event_card_id: "card-b",
        input_hash: "b".repeat(64),
        prompt_version: 2,
      },
    ]);
    expect([...coverage.currentCardIds]).toEqual(["card-a", "card-b"]);
    expect(coverage.staleCurrentCardIds.size).toBe(0);
  });

  it("does not treat v1 or stale v2 rows as current coverage", () => {
    const tasks = [
      task("card-a", "a".repeat(64)),
      task("card-b", "b".repeat(64)),
    ];
    const coverage = articleOverviewCoverage(tasks, [
      {
        enrichment_version: 1,
        event_card_id: "card-a",
        input_hash: "a".repeat(64),
        prompt_version: 1,
      },
      {
        enrichment_version: 2,
        event_card_id: "card-b",
        input_hash: "c".repeat(64),
        prompt_version: 2,
      },
    ]);
    expect(coverage.currentCardIds.size).toBe(0);
    expect([...coverage.staleCurrentCardIds]).toEqual(["card-b"]);
  });
});

describe("synthesis card-kind scope", () => {
  it("keeps overview-only as the safe image-workflow default", () => {
    expect(synthesisCardKindFilter(undefined)).toEqual({
      cardKinds: ["overview"],
      filter: "eq.overview",
    });
  });

  it("selects every historical overview and episode snapshot explicitly", () => {
    expect(synthesisCardKindFilter(["overview", "episode"])).toEqual({
      cardKinds: ["episode", "overview"],
      filter: "in.(episode,overview)",
    });
  });
});
