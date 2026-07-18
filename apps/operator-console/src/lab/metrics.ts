import { z } from "zod";

import type { LabQueries } from "./queries";
import { bucketHistogram, percentiles } from "./vectors";

const BucketSchema = z.object({ bucket: z.number(), count: z.number() });

export const LabMetricsSchema = z.object({
  attachMix: z.array(
    z.object({
      avgSimilarity: z.number().nullable(),
      count: z.number(),
      method: z.string(),
    }),
  ),
  calibration: z.object({
    pairCount: z.number(),
    percentiles: z.record(z.string(), z.number()),
    suggestedNearDupThreshold: z.number().nullable(),
  }),
  capturedAt: z.string(),
  entriesPerEpisode: z.array(BucketSchema),
  episodesPerStoryline: z.array(BucketSchema),
  similarity: z.array(
    z.object({
      method: z.string(),
      percentiles: z.record(z.string(), z.number()),
    }),
  ),
  singletonEpisodeRate: z.number().nullable(),
  storylineAttachMix: z.array(
    z.object({ count: z.number(), method: z.string() }),
  ),
  syndicationRate: z.number().nullable(),
  topChains: z.array(
    z.object({
      entryCount: z.number(),
      episodeCount: z.number(),
      headline: z.string().nullable(),
      storylineId: z.string(),
    }),
  ),
  volume: z.object({
    cards: z.number(),
    entries: z.number(),
    episodes: z.number(),
    multiEpisodeStorylines: z.number(),
    storylines: z.number(),
  }),
});

export type LabMetrics = z.infer<typeof LabMetricsSchema>;

export type MetricQueries = Pick<
  LabQueries,
  | "attachMix"
  | "contentHashPairCosines"
  | "entriesPerEpisode"
  | "episodesPerStoryline"
  | "similarityByMethod"
  | "storylineAttachMix"
  | "syndicationRate"
  | "topChains"
  | "volume"
>;

export async function snapshotLabMetrics(
  queries: MetricQueries,
  now: () => Date = () => new Date(),
): Promise<LabMetrics> {
  const [
    volume,
    attachMix,
    storylineAttachMix,
    similarity,
    entryCounts,
    episodeCounts,
    syndicationRate,
    pairCosines,
    topChains,
  ] = await Promise.all([
    queries.volume(),
    queries.attachMix(),
    queries.storylineAttachMix(),
    queries.similarityByMethod(),
    queries.entriesPerEpisode(),
    queries.episodesPerStoryline(),
    queries.syndicationRate(),
    queries.contentHashPairCosines(),
    queries.topChains(),
  ]);

  const pairPercentiles = percentiles(pairCosines);
  return {
    attachMix,
    calibration: {
      pairCount: pairCosines.length,
      percentiles: pairPercentiles,
      suggestedNearDupThreshold:
        pairCosines.length === 0
          ? null
          : Number((pairPercentiles.p5! - 0.02).toFixed(3)),
    },
    capturedAt: now().toISOString(),
    entriesPerEpisode: bucketHistogram(entryCounts, 10),
    episodesPerStoryline: bucketHistogram(episodeCounts, 10),
    similarity: similarity.map((row) => ({
      method: row.method,
      percentiles: percentiles(row.values),
    })),
    singletonEpisodeRate:
      entryCounts.length === 0
        ? null
        : Number(
            (
              entryCounts.filter((count) => count === 1).length /
              entryCounts.length
            ).toFixed(4),
          ),
    storylineAttachMix,
    syndicationRate,
    topChains,
    volume,
  };
}
