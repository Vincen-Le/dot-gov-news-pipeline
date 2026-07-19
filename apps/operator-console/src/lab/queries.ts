import type postgres from "postgres";

import {
  ExperimentRunSchema,
  ExperimentSummarySchema,
  type BorderlinePair,
  type CorpusSummary,
  type EntryEvidence,
  type EventCard,
  type ExperimentRun,
  type StorylineDetail,
  type StorylineListItem,
  type TopicCategory,
  type TopicTheme,
} from "./contracts";
import { SnapshotQueries } from "./snapshot-queries";
import { cosine, unpackFp16 } from "./vectors";

const iso = (value: unknown): string | null =>
  value instanceof Date ? value.toISOString() : null;

interface CardRow {
  episode_id: string | null;
  generated_at: Date;
  headline: string;
  id: string;
  interest_reason: string | null;
  judge_model: string | null;
  kind: "overview" | "episode";
  rank_key: number;
  rubric: Record<string, unknown> | null;
  summary: string;
  superseded_by: string | null;
  timeline: { date?: string; episode_id?: string; text?: string }[] | null;
  version: number;
}

function toCard(row: CardRow, memberEpisodeIds: Set<string>): EventCard {
  return {
    generatedAt: row.generated_at.toISOString(),
    headline: row.headline,
    id: row.id,
    interestReason: row.interest_reason,
    judgeModel: row.judge_model,
    kind: row.kind,
    rankKey: Number(row.rank_key),
    rubric: row.rubric,
    summary: row.summary,
    supersededBy: row.superseded_by,
    timeline:
      row.timeline === null
        ? null
        : row.timeline.map((item) => ({
            cited:
              typeof item.episode_id === "string" &&
              memberEpisodeIds.has(item.episode_id),
            date: item.date ?? "",
            episodeId: item.episode_id ?? null,
            text: item.text ?? "",
          })),
    version: row.version,
  };
}

export class LabQueries {
  private readonly snapshot: SnapshotQueries | null;

  constructor(
    private readonly sql: postgres.Sql,
    experimentId?: string,
  ) {
    this.snapshot =
      experimentId === undefined
        ? null
        : new SnapshotQueries(sql, experimentId);
  }

  forExperiment(experimentId?: string): LabQueries {
    return experimentId === undefined
      ? this
      : new LabQueries(this.sql, experimentId);
  }

  async corpusSummary(): Promise<CorpusSummary> {
    const [row] = await this.sql`
      select
        (select count(*)::integer from public.news_entries) as entries,
        (select count(*)::integer from public.news_sources) as sources,
        (select min(published_at) from public.news_entries) as first_published_at,
        (select max(published_at) from public.news_entries) as last_published_at,
        (select count(*)::integer from public.news_entries where embedding is not null) as embedded,
        (select count(*)::integer from public.news_entries where enriched_text is not null) as enriched,
        (select count(*)::integer from public.news_entries where extractor_version is not null) as extracted,
        (select count(*)::integer from public.news_entries where episode_id is not null) as clustered,
        (select count(*)::integer from public.news_entries
          where embedding is null and published_at is not null) as needs_prepare
    `;
    const agencies = await this.sql`
      select nsp.publisher_key as agency, count(*)::integer as entries
      from public.news_entries ne
      left join public.news_source_publishers nsp
        on nsp.news_source_id = ne.news_source_id
      group by 1 order by 2 desc, 1 limit 50
    `;
    if (row === undefined) throw new Error("corpusSummary: no aggregate row");
    if (agencies.some((item) => item.agency === null)) {
      throw new Error("corpusSummary: publisher attribution is incomplete");
    }
    return {
      agencies: agencies.map((item) => ({
        agency: String(item.agency),
        entries: Number(item.entries),
      })),
      clustered: Number(row.clustered),
      embedded: Number(row.embedded),
      enriched: Number(row.enriched),
      entries: Number(row.entries),
      extracted: Number(row.extracted),
      firstPublishedAt: iso(row.first_published_at),
      lastPublishedAt: iso(row.last_published_at),
      needsPrepare: Number(row.needs_prepare),
      sources: Number(row.sources),
    };
  }

