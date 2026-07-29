import type { SupabaseClient } from "@supabase/supabase-js";
import { describe, expect, it } from "vitest";

import { createDemoRepositoryFromClient } from "../src/repository";

type Row = Record<string, unknown>;
type Tables = Record<string, Row[]>;

class FakeQuery implements PromiseLike<{ data: unknown; error: null }> {
  private maximum = Number.POSITIVE_INFINITY;
  private readonly predicates: Array<(row: Row) => boolean> = [];
  private ordering: { ascending: boolean; field: string } | null = null;

  constructor(private readonly source: Row[]) {}

  select(): this {
    return this;
  }

  eq(field: string, value: unknown): this {
    this.predicates.push((row) => row[field] === value);
    return this;
  }

  is(field: string, value: unknown): this {
    return this.eq(field, value);
  }

  not(field: string, operator: string, value: unknown): this {
    if (operator !== "is") throw new Error("Unsupported fake operator");
    this.predicates.push((row) => row[field] !== value);
    return this;
  }

  in(field: string, values: readonly unknown[]): this {
    const allowed = new Set(values);
    this.predicates.push((row) => allowed.has(row[field]));
    return this;
  }

  order(field: string, options?: { ascending?: boolean }): this {
    this.ordering = { ascending: options?.ascending ?? true, field };
    return this;
  }

  limit(value: number): this {
    this.maximum = value;
    return this;
  }

  async maybeSingle(): Promise<{ data: Row | null; error: null }> {
    return { data: this.result()[0] ?? null, error: null };
  }

  then<TResult1 = { data: unknown; error: null }, TResult2 = never>(
    onfulfilled?:
      | ((value: {
          data: unknown;
          error: null;
        }) => TResult1 | PromiseLike<TResult1>)
      | null,
    onrejected?: ((reason: unknown) => TResult2 | PromiseLike<TResult2>) | null,
  ): PromiseLike<TResult1 | TResult2> {
    return Promise.resolve({ data: this.result(), error: null }).then(
      onfulfilled,
      onrejected,
    );
  }

  private result(): Row[] {
    const filtered = this.source.filter((row) =>
      this.predicates.every((predicate) => predicate(row)),
    );
    if (this.ordering !== null) {
      const { ascending, field } = this.ordering;
      filtered.sort((left, right) => {
        const comparison = String(left[field] ?? "").localeCompare(
          String(right[field] ?? ""),
        );
        return ascending ? comparison : -comparison;
      });
    }
    return filtered.slice(0, this.maximum);
  }
}

function client(tables: Tables): SupabaseClient {
  return {
    from: (table: string) => new FakeQuery(tables[table] ?? []),
  } as unknown as SupabaseClient;
}

const storylineId = "00000000-0000-4000-8000-000000000021";
const episodeId = "00000000-0000-4000-8000-000000000031";
const entryId = "00000000-0000-4000-8000-000000000011";
const cardId = "00000000-0000-4000-8000-000000000041";
const secondCardId = "00000000-0000-4000-8000-000000000042";
const categoryId = "00000000-0000-4000-8000-000000000051";
const themeId = "00000000-0000-4000-8000-000000000061";
const sourceId = "00000000-0000-4000-8000-000000000071";
const runId = "00000000-0000-4000-8000-000000000081";
const imageId = "00000000-0000-4000-8000-000000000091";
const missingImageId = "00000000-0000-4000-8000-000000000099";

