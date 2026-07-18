import { describe, expect, it } from "vitest";

import {
  BorderlinePairSchema,
  CorpusSummarySchema,
  EventCardSchema,
  ExperimentRunSchema,
  StorylineDetailSchema,
  StorylineListItemSchema,
  labResponse,
} from "../src/lab/contracts";

describe("lab contracts", () => {
  it("parses a corpus summary with prepare coverage", () => {
    const parsed = CorpusSummarySchema.parse({
      agencies: [{ agency: "fda.gov", entries: 120 }],
      clustered: 100,
      embedded: 120,
      enriched: 110,
      entries: 130,
      extracted: 130,
      firstPublishedAt: "2026-01-02T00:00:00.000Z",
      lastPublishedAt: "2026-07-01T00:00:00.000Z",
      needsPrepare: 10,
      sources: 20,
    });
    expect(parsed.needsPrepare).toBe(10);
  });

  it("parses a storyline list item and detail with cited timeline", () => {
    const item = StorylineListItemSchema.parse({
      agencies: ["fda.gov"],
      distinctFeeds: 2,
      entities: ["valsatrex"],
      entryCount: 5,
      episodeCount: 2,
      eventKeys: ["z-2026-0143"],
      firstEntryAt: "2026-05-14T14:00:00.000Z",
      headline: "FDA recalls Valsatrex",
      id: "00000000-0000-4000-8000-000000000021",
      newestEntryAt: "2026-05-17T15:00:00.000Z",
    });
    const detail = StorylineDetailSchema.parse({
      ...item,
      episodes: [
        {
          adjudicatorModel: null,
          attachMethod: "new_storyline",
          attachReason: null,
          attachSimilarity: null,
          card: null,
          entitySet: ["valsatrex"],
          entries: [
            {
              agency: "fda.gov",
              attachMethod: "new_cluster",
              entitySet: ["valsatrex"],
              eventKeys: [],
              id: "00000000-0000-4000-8000-000000000011",
              isSyndicated: false,
              matchedEntryId: null,
              publishedAt: "2026-05-14T14:00:00.000Z",
              similarity: null,
              thresholdUsed: null,
              title: "FDA recalls Valsatrex",
              url: "https://fda.gov/a",
            },
          ],
          entryCount: 1,
          eventKeys: [],
          firstEntryAt: "2026-05-14T14:00:00.000Z",
          id: "00000000-0000-4000-8000-000000000031",
          newestEntryAt: "2026-05-14T14:00:00.000Z",
          status: "dormant",
        },
      ],
      overviewCards: [
        EventCardSchema.parse({
          generatedAt: "2026-05-17T15:00:00.000Z",
          headline: "Valsatrex recall chain",
          id: "00000000-0000-4000-8000-000000000042",
          interestReason: null,
          judgeModel: "stub",
          kind: "overview",
          rankKey: 5.2,
          rubric: { urgency: 1 },
          summary: "Recall then expansion.",
          supersededBy: null,
          timeline: [
            {
              cited: true,
              date: "2026-05-14",
              episodeId: "00000000-0000-4000-8000-000000000031",
              text: "Recall announced",
            },
          ],
          version: 2,
        }),
      ],
    });
    expect(detail.overviewCards[0]!.timeline?.[0]!.cited).toBe(true);
  });

  it("parses an experiment run with pipeline-side snake_case payloads", () => {
    const run = ExperimentRunSchema.parse({
      cacheHits: 12,
      cacheMisses: 3,
      clusterReport: { episodes_closed: 420, processed: 1000 },
      config: { enrichment_enabled: true, near_dup_threshold: 0.9 },
      createdAt: "2026-07-18T12:00:05.000Z",
      durationSeconds: 42.5,
      finishedAt: "2026-07-18T12:00:42.500Z",
      id: "00000000-0000-4000-8000-0000000000a1",
      name: "baseline",
      startedAt: "2026-07-18T12:00:00.000Z",
      summary: {
        cards: 460,
        entries_clustered: 1000,
        entry_attach_mix: { content_hash: 40, new_cluster: 380 },
        episode_attach_mix: { new_storyline: 380 },
        episodes: 420,
        extra_future_key: "tolerated",
        multi_episode_storylines: 31,
        singleton_episode_rate: 0.62,
        storylines: 380,
        top_chains: [{ episodes: 4, headline: "Valsatrex recall widens" }],
      },
    });
    expect(run.summary?.entry_attach_mix.content_hash).toBe(40);
    expect(run.durationSeconds).toBe(42.5);
  });

  it("wraps payloads in the data envelope", () => {
    const parsed = labResponse(BorderlinePairSchema.array()).parse({
      data: [
        {
          attachMethod: "near_dup",
          entryId: "a",
          entryTitle: "t",
          matchedEntryId: "b",
          matchedTitle: "t2",
          similarity: 0.905,
          thresholdUsed: 0.9,
        },
      ],
    });
    expect(parsed.data).toHaveLength(1);
  });
});
