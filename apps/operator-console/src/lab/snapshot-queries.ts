import type postgres from "postgres";

import type {
  BorderlinePair,
  EntryEvidence,
  EventCard,
  StorylineDetail,
  StorylineListItem,
  TopicCategory,
  TopicTheme,
} from "./contracts";

type StorylineFilter = {
  agency?: string;
  category?: string;
  entity?: string;
  groupBy?: "category" | "theme";
  limit?: number;
  minEpisodes?: number;
  offset?: number;
  sort?: "episodes" | "rank";
  theme?: string;
};

interface SnapshotStoryline {
  agency_ids: string[];
  category_id: string | null;
  distinct_feeds: number;
  entity_set: string[];
  entry_count: number;
  episode_count: number;
  event_keys: string[];
  first_entry_at: string;
  id: string;
  latest_card_id: string | null;
  merged_into: string | null;
  newest_entry_at: string;
  theme_attach_method: string | null;
  theme_id: string | null;
  theme_reason: string | null;
  theme_similarity: number | null;
}

interface SnapshotEpisode {
  adjudicator_model: string | null;
  attach_method: string;
  attach_reason: string | null;
  attach_similarity: number | null;
  entity_set: string[];
  entry_count: number;
  event_keys: string[];
  first_entry_at: string;
  id: string;
  newest_entry_at: string;
  status: "open" | "dormant";
  storyline_id: string;
}

interface SnapshotEpisodeEntry {
  attach_method: string;
  entry_id: string;
  episode_id: string;
  is_syndicated: boolean;
  matched_entry_id: string | null;
  similarity: number | null;
  threshold_used: number | null;
}

interface SnapshotNewsEntry {
  agency: string | null;
  entity_set: string[];
  event_keys: string[];
  id: string;
  published_at: string | null;
  title: string | null;
  url: string;
}

interface SnapshotCard {
  episode_id: string | null;
  generated_at: string;
  headline: string;
  id: string;
  interest_reason: string | null;
  judge_model: string | null;
  kind: "overview" | "episode";
  rank_key: number;
  rubric: Record<string, unknown> | null;
  storyline_id: string;
  summary: string;
  superseded_by: string | null;
  timeline: { date?: string; episode_id?: string; text?: string }[] | null;
  version: number;
}

interface SnapshotTheme {
  category_id: string | null;
  demoted_at: string | null;
  display_name: string;
  id: string;
  merged_into: string | null;
  newest_storyline_at: string | null;
  storyline_count: number;
}

interface SnapshotCategory {
  display_name: string;
  id: string;
  origin: "seed" | "llm";
  proposal_reason: string | null;
}

interface SnapshotPayload {
  episode_entries: SnapshotEpisodeEntry[];
  episodes: SnapshotEpisode[];
  event_cards: SnapshotCard[];
  news_entries: SnapshotNewsEntry[];
  storylines: SnapshotStoryline[];
  topic_categories: SnapshotCategory[];
  topic_themes: SnapshotTheme[];
}

function compareText(left: string | null, right: string | null): number {
  if (left === null) return right === null ? 0 : 1;
  if (right === null) return -1;
  return left.localeCompare(right);
}

function newestFirst(left: string | null, right: string | null): number {
  return (right ?? "").localeCompare(left ?? "");
}

function roundedAverage(values: number[]): number | null {
  if (values.length === 0) return null;
  return Number(
    (values.reduce((total, value) => total + value, 0) / values.length).toFixed(
      3,
    ),
  );
}

function toCard(row: SnapshotCard, memberEpisodeIds: Set<string>): EventCard {
  return {
    generatedAt: new Date(row.generated_at).toISOString(),
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
    version: Number(row.version),
  };
}

/** Read-only projection of one immutable experiment snapshot. */
export class SnapshotQueries {
  private payloadPromise: Promise<SnapshotPayload> | null = null;