  async storylines(filter: {
    agency?: string;
    category?: string;
    entity?: string;
    groupBy?: "category" | "theme";
    limit?: number;
    minEpisodes?: number;
    offset?: number;
    sort?: "episodes";
    theme?: string;
  }): Promise<StorylineListItem[]> {
    if (this.snapshot !== null) return this.snapshot.storylines(filter);
    const { sql } = this;
    const rows = await sql`
      select s.id, s.entity_set, s.event_keys, s.agency_ids, s.distinct_feeds,
             s.entry_count, s.episode_count, s.first_entry_at, s.newest_entry_at,
             s.theme_id, tt.display_name as theme_name, tc.display_name as category_name,
             c.headline
      from public.storylines s
      left join public.event_cards c on c.id = s.latest_card_id
      left join public.topic_themes tt on tt.id = s.theme_id
      left join public.topic_categories tc on tc.id = tt.category_id
      where s.merged_into is null
        ${filter.entity === undefined ? sql`` : sql`and ${filter.entity} = any(s.entity_set)`}
        ${filter.agency === undefined ? sql`` : sql`and ${filter.agency} = any(s.agency_ids)`}
        ${filter.minEpisodes === undefined ? sql`` : sql`and s.episode_count >= ${filter.minEpisodes}`}
        ${filter.theme === undefined ? sql`` : sql`and s.theme_id = ${filter.theme}`}
        ${filter.category === undefined ? sql`` : sql`and tt.category_id = ${filter.category}`}
      ${
        filter.groupBy === "theme"
          ? filter.sort === "episodes"
            ? sql`order by tt.display_name asc nulls last, s.episode_count desc, s.newest_entry_at desc, s.id`
            : sql`order by tt.display_name asc nulls last, s.newest_entry_at desc, s.entry_count desc, s.id`
          : filter.groupBy === "category"
            ? filter.sort === "episodes"
              ? sql`order by tc.display_name asc nulls last, s.episode_count desc, s.newest_entry_at desc, s.id`
              : sql`order by tc.display_name asc nulls last, s.newest_entry_at desc, s.entry_count desc, s.id`
            : filter.sort === "episodes"
              ? sql`order by s.episode_count desc, s.newest_entry_at desc, s.id`
              : sql`order by s.newest_entry_at desc, s.entry_count desc, s.id`
      }
      limit ${Math.min(filter.limit ?? 50, 500)}
      offset ${Math.max(filter.offset ?? 0, 0)}
    `;
    return rows.map((row) => ({
      agencies: row.agency_ids as string[],
      categoryName: (row.category_name as string | null) ?? null,
      distinctFeeds: Number(row.distinct_feeds),
      entities: row.entity_set as string[],
      entryCount: Number(row.entry_count),
      episodeCount: Number(row.episode_count),
      eventKeys: row.event_keys as string[],
      firstEntryAt: (row.first_entry_at as Date).toISOString(),
      headline: (row.headline as string | null) ?? null,
      id: String(row.id),
      newestEntryAt: (row.newest_entry_at as Date).toISOString(),
      themeId: row.theme_id === null ? null : String(row.theme_id),
      themeName: (row.theme_name as string | null) ?? null,
    }));
  }

  async storylineAgencies(): Promise<string[]> {
    if (this.snapshot !== null) return this.snapshot.storylineAgencies();
    const rows = await this.sql`
      select distinct unnest(agency_ids) as agency
      from public.storylines
      where merged_into is null
      order by 1
    `;
    return rows.map((row) => String(row.agency));
  }

