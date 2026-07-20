import { describe, expect, it } from "vitest";

import { LabMetricsSchema, snapshotLabMetrics } from "../src/lab/metrics";

const fakeQueries = {
  attachMix: async () => [
    { avgSimilarity: 0.91, count: 3, method: "near_dup" },
    { avgSimilarity: null, count: 5, method: "new_cluster" },
  ],
  contentHashPairCosines: async () => [0.95, 0.94, 0.99, 0.97, 0.96],
  entriesPerEpisode: async () => [1, 1, 2, 4, 12],
  episodesPerStoryline: async () => [1, 1, 2],
  similarityByMethod: async () => [
    { method: "near_dup", values: [0.9, 0.92, 0.95] },
  ],
  storylineAttachMix: async () => [{ count: 3, method: "new_storyline" }],
  syndicationRate: async () => 0.25,
  topChains: async () => [
    {
      entryCount: 6,
      episodeCount: 2,
      headline: "Valsatrex recall chain",
      storylineId: "s1",
    },
  ],
  volume: async () => ({
    cards: 4,
    entries: 20,
    episodes: 5,
    multiEpisodeStorylines: 1,
    storylines: 3,
  }),
};

describe("snapshotLabMetrics", () => {
  it("assembles a schema-valid snapshot with calibration suggestion", async () => {
    const metrics = await snapshotLabMetrics(
      fakeQueries,
      () => new Date("2026-07-18T12:00:00Z"),
    );
    expect(LabMetricsSchema.parse(metrics)).toBeTruthy();
    expect(metrics.capturedAt).toBe("2026-07-18T12:00:00.000Z");
    expect(metrics.singletonEpisodeRate).toBeCloseTo(0.4, 5);
    expect(metrics.entriesPerEpisode).toContainEqual({ bucket: 10, count: 1 });
    // p5 of [0.94..0.99] sorted = 0.942 -> minus 0.02 -> 0.922
    expect(metrics.calibration.suggestedNearDupThreshold).toBeCloseTo(0.922, 3);
    expect(metrics.calibration.pairCount).toBe(5);
    expect(metrics.similarity[0]!.percentiles.p50).toBe(0.92);
  });

  it("handles an empty database without NaNs", async () => {
    const metrics = await snapshotLabMetrics({
      ...fakeQueries,
      attachMix: async () => [],
      contentHashPairCosines: async () => [],
      entriesPerEpisode: async () => [],
      episodesPerStoryline: async () => [],
      similarityByMethod: async () => [],
      storylineAttachMix: async () => [],
      syndicationRate: async () => null,
      topChains: async () => [],
      volume: async () => ({
        cards: 0,
        entries: 0,
        episodes: 0,
        multiEpisodeStorylines: 0,
        storylines: 0,
      }),
    });
    expect(metrics.singletonEpisodeRate).toBeNull();
    expect(metrics.calibration.suggestedNearDupThreshold).toBeNull();
    expect(LabMetricsSchema.parse(metrics)).toBeTruthy();
  });
});