  constructor(
    private readonly sql: postgres.Sql,
    readonly runId: string,
    private readonly clusterSnapshotsTable: string = "complex_v1_experiment_cluster_snapshots",
  ) {}

  private payload(): Promise<SnapshotPayload> {
    this.payloadPromise ??= this.sql`
      select snapshot
      from public.${this.sql(this.clusterSnapshotsTable)}
      where run_id = ${this.runId}
    `.then((rows) => {
      const payload = rows[0]?.snapshot;
      if (payload === undefined) {
        throw new Error(`Unknown experiment snapshot ${this.runId}`);
      }
      return payload as SnapshotPayload;
    });
    return this.payloadPromise;
  }

  async storylines(filter: StorylineFilter): Promise<StorylineListItem[]> {
    const snapshot = await this.payload();
    const themes = new Map(snapshot.topic_themes.map((row) => [row.id, row]));
    const categories = new Map(
      snapshot.topic_categories.map((row) => [row.id, row]),
    );
    const cards = new Map(snapshot.event_cards.map((row) => [row.id, row]));
    const shaped = snapshot.storylines
      .filter((row) => row.merged_into === null)
      .filter(
        (row) =>
          filter.entity === undefined || row.entity_set.includes(filter.entity),
      )
      .filter(
        (row) =>
          filter.agency === undefined || row.agency_ids.includes(filter.agency),
      )
      .filter(
        (row) =>
          filter.minEpisodes === undefined ||
          row.episode_count >= filter.minEpisodes,
      )
      .filter(
        (row) => filter.theme === undefined || row.theme_id === filter.theme,
      )
      .filter(
        (row) =>
          filter.category === undefined || row.category_id === filter.category,
      )
      .map((row): StorylineListItem => {
        const theme =
          row.theme_id === null ? undefined : themes.get(row.theme_id);
        const category =
          row.category_id === null
            ? undefined
            : categories.get(row.category_id);
        const latestCard =
          row.latest_card_id === null
            ? undefined
            : cards.get(row.latest_card_id);
        return {
          agencies: row.agency_ids,
          categoryName: category?.display_name ?? null,
          distinctFeeds: Number(row.distinct_feeds),
          entities: row.entity_set,
          entryCount: Number(row.entry_count),
          episodeCount: Number(row.episode_count),
          eventKeys: row.event_keys,
          firstEntryAt: new Date(row.first_entry_at).toISOString(),
          headline:
            row.latest_card_id === null
              ? null
              : (cards.get(row.latest_card_id)?.headline ?? null),
          id: row.id,
          newestEntryAt: new Date(row.newest_entry_at).toISOString(),
          rankKey:
            latestCard?.rank_key === undefined
              ? null
              : Number(latestCard.rank_key),
          themeId: row.theme_id,
          themeName: theme?.display_name ?? null,
        };
      });

    shaped.sort((left, right) => {
      if (filter.groupBy === "theme") {
        return (
          compareText(left.themeName, right.themeName) ||
          (filter.sort === "episodes"
            ? right.episodeCount - left.episodeCount
            : filter.sort === "rank"
              ? (right.rankKey ?? -Infinity) - (left.rankKey ?? -Infinity)
              : newestFirst(left.newestEntryAt, right.newestEntryAt)) ||
          left.id.localeCompare(right.id)
        );
      }
      if (filter.groupBy === "category") {
        return (
          compareText(left.categoryName, right.categoryName) ||
          (filter.sort === "episodes"
            ? right.episodeCount - left.episodeCount
            : filter.sort === "rank"
              ? (right.rankKey ?? -Infinity) - (left.rankKey ?? -Infinity)
              : newestFirst(left.newestEntryAt, right.newestEntryAt)) ||
          left.id.localeCompare(right.id)
        );
      }
      return (
        (filter.sort === "episodes"
          ? right.episodeCount - left.episodeCount
          : filter.sort === "rank"
            ? (right.rankKey ?? -Infinity) - (left.rankKey ?? -Infinity)
            : newestFirst(left.newestEntryAt, right.newestEntryAt)) ||
        right.entryCount - left.entryCount ||
        left.id.localeCompare(right.id)
      );
    });
    const offset = Math.max(filter.offset ?? 0, 0);
    return shaped.slice(offset, offset + Math.min(filter.limit ?? 50, 5000));
  }