  async topicThemes(filter: { category?: string }): Promise<TopicTheme[]> {
    if (this.snapshot !== null) return this.snapshot.topicThemes(filter);
    const { sql } = this;
    const rows = await sql`
      select t.id, t.display_name, t.category_id, t.storyline_count,
             t.newest_storyline_at, c.display_name as category_name,
             c.origin as category_origin
      from public.topic_themes t
      left join public.topic_categories c on c.id = t.category_id
      where t.merged_into is null
        ${filter.category === undefined ? sql`` : sql`and t.category_id = ${filter.category}`}
      order by t.storyline_count desc, t.display_name
    `;
    return rows.map((row) => ({
      categoryId: row.category_id === null ? null : String(row.category_id),
      categoryName: (row.category_name as string | null) ?? null,
      categoryOrigin:
        row.category_origin === null
          ? null
          : (String(row.category_origin) as "seed" | "llm"),
      displayName: String(row.display_name),
      id: String(row.id),
      newestStorylineAt: iso(row.newest_storyline_at),
      storylineCount: Number(row.storyline_count),
    }));
  }

  async topicCategories(): Promise<TopicCategory[]> {
    if (this.snapshot !== null) return this.snapshot.topicCategories();
    const rows = await this.sql`
      select c.id, c.display_name, c.origin, c.proposal_reason,
             (select count(*)::integer from public.topic_themes t
              where t.category_id = c.id and t.merged_into is null) as theme_count
      from public.topic_categories c
      order by c.display_name
    `;
    return rows.map((row) => ({
      displayName: String(row.display_name),
      id: String(row.id),
      origin: String(row.origin) as "seed" | "llm",
      proposalReason: (row.proposal_reason as string | null) ?? null,
      themeCount: Number(row.theme_count),
    }));
  }