function fixtures(entryCount = 1): Tables {
  return {
    golden_event_card_article_overviews: [
      {
        article_overview: {
          keyDetails: [
            { sourceEntryIds: [entryId], text: "One supported detail." },
            { sourceEntryIds: [entryId], text: "A second supported detail." },
            { sourceEntryIds: [entryId], text: "A third supported detail." },
          ],
          whatChangedAcrossUpdates: {
            sourceEntryIds: [entryId],
            text: "The reviewed update added a new agency action.",
          },
          whatRemainsUnresolved: null,
          whatSourcesEstablish: {
            sourceEntryIds: [entryId],
            text: "The reviewed source establishes the agency action.",
          },
        },
        event_card_id: cardId,
      },
    ],
    golden_event_cards: [
      {
        episode_id: null,
        generated_at: "2025-07-20T18:00:00.000Z",
        headline: "FDA issues a reviewed public-health update",
        id: cardId,
        interest_reason: "The action affects consumers nationwide.",
        kind: "overview",
        newest_entry_at: "2025-07-20T12:00:00.000Z",
        rank_key: 9.5,
        source_run_id: runId,
        storyline_id: storylineId,
        summary: "A concise reviewed summary.",
        timeline: [
          {
            date: "2025-07-20",
            episode_id: episodeId,
            text: "FDA issued a concise reviewed public-health update.",
          },
        ],
        version: 1,
      },
    ],
    golden_storyline_thumbnails: [
      {
        image_id: imageId,
        storyline_id: storylineId,
      },
    ],
    golden_storyline_explorer_nodes: [
      {
        generated_at: "2025-07-21T12:00:00.000Z",
        neighbors: [],
        projection_version: "projection-1",
        rank_percentile: 1,
        storyline_id: storylineId,
        x: 120,
        y: -80,
      },
    ],
    images: [
      {
        alt_text: "Geometric editorial illustration of the agency action.",
        card_mime_type: "image/webp",
        focal_x: "0.4",
        focal_y: "0.6",
        id: imageId,
        r2_card_key: `golden/storylines/${storylineId}/card.webp`,
      },
    ],
    golden_news_entries: [
      {
        gold_episode_id: episodeId,
        gold_storyline_id: storylineId,
        is_syndicated: false,
        news_entry_id: entryId,
        review_status: "reviewed",
        reviewed_at: "2025-07-21T12:00:00.000Z",
      },
    ],
    golden_episodes: [
      {
        attach_method: "new_storyline",
        attach_reason: null,
        entry_count: 1,
        first_entry_at: "2025-07-20T12:00:00.000Z",
        id: episodeId,
        newest_entry_at: "2025-07-20T12:00:00.000Z",
        status: "dormant",
        storyline_id: storylineId,
      },
    ],
    golden_storylines: [
      {
        agency_ids: ["fda"],
        category_id: categoryId,
        distinct_feeds: 1,
        entity_set: ["FDA"],
        entry_count: entryCount,
        episode_count: 1,
        event_keys: [],
        first_entry_at: "2025-07-20T12:00:00.000Z",
        id: storylineId,
        latest_card_id: cardId,
        merged_into: null,
        newest_entry_at: "2025-07-20T12:00:00.000Z",
        theme_id: themeId,
      },
    ],
    golden_topic_categories: [
      {
        display_name: "Public Health",
        id: categoryId,
        origin: "seed",
        proposal_reason: null,
      },
    ],
    golden_topic_themes: [
      {
        category_id: categoryId,
        display_name: "Food safety",
        first_storyline_at: "2025-07-20T12:00:00.000Z",
        id: themeId,
        merged_into: null,
        name_model: "golden-human",
        newest_storyline_at: "2025-07-20T12:00:00.000Z",
      },
    ],
    news_entries: [
      {
        entity_set: ["FDA"],
        event_keys: [],
        id: entryId,
        news_source_id: sourceId,
        published_at: "2025-07-20T12:00:00.000Z",
        title: "FDA source announcement",
        url: "https://www.fda.gov/example",
      },
    ],
    news_source_publishers: [
      { news_source_id: sourceId, publisher_key: "fda" },
    ],
    simple_v1_experiment_runs: [
      { config: {}, id: runId, name: "canonical-golden" },
    ],
    simple_v1_rank_snapshots: [
      {
        agencies: 1,
        card_id: cardId,
        entry_count: 1,
        facet_key: "",
        facet_type: "global",
        feeds: 1,
        headline: "FDA issues a reviewed public-health update",
        interest_reason: null,
        newest_entry_at: "2025-07-20T12:00:00.000Z",
        position: 1,
        rank_key: 9.5,
        run_id: runId,
        storyline_id: storylineId,
        summary: "A concise reviewed summary.",
        terms: {
          agency_term: 0.2,
          feed_term: 0,
          freshness_term: 8,
          prior_used: false,
          rubric_points: 1,
          source_key: "fda",
          source_term: 0.3,
        },
      },
    ],
  };
}