  async storylineAgencies(): Promise<string[]> {
    const snapshot = await this.payload();
    return [
      ...new Set(
        snapshot.storylines
          .filter((row) => row.merged_into === null)
          .flatMap((row) => row.agency_ids),
      ),
    ].sort();
  }

  async topicThemes(filter: { category?: string }): Promise<TopicTheme[]> {
    const snapshot = await this.payload();
    const categories = new Map(
      snapshot.topic_categories.map((row) => [row.id, row]),
    );
    return snapshot.topic_themes
      .filter((row) => row.merged_into === null && row.demoted_at === null)
      .filter(
        (row) =>
          filter.category === undefined || row.category_id === filter.category,
      )
      .map((row) => {
        const category =
          row.category_id === null
            ? undefined
            : categories.get(row.category_id);
        return {
          categoryId: row.category_id,
          categoryName: category?.display_name ?? null,
          categoryOrigin: category?.origin ?? null,
          displayName: row.display_name,
          id: row.id,
          newestStorylineAt:
            row.newest_storyline_at === null
              ? null
              : new Date(row.newest_storyline_at).toISOString(),
          storylineCount: Number(row.storyline_count),
        } satisfies TopicTheme;
      })
      .sort(
        (left, right) =>
          right.storylineCount - left.storylineCount ||
          left.displayName.localeCompare(right.displayName),
      );
  }

  async topicCategories(): Promise<TopicCategory[]> {
    const snapshot = await this.payload();
    return snapshot.topic_categories
      .map((row) => ({
        displayName: row.display_name,
        id: row.id,
        origin: row.origin,
        proposalReason: row.proposal_reason,
        storylineCount: snapshot.storylines.filter(
          (storyline) =>
            storyline.category_id === row.id && storyline.merged_into === null,
        ).length,
        themeCount: snapshot.topic_themes.filter(
          (theme) =>
            theme.category_id === row.id &&
            theme.merged_into === null &&
            theme.demoted_at === null,
        ).length,
      }))
      .sort((left, right) => left.displayName.localeCompare(right.displayName));
  }