  async storylineDetail(id: string): Promise<StorylineDetail | null> {
    if (this.snapshot !== null) return this.snapshot.storylineDetail(id);
    const [storyline] = await this.sql`
      select s.id, s.entity_set, s.event_keys, s.agency_ids, s.distinct_feeds,
             s.entry_count, s.episode_count, s.first_entry_at, s.newest_entry_at,
             s.theme_id, s.theme_attach_method, s.theme_similarity, s.theme_reason,
             tt.display_name as theme_name, tt.category_id,
             tc.display_name as category_name,
             c.headline
      from public.storylines s
      left join public.event_cards c on c.id = s.latest_card_id
      left join public.topic_themes tt on tt.id = s.theme_id
      left join public.topic_categories tc on tc.id = tt.category_id
      where s.id = ${id}
    `;
    if (storyline === undefined) return null;

    const episodes = await this.sql`
      select id, status, entity_set, event_keys, entry_count, first_entry_at,
             newest_entry_at, attach_method, attach_similarity, attach_reason,
             adjudicator_model
      from public.episodes where storyline_id = ${id}
      order by first_entry_at, id
    `;
    const memberIds = new Set(episodes.map((episode) => String(episode.id)));

    const entries = await this.sql`
      select ee.episode_id, ee.entry_id, ee.is_syndicated, ee.attach_method,
             ee.similarity, ee.matched_entry_id, ee.threshold_used,
             ne.title, ne.url, ne.published_at, ne.entity_set, ne.event_keys,
             nsp.publisher_key as agency
      from public.episode_entries ee
      join public.episodes ep on ep.id = ee.episode_id
      join public.news_entries ne on ne.id = ee.entry_id
      left join public.news_source_publishers nsp
        on nsp.news_source_id = ne.news_source_id
      where ep.storyline_id = ${id}
      order by ne.published_at, ne.id
    `;

    const cards = (await this.sql`
      select id, episode_id, kind, version, headline, summary, timeline, rubric,
             interest_reason, rank_key, superseded_by, judge_model, generated_at
      from public.event_cards where storyline_id = ${id}
      order by kind, version desc
    `) as unknown as CardRow[];

    const entriesByEpisode = new Map<string, EntryEvidence[]>();
    for (const row of entries) {
      if (row.agency === null) {
        throw new Error(
          `storylineDetail: publisher attribution is missing for ${String(row.entry_id)}`,
        );
      }
      const list = entriesByEpisode.get(String(row.episode_id)) ?? [];
      list.push({
        agency: String(row.agency),
        attachMethod: String(row.attach_method),
        entitySet: row.entity_set as string[],
        eventKeys: row.event_keys as string[],
        id: String(row.entry_id),
        isSyndicated: Boolean(row.is_syndicated),
        matchedEntryId:
          row.matched_entry_id === null ? null : String(row.matched_entry_id),
        publishedAt: iso(row.published_at),
        similarity: row.similarity === null ? null : Number(row.similarity),
        thresholdUsed:
          row.threshold_used === null ? null : Number(row.threshold_used),
        title: (row.title as string | null) ?? null,
        url: String(row.url),
      });
      entriesByEpisode.set(String(row.episode_id), list);
    }

    const episodeCards = new Map<string, EventCard>();
    const overviewCards: EventCard[] = [];
    for (const card of cards) {
      const shaped = toCard(card, memberIds);
      if (card.kind === "episode" && card.episode_id !== null) {
        episodeCards.set(String(card.episode_id), shaped);
      } else if (card.kind === "overview") {
        overviewCards.push(shaped);
      }
    }

    return {
      agencies: storyline.agency_ids as string[],
      categoryId:
        storyline.category_id === null ? null : String(storyline.category_id),
      categoryName: (storyline.category_name as string | null) ?? null,
      distinctFeeds: Number(storyline.distinct_feeds),
      entities: storyline.entity_set as string[],
      entryCount: Number(storyline.entry_count),
      episodeCount: Number(storyline.episode_count),
      episodes: episodes.map((episode) => ({
        adjudicatorModel:
          episode.adjudicator_model === null
            ? null
            : String(episode.adjudicator_model),
        attachMethod: String(episode.attach_method),
        attachReason:
          episode.attach_reason === null ? null : String(episode.attach_reason),
        attachSimilarity:
          episode.attach_similarity === null
            ? null
            : Number(episode.attach_similarity),
        card: episodeCards.get(String(episode.id)) ?? null,
        entitySet: episode.entity_set as string[],
        entries: entriesByEpisode.get(String(episode.id)) ?? [],
        entryCount: Number(episode.entry_count),
        eventKeys: episode.event_keys as string[],
        firstEntryAt: (episode.first_entry_at as Date).toISOString(),
        id: String(episode.id),
        newestEntryAt: (episode.newest_entry_at as Date).toISOString(),
        status: episode.status as "open" | "dormant",
      })),
      eventKeys: storyline.event_keys as string[],
      firstEntryAt: (storyline.first_entry_at as Date).toISOString(),
      headline: (storyline.headline as string | null) ?? null,
      id: String(storyline.id),
      newestEntryAt: (storyline.newest_entry_at as Date).toISOString(),
      overviewCards,
      themeAttachMethod:
        storyline.theme_attach_method === null
          ? null
          : String(storyline.theme_attach_method),
      themeId: storyline.theme_id === null ? null : String(storyline.theme_id),
      themeName: (storyline.theme_name as string | null) ?? null,
      themeReason:
        storyline.theme_reason === null ? null : String(storyline.theme_reason),
      themeSimilarity:
        storyline.theme_similarity === null
          ? null
          : Number(storyline.theme_similarity),
    };
  }

  async volume() {
    if (this.snapshot !== null) return this.snapshot.volume();
    const [row] = await this.sql`
      select
        (select count(*)::integer from public.news_entries
          where episode_id is not null) as entries,
        (select count(*)::integer from public.episodes) as episodes,
        (select count(*)::integer from public.storylines where merged_into is null) as storylines,
        (select count(*)::integer from public.event_cards
          where superseded_by is null) as cards,
        (select count(*)::integer from public.storylines
          where merged_into is null and episode_count >= 2) as multi
    `;
    if (row === undefined) throw new Error("volume: no aggregate row");
    return {
      cards: Number(row.cards),
      entries: Number(row.entries),
      episodes: Number(row.episodes),
      multiEpisodeStorylines: Number(row.multi),
      storylines: Number(row.storylines),
    };
  }