describe("demo repository", () => {
  it("builds the public storyline, taxonomy, detail, and ranking contracts", async () => {
    const repository = createDemoRepositoryFromClient(client(fixtures()));

    const storylines = await repository.listStorylines(18);
    expect(storylines.items[0]).toMatchObject({
      categoryName: "Public Health",
      firstOverviewAt: "2025-07-20T12:00:00.000Z",
      headline: "FDA issues a reviewed public-health update",
      rankHistory: [
        {
          newestEntryAt: "2025-07-20T12:00:00.000Z",
          rankKey: 9.5,
          version: 1,
        },
      ],
      themeName: "Food safety",
      unreviewedEntryCount: 0,
    });
    expect(await repository.listAgencies()).toEqual([
      { displayName: "Food and Drug Administration", key: "fda" },
    ]);
    expect((await repository.listThemes())[0]).toMatchObject({
      firstStorylineAt: "2025-07-20T12:00:00.000Z",
      manuallySet: true,
    });
    const bootstrap = await repository.getBootstrap(18);
    expect(bootstrap).toMatchObject({
      agencies: [{ displayName: "Food and Drug Administration", key: "fda" }],
      categories: [{ displayName: "Public Health", storylineCount: 1 }],
      storylines: { hasMore: false, items: [{ id: storylineId }] },
      themes: [{ displayName: "Food safety", storylineCount: 1 }],
    });
    expect(bootstrap.previews).toEqual([
      expect.objectContaining({
        overviewCards: [
          expect.objectContaining({
            id: cardId,
            thumbnail: expect.objectContaining({
              cardUrl: `/api/lab/assets/images/${imageId}/card`,
            }),
          }),
        ],
        storylineId,
      }),
    ]);

    const detail = await repository.getStoryline(storylineId);
    expect(detail?.episodes[0]?.entries[0]).toMatchObject({
      agency: "fda",
      title: "FDA source announcement",
    });
    expect(detail?.overviewCards[0]).toMatchObject({
      articleOverview: {
        keyPoints: [
          { sourceEntryIds: [entryId], text: "One supported detail." },
          { sourceEntryIds: [entryId], text: "A second supported detail." },
          { sourceEntryIds: [entryId], text: "A third supported detail." },
        ],
        summary: {
          sourceEntryIds: [entryId],
          text: "The reviewed source establishes the agency action.",
        },
      },
      id: cardId,
      newestEntryAt: "2025-07-20T12:00:00.000Z",
      thumbnail: {
        altText: "Geometric editorial illustration of the agency action.",
        cardUrl: `/api/lab/assets/images/${imageId}/card`,
        focalX: 0.4,
        focalY: 0.6,
      },
      timeline: [
        {
          date: "2025-07-20",
          episodeId,
          text: "FDA issued a concise reviewed public-health update.",
        },
      ],
    });
    expect(detail?.overviewCards[0]?.articleOverview).not.toHaveProperty(
      "whatChangedAcrossUpdates",
    );
    expect(detail?.overviewCards[0]?.articleOverview).not.toHaveProperty(
      "whatRemainsUnresolved",
    );
    expect(await repository.getThumbnailAsset(imageId)).toEqual({
      key: `golden/storylines/${storylineId}/card.webp`,
      mimeType: "image/webp",
    });

    expect(await repository.getRankOverview()).toMatchObject({
      dataset: { reviewedEntries: 1, sourceRunName: "canonical-golden" },
    });
    expect(
      await repository.listRankRows({
        agency: "fda",
        asOf: "2025-07-20",
        limit: 25,
      }),
    ).toEqual([
      expect.objectContaining({
        sourceName: "Food and Drug Administration",
        storylineId,
      }),
    ]);
  });

  it("serves only reviewed nodes from one explorer projection", async () => {
    const repository = createDemoRepositoryFromClient(client(fixtures()));

    await expect(repository.getExplorer()).resolves.toEqual({
      coverage: { mapped: 1, reviewed: 1 },
      generatedAt: "2025-07-21T12:00:00.000Z",
      nodes: [
        {
          neighbors: [],
          rankPercentile: 1,
          storylineId,
          x: 120,
          y: -80,
        },
      ],
      version: "projection-1",
    });
  });

  it("fails closed when the explorer projection misses a reviewed storyline", async () => {
    const tables = fixtures();
    tables.golden_storyline_explorer_nodes = [];
    const repository = createDemoRepositoryFromClient(client(tables));

    await expect(repository.getExplorer()).rejects.toThrow(
      "maps 0/1 reviewed storylines",
    );
  });

  it("uses the latest overview card available on the requested date", async () => {
    const tables = fixtures();
    tables.golden_event_cards?.push({
      ...tables.golden_event_cards[0],
      generated_at: "2025-07-21T18:00:00.000Z",
      headline: "FDA issues a later reviewed update",
      id: secondCardId,
      newest_entry_at: "2025-07-21T12:00:00.000Z",
      rank_key: 12,
      version: 2,
    });
    Object.assign(tables.golden_storylines?.[0] ?? {}, {
      latest_card_id: secondCardId,
      newest_entry_at: "2025-07-21T12:00:00.000Z",
    });
    Object.assign(tables.simple_v1_rank_snapshots?.[0] ?? {}, {
      card_id: secondCardId,
      headline: "FDA issues a later reviewed update",
      newest_entry_at: "2025-07-21T12:00:00.000Z",
      rank_key: 12,
    });
    const repository = createDemoRepositoryFromClient(client(tables));

    expect(
      await repository.listRankRows({ asOf: "2025-07-20", limit: 25 }),
    ).toEqual([
      expect.objectContaining({
        agencies: null,
        entryCount: null,
        feeds: null,
        headline: "FDA issues a reviewed public-health update",
        newestEntryAt: "2025-07-20T12:00:00.000Z",
        rankKey: 9.5,
        terms: null,
      }),
    ]);
  });

  it("selects and orders date-eligible cards before applying the limit", async () => {
    const tables = fixtures();
    const futureStorylineId = "00000000-0000-4000-8000-000000000022";
    const futureCardId = "00000000-0000-4000-8000-000000000043";
    const futureEntryId = "00000000-0000-4000-8000-000000000012";
    tables.golden_storylines?.push({
      ...tables.golden_storylines[0],
      id: futureStorylineId,
      latest_card_id: futureCardId,
      newest_entry_at: "2025-07-21T12:00:00.000Z",
    });
    tables.golden_event_cards?.push({
      ...tables.golden_event_cards[0],
      headline: "Future top-ranked story",
      id: futureCardId,
      newest_entry_at: "2025-07-21T12:00:00.000Z",
      rank_key: 20,
      storyline_id: futureStorylineId,
    });
    tables.golden_news_entries?.push({
      ...tables.golden_news_entries[0],
      gold_storyline_id: futureStorylineId,
      news_entry_id: futureEntryId,
    });
    tables.simple_v1_rank_snapshots?.push({
      ...tables.simple_v1_rank_snapshots[0],
      card_id: futureCardId,
      headline: "Future top-ranked story",
      newest_entry_at: "2025-07-21T12:00:00.000Z",
      position: 1,
      rank_key: 20,
      storyline_id: futureStorylineId,
    });
    Object.assign(tables.simple_v1_rank_snapshots?.[0] ?? {}, { position: 2 });
    const repository = createDemoRepositoryFromClient(client(tables));

    expect(
      await repository.listRankRows({ asOf: "2025-07-20", limit: 1 }),
    ).toEqual([
      expect.objectContaining({
        headline: "FDA issues a reviewed public-health update",
        position: 1,
        storylineId,
      }),
    ]);
  });

  it("fails closed when the golden storyline contains an unreviewed membership", async () => {
    const repository = createDemoRepositoryFromClient(client(fixtures(2)));

    expect((await repository.listStorylines(18)).items).toEqual([]);
    expect(await repository.getStoryline(storylineId)).toBeNull();
  });

  it("keeps generated card content nullable when exact card rows are absent", async () => {
    const tables = fixtures();
    tables.golden_event_card_article_overviews = [];
    tables.golden_storyline_thumbnails = [];
    const repository = createDemoRepositoryFromClient(client(tables));

    expect(
      (await repository.getStoryline(storylineId))?.overviewCards[0],
    ).toMatchObject({
      articleOverview: null,
      id: cardId,
      thumbnail: null,
    });
    expect(await repository.getThumbnailAsset(missingImageId)).toBeNull();
  });

  it("resolves every card version through the storyline thumbnail", async () => {
    const tables = fixtures();
    tables.golden_event_cards?.push({
      ...tables.golden_event_cards[0],
      generated_at: "2025-07-21T18:00:00.000Z",
      id: secondCardId,
      newest_entry_at: "2025-07-21T12:00:00.000Z",
      version: 2,
    });
    const repository = createDemoRepositoryFromClient(client(tables));

    const detail = await repository.getStoryline(storylineId);
    expect(detail?.overviewCards).toHaveLength(2);
    expect(
      detail?.overviewCards.map((card) => card.thumbnail?.altText),
    ).toEqual([
      "Geometric editorial illustration of the agency action.",
      "Geometric editorial illustration of the agency action.",
    ]);
    expect(await repository.getThumbnailAsset(imageId)).toEqual({
      key: `golden/storylines/${storylineId}/card.webp`,
      mimeType: "image/webp",
    });
  });

  it("accepts the v2 synthesis shape with two distinct key points", async () => {
    const tables = fixtures();
    tables.golden_event_card_article_overviews = [
      {
        article_overview: {
          keyPoints: [
            {
              sourceEntryIds: [entryId],
              text: "The notice applies to the named products.",
            },
            {
              sourceEntryIds: [entryId],
              text: "Consumers can check the published product list.",
            },
          ],
          summary: {
            sourceEntryIds: [entryId],
            text: "The FDA published a reviewed consumer notice.",
          },
        },
        event_card_id: cardId,
      },
    ];
    const repository = createDemoRepositoryFromClient(client(tables));

    expect(
      (await repository.getStoryline(storylineId))?.overviewCards[0]
        ?.articleOverview,
    ).toEqual({
      keyPoints: [
        {
          sourceEntryIds: [entryId],
          text: "The notice applies to the named products.",
        },
        {
          sourceEntryIds: [entryId],
          text: "Consumers can check the published product list.",
        },
      ],
      summary: {
        sourceEntryIds: [entryId],
        text: "The FDA published a reviewed consumer notice.",
      },
    });
  });
});