  async storylineDetail(id: string): Promise<StorylineDetail | null> {
    const snapshot = await this.payload();
    const storyline = snapshot.storylines.find((row) => row.id === id);
    if (storyline === undefined) return null;
    const episodes = snapshot.episodes
      .filter((row) => row.storyline_id === id)
      .sort(
        (left, right) =>
          right.first_entry_at.localeCompare(left.first_entry_at) ||
          right.id.localeCompare(left.id),
      );
    const memberEpisodeIds = new Set(episodes.map((row) => row.id));
    const entries = new Map(snapshot.news_entries.map((row) => [row.id, row]));
    const cards = snapshot.event_cards
      .filter((row) => row.storyline_id === id)
      .sort(
        (left, right) =>
          left.kind.localeCompare(right.kind) || right.version - left.version,
      );
    const episodeCards = new Map<string, EventCard>();
    const overviewCards: EventCard[] = [];
    for (const card of cards) {
      const shaped = toCard(card, memberEpisodeIds);
      if (card.kind === "episode" && card.episode_id !== null) {
        episodeCards.set(card.episode_id, shaped);
      } else if (card.kind === "overview") {
        overviewCards.push(shaped);
      }
    }
    const theme =
      storyline.theme_id === null
        ? undefined
        : snapshot.topic_themes.find((row) => row.id === storyline.theme_id);
    const category =
      storyline.category_id === null
        ? undefined
        : snapshot.topic_categories.find(
            (row) => row.id === storyline.category_id,
          );
    const latestCard =
      storyline.latest_card_id === null
        ? undefined
        : snapshot.event_cards.find(
            (card) => card.id === storyline.latest_card_id,
          );

    return {
      agencies: storyline.agency_ids,
      categoryId: storyline.category_id,
      categoryName: category?.display_name ?? null,
      distinctFeeds: Number(storyline.distinct_feeds),
      entities: storyline.entity_set,
      entryCount: Number(storyline.entry_count),
      episodeCount: Number(storyline.episode_count),
      episodes: episodes.map((episode) => ({
        adjudicatorModel: episode.adjudicator_model,
        attachMethod: episode.attach_method,
        attachReason: episode.attach_reason,
        attachSimilarity:
          episode.attach_similarity === null
            ? null
            : Number(episode.attach_similarity),
        card: episodeCards.get(episode.id) ?? null,
        entitySet: episode.entity_set,
        entries: snapshot.episode_entries
          .filter((row) => row.episode_id === episode.id)
          .map((membership): EntryEvidence => {
            const entry = entries.get(membership.entry_id);
            if (entry === undefined || entry.agency === null) {
              throw new Error(
                `experiment snapshot ${this.runId} is missing entry evidence for ${membership.entry_id}`,
              );
            }
            return {
              agency: entry.agency,
              attachMethod: membership.attach_method,
              entitySet: entry.entity_set,
              eventKeys: entry.event_keys,
              id: entry.id,
              isSyndicated: membership.is_syndicated,
              matchedEntryId: membership.matched_entry_id,
              publishedAt:
                entry.published_at === null
                  ? null
                  : new Date(entry.published_at).toISOString(),
              similarity:
                membership.similarity === null
                  ? null
                  : Number(membership.similarity),
              thresholdUsed:
                membership.threshold_used === null
                  ? null
                  : Number(membership.threshold_used),
              title: entry.title,
              url: entry.url,
            };
          })
          .sort((left, right) =>
            (left.publishedAt ?? "").localeCompare(right.publishedAt ?? ""),
          ),
        entryCount: Number(episode.entry_count),
        eventKeys: episode.event_keys,
        firstEntryAt: new Date(episode.first_entry_at).toISOString(),
        id: episode.id,
        newestEntryAt: new Date(episode.newest_entry_at).toISOString(),
        status: episode.status,
      })),
      eventKeys: storyline.event_keys,
      firstEntryAt: new Date(storyline.first_entry_at).toISOString(),
      headline:
        storyline.latest_card_id === null
          ? null
          : (snapshot.event_cards.find(
              (card) => card.id === storyline.latest_card_id,
            )?.headline ?? null),
      id: storyline.id,
      newestEntryAt: new Date(storyline.newest_entry_at).toISOString(),
      rankKey:
        latestCard?.rank_key === undefined ? null : Number(latestCard.rank_key),
      overviewCards,
      themeAttachMethod: storyline.theme_attach_method,
      themeId: storyline.theme_id,
      themeName: theme?.display_name ?? null,
      themeReason: storyline.theme_reason,
      themeSimilarity:
        storyline.theme_similarity === null
          ? null
          : Number(storyline.theme_similarity),
    };
  }

  async volume() {
    const snapshot = await this.payload();
    const storylines = snapshot.storylines.filter(
      (row) => row.merged_into === null,
    );
    return {
      cards: snapshot.event_cards.filter((row) => row.superseded_by === null)
        .length,
      entries: snapshot.episode_entries.length,
      episodes: snapshot.episodes.length,
      multiEpisodeStorylines: storylines.filter((row) => row.episode_count >= 2)
        .length,
      storylines: storylines.length,
    };
  }