  async attachMix() {
    if (this.snapshot !== null) return this.snapshot.attachMix();
    const rows = await this.sql`
      select attach_method, count(*)::integer as n,
             round(avg(similarity)::numeric, 3) as avg_sim
      from public.episode_entries group by 1 order by n desc
    `;
    return rows.map((row) => ({
      avgSimilarity: row.avg_sim === null ? null : Number(row.avg_sim),
      count: Number(row.n),
      method: String(row.attach_method),
    }));
  }

  async storylineAttachMix() {
    if (this.snapshot !== null) return this.snapshot.storylineAttachMix();
    const rows = await this.sql`
      select attach_method, count(*)::integer as n
      from public.episodes group by 1 order by n desc
    `;
    return rows.map((row) => ({
      count: Number(row.n),
      method: String(row.attach_method),
    }));
  }

  async similarityByMethod(): Promise<{ method: string; values: number[] }[]> {
    if (this.snapshot !== null) return this.snapshot.similarityByMethod();
    const rows = await this.sql`
      select attach_method, array_agg(similarity) as sims
      from public.episode_entries where similarity is not null group by 1
    `;
    return rows.map((row) => ({
      method: String(row.attach_method),
      values: (row.sims as (number | string)[]).map(Number),
    }));
  }

  async entriesPerEpisode(): Promise<number[]> {
    if (this.snapshot !== null) return this.snapshot.entriesPerEpisode();
    const rows = await this.sql`select entry_count from public.episodes`;
    return rows.map((row) => Number(row.entry_count));
  }

  async episodesPerStoryline(): Promise<number[]> {
    if (this.snapshot !== null) return this.snapshot.episodesPerStoryline();
    const rows = await this.sql`
      select episode_count from public.storylines where merged_into is null
    `;
    return rows.map((row) => Number(row.episode_count));
  }

  async syndicationRate(): Promise<number | null> {
    if (this.snapshot !== null) return this.snapshot.syndicationRate();
    const [row] = await this.sql`
      select round(avg(is_syndicated::int)::numeric, 4) as rate
      from public.episode_entries
    `;
    return row === undefined || row.rate === null ? null : Number(row.rate);
  }

  async contentHashPairCosines(): Promise<number[]> {
    if (this.snapshot !== null) return this.snapshot.contentHashPairCosines();
    const rows = await this.sql`
      select a.embedding as ea, b.embedding as eb
      from public.episode_entries ee
      join public.news_entries a on a.id = ee.entry_id
      join public.news_entries b on b.id = ee.matched_entry_id
      where ee.attach_method = 'content_hash'
        and a.embedding is not null and b.embedding is not null
      limit 10000
    `;
    return rows.map((row) =>
      cosine(
        unpackFp16(row.ea as Uint8Array),
        unpackFp16(row.eb as Uint8Array),
      ),
    );
  }

  async topChains(limit = 10) {
    if (this.snapshot !== null) return this.snapshot.topChains(limit);
    const rows = await this.sql`
      select s.id, s.episode_count, s.entry_count, c.headline
      from public.storylines s
      left join public.event_cards c on c.id = s.latest_card_id
      where s.merged_into is null
      order by s.episode_count desc, s.entry_count desc
      limit ${limit}
    `;
    return rows.map((row) => ({
      entryCount: Number(row.entry_count),
      episodeCount: Number(row.episode_count),
      headline: (row.headline as string | null) ?? null,
      storylineId: String(row.id),
    }));
  }

  async borderlinePairs(window = 0.03, limit = 100): Promise<BorderlinePair[]> {
    if (this.snapshot !== null)
      return this.snapshot.borderlinePairs(window, limit);
    const rows = await this.sql`
      select ee.entry_id, ee.matched_entry_id, ee.attach_method, ee.similarity,
             ee.threshold_used, a.title as entry_title, b.title as matched_title
      from public.episode_entries ee
      join public.news_entries a on a.id = ee.entry_id
      left join public.news_entries b on b.id = ee.matched_entry_id
      where ee.similarity is not null and ee.threshold_used is not null
        and abs(ee.similarity - ee.threshold_used) < ${window}
      order by abs(ee.similarity - ee.threshold_used)
      limit ${Math.min(limit, 1000)}
    `;
    return rows.map((row) => ({
      attachMethod: String(row.attach_method),
      entryId: String(row.entry_id),
      entryTitle: (row.entry_title as string | null) ?? null,
      matchedEntryId:
        row.matched_entry_id === null ? null : String(row.matched_entry_id),
      matchedTitle: (row.matched_title as string | null) ?? null,
      similarity: Number(row.similarity),
      thresholdUsed: Number(row.threshold_used),
    }));
  }

  // -- complex_v1_experiment_runs (survives reset --clusters) ---------------

  private shapeRun(row: Record<string, unknown>): ExperimentRun {
    const started = row.started_at as Date;
    const finished = row.finished_at as Date;
    return ExperimentRunSchema.parse({
      cacheHits: Number(row.cache_hits),
      cacheMisses: Number(row.cache_misses),
      clusterReport: row.cluster_report ?? null,
      config: (row.config as Record<string, unknown> | null) ?? null,
      createdAt: (row.created_at as Date).toISOString(),
      durationSeconds: Number(
        ((finished.getTime() - started.getTime()) / 1000).toFixed(1),
      ),
      finishedAt: finished.toISOString(),
      id: String(row.id),
      name: String(row.name),
      snapshot:
        row.snapshot_created_at === null ||
        row.snapshot_created_at === undefined
          ? null
          : {
              capturedAt: (row.snapshot_created_at as Date).toISOString(),
              isBest: Boolean(row.snapshot_is_best),
              note: (row.snapshot_note as string | null) ?? null,
              reward:
                (row.snapshot_reward as Record<string, unknown> | null) ?? null,
              rowCounts: row.snapshot_row_counts as Record<string, number>,
              schemaVersion: Number(row.snapshot_schema_version),
            },
      startedAt: started.toISOString(),
      summary:
        row.summary === null
          ? null
          : ExperimentSummarySchema.parse(row.summary),
    });
  }

  async experimentRuns(limit = 50): Promise<ExperimentRun[]> {
    const rows = await this.sql`
      select r.id, r.name, r.started_at, r.finished_at, r.config,
             r.cluster_report, r.summary, r.cache_hits, r.cache_misses,
             r.created_at, s.created_at as snapshot_created_at,
             s.schema_version as snapshot_schema_version,
             s.row_counts as snapshot_row_counts, s.note as snapshot_note,
             s.reward as snapshot_reward, s.is_best as snapshot_is_best
      from public.complex_v1_experiment_runs r
      left join public.complex_v1_experiment_cluster_snapshots s on s.run_id = r.id
      order by r.created_at desc
      limit ${Math.min(limit, 500)}
    `;
    return rows.map((row) => this.shapeRun(row));
  }

  async experimentRun(id: string): Promise<ExperimentRun | null> {
    const [row] = await this.sql`
      select r.id, r.name, r.started_at, r.finished_at, r.config,
             r.cluster_report, r.summary, r.cache_hits, r.cache_misses,
             r.created_at, s.created_at as snapshot_created_at,
             s.schema_version as snapshot_schema_version,
             s.row_counts as snapshot_row_counts, s.note as snapshot_note,
             s.reward as snapshot_reward, s.is_best as snapshot_is_best
      from public.complex_v1_experiment_runs r
      left join public.complex_v1_experiment_cluster_snapshots s on s.run_id = r.id
      where r.id = ${id}
    `;
    return row === undefined ? null : this.shapeRun(row);
  }
}