  async attachMix() {
    const snapshot = await this.payload();
    const methods = new Map<string, SnapshotEpisodeEntry[]>();
    for (const row of snapshot.episode_entries) {
      methods.set(row.attach_method, [
        ...(methods.get(row.attach_method) ?? []),
        row,
      ]);
    }
    return [...methods.entries()]
      .map(([method, rows]) => ({
        avgSimilarity: roundedAverage(
          rows.flatMap((row) =>
            row.similarity === null ? [] : [Number(row.similarity)],
          ),
        ),
        count: rows.length,
        method,
      }))
      .sort((left, right) => right.count - left.count);
  }

  async storylineAttachMix() {
    const snapshot = await this.payload();
    const counts = new Map<string, number>();
    for (const row of snapshot.episodes) {
      counts.set(row.attach_method, (counts.get(row.attach_method) ?? 0) + 1);
    }
    return [...counts.entries()]
      .map(([method, count]) => ({ count, method }))
      .sort((left, right) => right.count - left.count);
  }

  async similarityByMethod(): Promise<{ method: string; values: number[] }[]> {
    const snapshot = await this.payload();
    const values = new Map<string, number[]>();
    for (const row of snapshot.episode_entries) {
      if (row.similarity === null) continue;
      values.set(row.attach_method, [
        ...(values.get(row.attach_method) ?? []),
        Number(row.similarity),
      ]);
    }
    return [...values.entries()].map(([method, methodValues]) => ({
      method,
      values: methodValues,
    }));
  }

  async entriesPerEpisode(): Promise<number[]> {
    const snapshot = await this.payload();
    return snapshot.episodes.map((row) => Number(row.entry_count));
  }

  async episodesPerStoryline(): Promise<number[]> {
    const snapshot = await this.payload();
    return snapshot.storylines
      .filter((row) => row.merged_into === null)
      .map((row) => Number(row.episode_count));
  }

  async syndicationRate(): Promise<number | null> {
    const snapshot = await this.payload();
    if (snapshot.episode_entries.length === 0) return null;
    return Number(
      (
        snapshot.episode_entries.filter((row) => row.is_syndicated).length /
        snapshot.episode_entries.length
      ).toFixed(4),
    );
  }

  async contentHashPairCosines(): Promise<number[]> {
    const snapshot = await this.payload();
    // The attach record already freezes the model-space cosine used by the run.
    return snapshot.episode_entries.flatMap((row) =>
      row.attach_method === "content_hash" && row.similarity !== null
        ? [Number(row.similarity)]
        : [],
    );
  }

  async topChains(limit = 10) {
    const storylines = await this.storylines({
      limit,
      sort: "episodes",
    });
    return storylines.map((row) => ({
      entryCount: row.entryCount,
      episodeCount: row.episodeCount,
      headline: row.headline,
      storylineId: row.id,
    }));
  }

  async borderlinePairs(window = 0.03, limit = 100): Promise<BorderlinePair[]> {
    const snapshot = await this.payload();
    const entries = new Map(snapshot.news_entries.map((row) => [row.id, row]));
    return snapshot.episode_entries
      .filter(
        (row) =>
          row.similarity !== null &&
          row.threshold_used !== null &&
          Math.abs(Number(row.similarity) - Number(row.threshold_used)) <
            window,
      )
      .sort(
        (left, right) =>
          Math.abs(Number(left.similarity) - Number(left.threshold_used)) -
          Math.abs(Number(right.similarity) - Number(right.threshold_used)),
      )
      .slice(0, Math.min(limit, 1000))
      .map((row) => ({
        attachMethod: row.attach_method,
        entryId: row.entry_id,
        entryTitle: entries.get(row.entry_id)?.title ?? null,
        matchedEntryId: row.matched_entry_id,
        matchedTitle:
          row.matched_entry_id === null
            ? null
            : (entries.get(row.matched_entry_id)?.title ?? null),
        similarity: Number(row.similarity),
        thresholdUsed: Number(row.threshold_used),
      }));
  }
}
