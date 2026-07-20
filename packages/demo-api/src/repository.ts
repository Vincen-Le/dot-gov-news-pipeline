import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { z } from "zod";

const agencyDisplayNames = new Map<string, string>([
  ["bls", "Bureau of Labor Statistics"],
  ["cdc", "Centers for Disease Control and Prevention"],
  ["cftc", "Commodity Futures Trading Commission — Enforcement"],
  ["cisa", "Cybersecurity and Infrastructure Security Agency"],
  ["csb", "U.S. Chemical Safety and Hazard Investigation Board"],
  ["doj", "Department of Justice"],
  ["eeoc", "Equal Employment Opportunity Commission"],
  ["epa", "Environmental Protection Agency"],
  ["fda", "Food and Drug Administration"],
  ["fema", "Federal Emergency Management Agency"],
  ["fsa", "Federal Student Aid"],
  ["ftc", "Federal Trade Commission"],
  ["inciweb", "NIFC InciWeb"],
  ["irs", "Internal Revenue Service"],
  ["nasa", "National Aeronautics and Space Administration"],
  ["ncbi", "National Center for Biotechnology Information"],
  ["noaa", "National Oceanic and Atmospheric Administration"],
  ["nps", "National Park Service"],
  ["ntsb", "National Transportation Safety Board"],
  ["nws", "National Weather Service"],
  ["osha", "Occupational Safety and Health Administration"],
  ["sec", "Securities and Exchange Commission"],
  ["sec-enforcement", "Securities and Exchange Commission — Enforcement"],
  ["ssa", "Social Security Administration"],
  ["state", "Department of State"],
  ["texas-gov", "Office of the Texas Governor — Incident Response"],
  ["treasury", "Department of the Treasury"],
  ["uscis", "U.S. Citizenship and Immigration Services"],
  ["usda", "Department of Agriculture"],
  ["usgs", "U.S. Geological Survey"],
  ["usps", "United States Postal Service"],
  ["va", "Department of Veterans Affairs"],
]);

const GoldenStorylineRowSchema = z.object({
  agency_ids: z.array(z.string()),
  category_id: z.string().nullable(),
  distinct_feeds: z.coerce.number().int().nonnegative(),
  entity_set: z.array(z.string()),
  entry_count: z.coerce.number().int().nonnegative(),
  episode_count: z.coerce.number().int().nonnegative(),
  event_keys: z.array(z.string()),
  first_entry_at: z.string(),
  id: z.string(),
  latest_card_id: z.string().nullable(),
  merged_into: z.string().nullable(),
  newest_entry_at: z.string(),
  theme_id: z.string().nullable(),
});

const GoldenEpisodeRowSchema = z.object({
  attach_method: z.string(),
  attach_reason: z.string().nullable(),
  entry_count: z.coerce.number().int().nonnegative(),
  first_entry_at: z.string(),
  id: z.string(),
  newest_entry_at: z.string(),
  status: z.enum(["open", "dormant"]),
  storyline_id: z.string(),
});

const GoldenCardRowSchema = z.object({
  episode_id: z.string().nullable(),
  generated_at: z.string(),
  headline: z.string(),
  id: z.string(),
  interest_reason: z.string().nullable(),
  kind: z.enum(["overview", "episode"]),
  newest_entry_at: z.string(),
  rank_key: z.coerce.number(),
  storyline_id: z.string(),
  summary: z.string(),
  timeline: z.unknown().nullable(),
  version: z.coerce.number().int().positive(),
});

const ArticleOverviewCitationSchema = z
  .object({
    sourceEntryIds: z.array(z.string()).min(1),
    text: z.string().min(1),
  })
  .strict();

const ArticleOverviewV1Schema = z
  .object({
    keyDetails: z.array(ArticleOverviewCitationSchema).min(3).max(5),
    whatChangedAcrossUpdates: ArticleOverviewCitationSchema,
    whatRemainsUnresolved: ArticleOverviewCitationSchema.nullable(),
    whatSourcesEstablish: ArticleOverviewCitationSchema,
  })
  .strict();

const ArticleOverviewV2Schema = z
  .object({
    keyPoints: z.array(ArticleOverviewCitationSchema).min(2).max(5),
    summary: ArticleOverviewCitationSchema,
  })
  .strict();

const ArticleOverviewSchema = z
  .union([ArticleOverviewV2Schema, ArticleOverviewV1Schema])
  .transform((overview) =>
    "summary" in overview
      ? overview
      : {
          keyPoints: overview.keyDetails,
          summary: overview.whatSourcesEstablish,
        },
  );

const GoldenArticleOverviewRowSchema = z.object({
  article_overview: ArticleOverviewSchema,
  event_card_id: z.string(),
});

const ImageThumbnailRowSchema = z.object({
  alt_text: z.string().min(1),
  card_mime_type: z.enum([
    "image/avif",
    "image/jpeg",
    "image/png",
    "image/webp",
  ]),
  focal_x: z.coerce.number().min(0).max(1),
  focal_y: z.coerce.number().min(0).max(1),
  id: z.string(),
  r2_card_key: z.string().min(1),
});

const GoldenStorylineThumbnailRowSchema = z.object({
  image_id: z.string(),
  storyline_id: z.string(),
});

const CardStorylineRowSchema = z.object({
  id: z.string(),
  storyline_id: z.string(),
});

const GoldenMembershipRowSchema = z.object({
  gold_episode_id: z.string().nullable(),
  gold_storyline_id: z.string().nullable(),
  is_syndicated: z.boolean(),
  news_entry_id: z.string(),
  reviewed_at: z.string().nullable(),
});

const NewsEntryRowSchema = z.object({
  entity_set: z.array(z.string()),
  event_keys: z.array(z.string()),
  id: z.string(),
  news_source_id: z.string(),
  published_at: z.string().nullable(),
  title: z.string().nullable(),
  url: z.string(),
});

const PublisherRowSchema = z.object({
  news_source_id: z.string(),
  publisher_key: z.string(),
});

const CategoryRowSchema = z.object({
  display_name: z.string(),
  id: z.string(),
  origin: z.enum(["seed", "llm"]),
  proposal_reason: z.string().nullable(),
});

const ThemeRowSchema = z.object({
  category_id: z.string().nullable(),
  display_name: z.string(),
  first_storyline_at: z.string().nullable(),
  id: z.string(),
  merged_into: z.string().nullable(),
  name_model: z.string().nullable(),
  newest_storyline_at: z.string().nullable(),
});

const RankSnapshotRowSchema = z.object({
  agencies: z.coerce.number().int().nonnegative(),
  card_id: z.string(),
  entry_count: z.coerce.number().int().nonnegative(),
  feeds: z.coerce.number().int().nonnegative(),
  headline: z.string().nullable(),
  interest_reason: z.string().nullable(),
  newest_entry_at: z.string().nullable(),
  position: z.coerce.number().int().positive(),
  rank_key: z.coerce.number(),
  storyline_id: z.string(),
  summary: z.string().nullable(),
  terms: z.object({
    agency_term: z.number(),
    feed_term: z.number(),
    freshness_term: z.number(),
    prior_used: z.boolean(),
    rubric_points: z.number(),
    source_key: z.string().nullable().optional(),
    source_term: z.number(),
  }),
});

const ExperimentRunRowSchema = z.object({
  config: z.record(z.string(), z.unknown()).nullable(),
  id: z.string(),
  name: z.string(),
});

type GoldenStorylineRow = z.infer<typeof GoldenStorylineRowSchema>;
type GoldenCardRow = z.infer<typeof GoldenCardRowSchema>;
type GoldenMembershipRow = z.infer<typeof GoldenMembershipRowSchema>;
type CategoryRow = z.infer<typeof CategoryRowSchema>;
type ThemeRow = z.infer<typeof ThemeRowSchema>;

export interface DemoAgency {
  displayName: string;
  key: string;
}

export interface DemoCategory {
  displayName: string;
  id: string;
  origin: "llm" | "seed";
  proposalReason: string | null;
  storylineCount: number;
  themeCount: number;
}

export interface DemoTheme {
  categoryId: string | null;
  categoryName: string | null;
  displayName: string;
  firstStorylineAt: string | null;
  id: string;
  manuallySet: boolean;
  newestStorylineAt: string | null;
  storylineCount: number;
}

export interface DemoStorylineListItem {
  agencies: string[];
  categoryName: string | null;
  distinctFeeds: number;
  entities: string[];
  entryCount: number;
  episodeCount: number;
  eventKeys: string[];
  firstEntryAt: string;
  firstOverviewAt: string | null;
  headline: string | null;
  id: string;
  newestEntryAt: string;
  rankKey: number | null;
  rankHistory?: DemoStorylineRankSnapshot[];
  themeId: string | null;
  themeName: string | null;
  unreviewedEntryCount: number;
}

export interface DemoStorylineRankSnapshot {
  newestEntryAt: string;
  rankKey: number;
  version: number;
}

export interface DemoEntry {
  agency: string;
  attachMethod: string;
  entitySet: string[];
  eventKeys: string[];
  id: string;
  isSyndicated: boolean;
  matchedEntryId: null;
  publishedAt: string | null;
  similarity: null;
  thresholdUsed: null;
  title: string | null;
  url: string;
}

export interface DemoArticleOverviewCitation {
  sourceEntryIds: string[];
  text: string;
}

export interface DemoArticleOverview {
  keyPoints: DemoArticleOverviewCitation[];
  summary: DemoArticleOverviewCitation;
}

export interface DemoThumbnail {
  altText: string;
  cardUrl: string;
  focalX: number;
  focalY: number;
}

export interface DemoThumbnailAsset {
  key: string;
  mimeType: "image/avif" | "image/jpeg" | "image/png" | "image/webp";
}

export interface DemoCard {
  articleOverview: DemoArticleOverview | null;
  generatedAt: string;
  headline: string;
  id: string;
  interestReason: string | null;
  kind: "episode" | "overview";
  newestEntryAt: string;
  rankKey: number;
  summary: string;
  thumbnail: DemoThumbnail | null;
  timeline:
    | {
        date: string;
        episodeId: string | null;
        text: string | null;
      }[]
    | null;
  version: number;
}

export interface DemoEpisode {
  attachMethod: string;
  attachReason: string | null;
  card: DemoCard | null;
  entries: DemoEntry[];
  entryCount: number;
  firstEntryAt: string;
  id: string;
  newestEntryAt: string;
  status: "dormant" | "open";
}

export interface DemoStorylineDetail extends DemoStorylineListItem {
  categoryId: string | null;
  episodes: DemoEpisode[];
  overviewCards: DemoCard[];
}

export interface DemoStorylinePreview {
  overviewCards: DemoStorylinePreviewCard[];
  storylineId: string;
}

export interface DemoStorylinePreviewCard {
  headline: string;
  id: string;
  newestEntryAt: string;
  rankKey: number;
  summary: string;
  thumbnail: DemoThumbnail | null;
  version: number;
}

export interface DemoBootstrap {
  agencies: DemoAgency[];
  categories: DemoCategory[];
  previews: DemoStorylinePreview[];
  storylines: {
    hasMore: boolean;
    items: DemoStorylineListItem[];
  };
  themes: DemoTheme[];
}

export interface DemoRankRow {
  agencies: number;
  entryCount: number;
  feeds: number;
  headline: string | null;
  interestReason: string | null;
  newestEntryAt: string | null;
  position: number;
  rankKey: number;
  sourceKey: string | null;
  sourceName: string | null;
  storylineId: string;
  summary: string | null;
  terms: z.infer<typeof RankSnapshotRowSchema>["terms"];
}

export interface DemoRankOverview {
  dataset: {
    reviewedAt: string | null;
    reviewedEntries: number;
    sourceRunName: string;
    storylines: number;
  };
  filters: {
    agencies: DemoAgency[];
    categories: DemoCategory[];
    themes: DemoTheme[];
  };
}

export interface DemoRepository {
  getBootstrap(limit: number): Promise<DemoBootstrap>;
  getCardThumbnailAsset(id: string): Promise<DemoThumbnailAsset | null>;
  getRankOverview(): Promise<DemoRankOverview | null>;
  getStoryline(id: string): Promise<DemoStorylineDetail | null>;
  listAgencies(): Promise<DemoAgency[]>;
  listCategories(): Promise<DemoCategory[]>;
  listRankRows(filter: {
    agency?: string;
    category?: string;
    limit: number;
    theme?: string;
  }): Promise<DemoRankRow[]>;
  listStorylines(limit: number): Promise<{
    hasMore: boolean;
    items: DemoStorylineListItem[];
  }>;
  listThemes(): Promise<DemoTheme[]>;
}

export interface DemoRepositoryConfig {
  supabaseKey: string;
  supabaseUrl: string;
}

interface ProviderResult {
  data: unknown;
  error: { code?: string } | null;
}

function providerError(operation: string, code: string | undefined): Error {
  return new Error(
    `Supabase ${operation} failed${code === undefined ? "" : ` (${code})`}`,
  );
}

function rows<T>(
  operation: string,
  result: ProviderResult,
  schema: z.ZodType<T>,
): T[] {
  if (result.error !== null) throw providerError(operation, result.error.code);
  return z.array(schema).parse(result.data);
}

function nullableRow<T>(
  operation: string,
  result: ProviderResult,
  schema: z.ZodType<T>,
): T | null {
  if (result.error !== null) throw providerError(operation, result.error.code);
  return z.nullable(schema).parse(result.data);
}

function countBy(values: Array<string | null>): Map<string, number> {
  const counts = new Map<string, number>();
  for (const value of values) {
    if (value !== null) counts.set(value, (counts.get(value) ?? 0) + 1);
  }
  return counts;
}

function displayName(key: string): string {
  return agencyDisplayNames.get(key) ?? key;
}

function timeline(value: unknown): DemoCard["timeline"] {
  if (value === null) return null;
  if (!Array.isArray(value))
    throw new Error("Supabase returned invalid timeline");
  return value.map((item) => {
    const row = z
      .object({
        date: z.string().default(""),
        episode_id: z.string().nullable().optional(),
        episodeId: z.string().nullable().optional(),
        text: z.string().nullable().optional(),
      })
      .parse(item);
    return {
      date: row.date,
      episodeId: row.episodeId ?? row.episode_id ?? null,
      text: row.text?.trim() || null,
    };
  });
}

function card(row: GoldenCardRow): DemoCard {
  return {
    articleOverview: null,
    generatedAt: row.generated_at,
    headline: row.headline,
    id: row.id,
    interestReason: row.interest_reason,
    kind: row.kind,
    newestEntryAt: row.newest_entry_at,
    rankKey: row.rank_key,
    summary: row.summary,
    thumbnail: null,
    timeline: timeline(row.timeline),
    version: row.version,
  };
}

class SupabaseDemoRepository implements DemoRepository {
  constructor(private readonly client: SupabaseClient) {}

  private async storylineRows(): Promise<GoldenStorylineRow[]> {
    return rows(
      "golden storylines",
      await this.client
        .from("golden_storylines")
        .select(
          "id,entity_set,event_keys,agency_ids,distinct_feeds,entry_count,episode_count,first_entry_at,newest_entry_at,latest_card_id,merged_into,theme_id,category_id",
        )
        .is("merged_into", null)
        .limit(5000),
      GoldenStorylineRowSchema,
    );
  }

  private async reviewedMemberships(
    storylineId?: string,
  ): Promise<GoldenMembershipRow[]> {
    let query = this.client
      .from("golden_news_entries")
      .select(
        "news_entry_id,gold_episode_id,gold_storyline_id,is_syndicated,reviewed_at",
      )
      .eq("review_status", "reviewed")
      .not("gold_storyline_id", "is", null);
    if (storylineId !== undefined) {
      query = query.eq("gold_storyline_id", storylineId);
    }
    return rows(
      "reviewed golden memberships",
      await query.limit(10000),
      GoldenMembershipRowSchema,
    );
  }

  private async cardsForStorylines(
    storylineIds: string[],
  ): Promise<GoldenCardRow[]> {
    if (storylineIds.length === 0) return [];
    return rows(
      "golden cards",
      await this.client
        .from("golden_event_cards")
        .select(
          "id,storyline_id,episode_id,kind,version,headline,summary,timeline,interest_reason,newest_entry_at,rank_key,generated_at",
        )
        .in("storyline_id", storylineIds)
        .limit(10000),
      GoldenCardRowSchema,
    );
  }

  private async enrichedCards(cards: GoldenCardRow[]): Promise<DemoCard[]> {
    const overviewIds = cards
      .filter((row) => row.kind === "overview")
      .map((row) => row.id);
    if (overviewIds.length === 0) return cards.map(card);
    const storylineIds = [
      ...new Set(
        cards
          .filter((row) => row.kind === "overview")
          .map((row) => row.storyline_id),
      ),
    ];

    const [articleOverviews, thumbnailByStoryline] = await Promise.all([
      rows(
        "golden card article overviews",
        await this.client
          .from("golden_event_card_article_overviews")
          .select("event_card_id,article_overview")
          .in("event_card_id", overviewIds)
          .limit(overviewIds.length),
        GoldenArticleOverviewRowSchema,
      ),
      this.thumbnailsForStorylines(storylineIds),
    ]);
    const articleOverviewByCard = new Map(
      articleOverviews.map((row) => [row.event_card_id, row.article_overview]),
    );

    return cards.map((row) => {
      const shaped = card(row);
      if (row.kind !== "overview") return shaped;
      const thumbnail = thumbnailByStoryline.get(row.storyline_id);
      return {
        ...shaped,
        articleOverview: articleOverviewByCard.get(row.id) ?? null,
        thumbnail:
          thumbnail === undefined
            ? null
            : {
                altText: thumbnail.alt_text,
                cardUrl: `/api/lab/assets/event-cards/${encodeURIComponent(row.id)}/card`,
                focalX: thumbnail.focal_x,
                focalY: thumbnail.focal_y,
              },
      };
    });
  }

  private async thumbnailsForStorylines(
    storylineIds: string[],
  ): Promise<Map<string, z.infer<typeof ImageThumbnailRowSchema>>> {
    if (storylineIds.length === 0) return new Map();
    const storylineThumbnails = rows(
      "golden storyline thumbnails",
      await this.client
        .from("golden_storyline_thumbnails")
        .select("storyline_id,image_id")
        .in("storyline_id", storylineIds)
        .limit(storylineIds.length),
      GoldenStorylineThumbnailRowSchema,
    );
    const imageIds = storylineThumbnails.map((row) => row.image_id);
    const images =
      imageIds.length === 0
        ? []
        : rows(
            "storyline thumbnail images",
            await this.client
              .from("images")
              .select("id,r2_card_key,card_mime_type,alt_text,focal_x,focal_y")
              .in("id", imageIds)
              .limit(imageIds.length),
            ImageThumbnailRowSchema,
          );
    const imageById = new Map(images.map((row) => [row.id, row]));
    return new Map(
      storylineThumbnails.flatMap((row) => {
        const image = imageById.get(row.image_id);
        return image === undefined ? [] : [[row.storyline_id, image] as const];
      }),
    );
  }

  async getCardThumbnailAsset(id: string): Promise<DemoThumbnailAsset | null> {
    const cardRow = nullableRow(
      "golden card thumbnail storyline",
      await this.client
        .from("golden_event_cards")
        .select("id,storyline_id")
        .eq("id", id)
        .maybeSingle(),
      CardStorylineRowSchema,
    );
    if (cardRow === null) return null;
    const association = nullableRow(
      "golden storyline thumbnail association",
      await this.client
        .from("golden_storyline_thumbnails")
        .select("storyline_id,image_id")
        .eq("storyline_id", cardRow.storyline_id)
        .maybeSingle(),
      GoldenStorylineThumbnailRowSchema,
    );
    if (association === null) return null;
    const image = nullableRow(
      "golden storyline thumbnail image",
      await this.client
        .from("images")
        .select("id,r2_card_key,card_mime_type,alt_text,focal_x,focal_y")
        .eq("id", association.image_id)
        .maybeSingle(),
      ImageThumbnailRowSchema,
    );
    return image === null
      ? null
      : { key: image.r2_card_key, mimeType: image.card_mime_type };
  }

  private async categoriesRaw(): Promise<CategoryRow[]> {
    return rows(
      "golden categories",
      await this.client
        .from("golden_topic_categories")
        .select("id,display_name,origin,proposal_reason")
        .order("display_name")
        .limit(1000),
      CategoryRowSchema,
    );
  }

  private async themesRaw(): Promise<ThemeRow[]> {
    return rows(
      "golden themes",
      await this.client
        .from("golden_topic_themes")
        .select(
          "id,display_name,category_id,first_storyline_at,newest_storyline_at,merged_into,name_model",
        )
        .is("merged_into", null)
        .order("display_name")
        .limit(5000),
      ThemeRowSchema,
    );
  }

  private async catalog(): Promise<{
    cards: GoldenCardRow[];
    categories: CategoryRow[];
    items: DemoStorylineListItem[];
    storylines: GoldenStorylineRow[];
    themes: ThemeRow[];
  }> {
    const [storylines, memberships, categories, themes] = await Promise.all([
      this.storylineRows(),
      this.reviewedMemberships(),
      this.categoriesRaw(),
      this.themesRaw(),
    ]);
    const cards = await this.cardsForStorylines(
      storylines.flatMap((row) =>
        row.latest_card_id === null ? [] : [row.id],
      ),
    );
    const cardById = new Map(cards.map((row) => [row.id, row]));
    const firstOverviewAtByStoryline = new Map<string, string>();
    for (const cardRow of cards) {
      if (cardRow.kind !== "overview") continue;
      const current = firstOverviewAtByStoryline.get(cardRow.storyline_id);
      if (current === undefined || cardRow.newest_entry_at < current) {
        firstOverviewAtByStoryline.set(
          cardRow.storyline_id,
          cardRow.newest_entry_at,
        );
      }
    }
    const categoryById = new Map(categories.map((row) => [row.id, row]));
    const themeById = new Map(themes.map((row) => [row.id, row]));
    const reviewedByStoryline = countBy(
      memberships.map((row) => row.gold_storyline_id),
    );
    const rankHistoryByStoryline = new Map<
      string,
      DemoStorylineRankSnapshot[]
    >();
    for (const cardRow of cards) {
      if (cardRow.kind !== "overview") continue;
      const history = rankHistoryByStoryline.get(cardRow.storyline_id) ?? [];
      history.push({
        newestEntryAt: cardRow.newest_entry_at,
        rankKey: cardRow.rank_key,
        version: cardRow.version,
      });
      rankHistoryByStoryline.set(cardRow.storyline_id, history);
    }
    for (const history of rankHistoryByStoryline.values()) {
      history.sort((left, right) => right.version - left.version);
    }

    const items = storylines.map((row) => {
      const latest =
        row.latest_card_id === null
          ? undefined
          : cardById.get(row.latest_card_id);
      const reviewedEntries = reviewedByStoryline.get(row.id) ?? 0;
      return {
        agencies: row.agency_ids,
        categoryName:
          row.category_id === null
            ? null
            : (categoryById.get(row.category_id)?.display_name ?? null),
        distinctFeeds: row.distinct_feeds,
        entities: row.entity_set,
        entryCount: row.entry_count,
        episodeCount: row.episode_count,
        eventKeys: row.event_keys,
        firstEntryAt: row.first_entry_at,
        firstOverviewAt: firstOverviewAtByStoryline.get(row.id) ?? null,
        headline: latest?.headline ?? null,
        id: row.id,
        newestEntryAt: row.newest_entry_at,
        rankKey: latest?.rank_key ?? null,
        rankHistory: rankHistoryByStoryline.get(row.id) ?? [],
        themeId: row.theme_id,
        themeName:
          row.theme_id === null
            ? null
            : (themeById.get(row.theme_id)?.display_name ?? null),
        unreviewedEntryCount: Math.max(row.entry_count - reviewedEntries, 0),
      } satisfies DemoStorylineListItem;
    });
    return { cards, categories, items, storylines, themes };
  }

  private async listItems(): Promise<DemoStorylineListItem[]> {
    return (await this.catalog()).items;
  }

  async listStorylines(limit: number): Promise<{
    hasMore: boolean;
    items: DemoStorylineListItem[];
  }> {
    const reviewed = (await this.listItems())
      .filter((item) => item.unreviewedEntryCount === 0)
      .sort((left, right) => {
        if (left.rankKey === null) return 1;
        if (right.rankKey === null) return -1;
        return right.rankKey - left.rankKey;
      });
    return {
      hasMore: reviewed.length > limit,
      items: reviewed.slice(0, limit),
    };
  }

  async getBootstrap(limit: number): Promise<DemoBootstrap> {
    const catalog = await this.catalog();
    const reviewed = catalog.items
      .filter((item) => item.unreviewedEntryCount === 0)
      .sort((left, right) => {
        if (left.rankKey === null) return 1;
        if (right.rankKey === null) return -1;
        return right.rankKey - left.rankKey;
      });
    const storylines = {
      hasMore: reviewed.length > limit,
      items: reviewed.slice(0, limit),
    };
    const includedStorylineIds = new Set(
      storylines.items.map((item) => item.id),
    );
    const cards = catalog.cards.filter((row) =>
      includedStorylineIds.has(row.storyline_id),
    );
    const thumbnailByStoryline = await this.thumbnailsForStorylines([
      ...includedStorylineIds,
    ]);
    const overviewCardsByStoryline = new Map<
      string,
      DemoStorylinePreviewCard[]
    >();
    for (const cardRow of cards) {
      if (cardRow.kind !== "overview") continue;
      const storylineId = cardRow.storyline_id;
      const grouped = overviewCardsByStoryline.get(storylineId) ?? [];
      const thumbnail = thumbnailByStoryline.get(storylineId);
      grouped.push({
        headline: cardRow.headline,
        id: cardRow.id,
        newestEntryAt: cardRow.newest_entry_at,
        rankKey: cardRow.rank_key,
        summary: cardRow.summary,
        thumbnail:
          thumbnail === undefined
            ? null
            : {
                altText: thumbnail.alt_text,
                cardUrl: `/api/lab/assets/event-cards/${encodeURIComponent(cardRow.id)}/card`,
                focalX: thumbnail.focal_x,
                focalY: thumbnail.focal_y,
              },
        version: cardRow.version,
      });
      overviewCardsByStoryline.set(storylineId, grouped);
    }

    return {
      agencies: [...new Set(storylines.items.flatMap((item) => item.agencies))]
        .map((key) => ({ displayName: displayName(key), key }))
        .sort((left, right) =>
          left.displayName.localeCompare(right.displayName),
        ),
      categories: catalog.categories.map((row) => ({
        displayName: row.display_name,
        id: row.id,
        origin: row.origin,
        proposalReason: row.proposal_reason,
        storylineCount: catalog.storylines.filter(
          (storyline) => storyline.category_id === row.id,
        ).length,
        themeCount: catalog.themes.filter(
          (theme) => theme.category_id === row.id,
        ).length,
      })),
      previews: storylines.items.map((item) => ({
        overviewCards: (overviewCardsByStoryline.get(item.id) ?? []).sort(
          (left, right) => right.version - left.version,
        ),
        storylineId: item.id,
      })),
      storylines,
      themes: catalog.themes
        .map((row) => ({
          categoryId: row.category_id,
          categoryName:
            row.category_id === null
              ? null
              : (catalog.categories.find(
                  (category) => category.id === row.category_id,
                )?.display_name ?? null),
          displayName: row.display_name,
          firstStorylineAt: row.first_storyline_at,
          id: row.id,
          manuallySet: row.name_model === "golden-human",
          newestStorylineAt: row.newest_storyline_at,
          storylineCount: catalog.storylines.filter(
            (storyline) => storyline.theme_id === row.id,
          ).length,
        }))
        .sort(
          (left, right) =>
            right.storylineCount - left.storylineCount ||
            left.displayName.localeCompare(right.displayName),
        ),
    };
  }

  async listAgencies(): Promise<DemoAgency[]> {
    const keys = new Set(
      (await this.listItems()).flatMap((row) => row.agencies),
    );
    return [...keys]
      .map((key) => ({ displayName: displayName(key), key }))
      .sort((left, right) => left.displayName.localeCompare(right.displayName));
  }

  async listCategories(): Promise<DemoCategory[]> {
    const [categories, themes, storylines] = await Promise.all([
      this.categoriesRaw(),
      this.themesRaw(),
      this.storylineRows(),
    ]);
    const themeCounts = countBy(themes.map((row) => row.category_id));
    const storylineCounts = countBy(storylines.map((row) => row.category_id));
    return categories.map((row) => ({
      displayName: row.display_name,
      id: row.id,
      origin: row.origin,
      proposalReason: row.proposal_reason,
      storylineCount: storylineCounts.get(row.id) ?? 0,
      themeCount: themeCounts.get(row.id) ?? 0,
    }));
  }

  async listThemes(): Promise<DemoTheme[]> {
    const [themes, categories, storylines] = await Promise.all([
      this.themesRaw(),
      this.categoriesRaw(),
      this.storylineRows(),
    ]);
    const categoryById = new Map(categories.map((row) => [row.id, row]));
    const storylineCounts = countBy(storylines.map((row) => row.theme_id));
    return themes
      .map((row) => ({
        categoryId: row.category_id,
        categoryName:
          row.category_id === null
            ? null
            : (categoryById.get(row.category_id)?.display_name ?? null),
        displayName: row.display_name,
        firstStorylineAt: row.first_storyline_at,
        id: row.id,
        manuallySet: row.name_model === "golden-human",
        newestStorylineAt: row.newest_storyline_at,
        storylineCount: storylineCounts.get(row.id) ?? 0,
      }))
      .sort(
        (left, right) =>
          right.storylineCount - left.storylineCount ||
          left.displayName.localeCompare(right.displayName),
      );
  }

  async getStoryline(id: string): Promise<DemoStorylineDetail | null> {
    const storyline = nullableRow(
      "golden storyline",
      await this.client
        .from("golden_storylines")
        .select(
          "id,entity_set,event_keys,agency_ids,distinct_feeds,entry_count,episode_count,first_entry_at,newest_entry_at,latest_card_id,merged_into,theme_id,category_id",
        )
        .eq("id", id)
        .is("merged_into", null)
        .maybeSingle(),
      GoldenStorylineRowSchema,
    );
    if (storyline === null) return null;

    const [memberships, episodeResult, cards, categories, themes] =
      await Promise.all([
        this.reviewedMemberships(id),
        this.client
          .from("golden_episodes")
          .select(
            "id,storyline_id,status,entry_count,first_entry_at,newest_entry_at,attach_method,attach_reason",
          )
          .eq("storyline_id", id)
          .order("first_entry_at", { ascending: false })
          .limit(5000),
        this.cardsForStorylines([id]),
        this.categoriesRaw(),
        this.themesRaw(),
      ]);
    const unreviewedEntryCount = Math.max(
      storyline.entry_count - memberships.length,
      0,
    );
    if (unreviewedEntryCount !== 0) return null;

    const episodes = rows(
      "golden episodes",
      episodeResult,
      GoldenEpisodeRowSchema,
    );
    const entryIds = memberships.map((row) => row.news_entry_id);
    const newsEntries =
      entryIds.length === 0
        ? []
        : rows(
            "golden source entries",
            await this.client
              .from("news_entries")
              .select(
                "id,news_source_id,url,title,published_at,entity_set,event_keys",
              )
              .in("id", entryIds)
              .limit(10000),
            NewsEntryRowSchema,
          );
    const sourceIds = [
      ...new Set(newsEntries.map((row) => row.news_source_id)),
    ];
    const publishers =
      sourceIds.length === 0
        ? []
        : rows(
            "golden source publishers",
            await this.client
              .from("news_source_publishers")
              .select("news_source_id,publisher_key")
              .in("news_source_id", sourceIds)
              .limit(10000),
            PublisherRowSchema,
          );
    const membershipByEntry = new Map(
      memberships.map((row) => [row.news_entry_id, row]),
    );
    const publisherBySource = new Map(
      publishers.map((row) => [row.news_source_id, row.publisher_key]),
    );
    const entriesByEpisode = new Map<string, DemoEntry[]>();
    for (const entry of newsEntries) {
      const membership = membershipByEntry.get(entry.id);
      if (membership?.gold_episode_id === null || membership === undefined) {
        throw new Error("Reviewed golden entry is missing an episode");
      }
      const agency = publisherBySource.get(entry.news_source_id);
      if (agency === undefined) {
        throw new Error(
          "Reviewed golden entry is missing publisher attribution",
        );
      }
      const shaped: DemoEntry = {
        agency,
        attachMethod: "golden_review",
        entitySet: entry.entity_set,
        eventKeys: entry.event_keys,
        id: entry.id,
        isSyndicated: membership.is_syndicated,
        matchedEntryId: null,
        publishedAt: entry.published_at,
        similarity: null,
        thresholdUsed: null,
        title: entry.title,
        url: entry.url,
      };
      const grouped = entriesByEpisode.get(membership.gold_episode_id) ?? [];
      grouped.push(shaped);
      entriesByEpisode.set(membership.gold_episode_id, grouped);
    }

    const enrichedCards = await this.enrichedCards(cards);
    const enrichedCardById = new Map(
      enrichedCards.map((enriched) => [enriched.id, enriched]),
    );
    const episodeCards = new Map(
      cards.flatMap((row) =>
        row.kind === "episode" && row.episode_id !== null
          ? [[row.episode_id, enrichedCardById.get(row.id)] as const]
          : [],
      ),
    );
    const overviewCards = enrichedCards
      .filter((row) => row.kind === "overview")
      .sort((left, right) => right.version - left.version);
    const categoryById = new Map(categories.map((row) => [row.id, row]));
    const themeById = new Map(themes.map((row) => [row.id, row]));
    const latest =
      storyline.latest_card_id === null
        ? undefined
        : cards.find((row) => row.id === storyline.latest_card_id);

    return {
      agencies: storyline.agency_ids,
      categoryId: storyline.category_id,
      categoryName:
        storyline.category_id === null
          ? null
          : (categoryById.get(storyline.category_id)?.display_name ?? null),
      distinctFeeds: storyline.distinct_feeds,
      entities: storyline.entity_set,
      entryCount: storyline.entry_count,
      episodeCount: storyline.episode_count,
      episodes: episodes.map((episode) => ({
        attachMethod: episode.attach_method,
        attachReason: episode.attach_reason,
        card: episodeCards.get(episode.id) ?? null,
        entries: (entriesByEpisode.get(episode.id) ?? []).sort((left, right) =>
          (left.publishedAt ?? "").localeCompare(right.publishedAt ?? ""),
        ),
        entryCount: episode.entry_count,
        firstEntryAt: episode.first_entry_at,
        id: episode.id,
        newestEntryAt: episode.newest_entry_at,
        status: episode.status,
      })),
      eventKeys: storyline.event_keys,
      firstEntryAt: storyline.first_entry_at,
      firstOverviewAt: overviewCards.at(-1)?.newestEntryAt ?? null,
      headline: latest?.headline ?? null,
      id: storyline.id,
      newestEntryAt: storyline.newest_entry_at,
      overviewCards,
      rankKey: latest?.rank_key ?? null,
      themeId: storyline.theme_id,
      themeName:
        storyline.theme_id === null
          ? null
          : (themeById.get(storyline.theme_id)?.display_name ?? null),
      unreviewedEntryCount,
    };
  }

  private async sourceRun(): Promise<{
    config: Record<string, unknown>;
    id: string;
    name: string;
  } | null> {
    const cards = rows(
      "golden source run",
      await this.client
        .from("golden_event_cards")
        .select("source_run_id")
        .limit(10000),
      z.object({ source_run_id: z.string() }),
    );
    const ids = [...new Set(cards.map((row) => row.source_run_id))];
    if (ids.length === 0) return null;
    if (ids.length !== 1)
      throw new Error("Golden cards reference multiple source runs");
    const sourceRunId = ids[0];
    if (sourceRunId === undefined) return null;
    const run = nullableRow(
      "golden experiment run",
      await this.client
        .from("simple_v1_experiment_runs")
        .select("id,name,config")
        .eq("id", sourceRunId)
        .maybeSingle(),
      ExperimentRunRowSchema,
    );
    return run === null
      ? null
      : { config: run.config ?? {}, id: run.id, name: run.name };
  }

  async getRankOverview(): Promise<DemoRankOverview | null> {
    const sourceRun = await this.sourceRun();
    if (sourceRun === null) return null;
    const [memberships, storylines, agencies, categories, themes] =
      await Promise.all([
        this.reviewedMemberships(),
        this.storylineRows(),
        this.listAgencies(),
        this.listCategories(),
        this.listThemes(),
      ]);
    const reviewedAt = memberships
      .flatMap((row) => (row.reviewed_at === null ? [] : [row.reviewed_at]))
      .sort()
      .at(-1);
    return {
      dataset: {
        reviewedAt: reviewedAt ?? null,
        reviewedEntries: memberships.length,
        sourceRunName: sourceRun.name,
        storylines: storylines.length,
      },
      filters: { agencies, categories, themes },
    };
  }

  async listRankRows(filter: {
    agency?: string;
    category?: string;
    limit: number;
    theme?: string;
  }): Promise<DemoRankRow[]> {
    const sourceRun = await this.sourceRun();
    if (sourceRun === null) return [];
    const [allStorylines, memberships] = await Promise.all([
      this.storylineRows(),
      this.reviewedMemberships(),
    ]);
    const reviewedByStoryline = countBy(
      memberships.map((row) => row.gold_storyline_id),
    );
    const storylines = allStorylines.filter(
      (row) =>
        (reviewedByStoryline.get(row.id) ?? 0) === row.entry_count &&
        (filter.agency === undefined ||
          row.agency_ids.includes(filter.agency)) &&
        (filter.category === undefined ||
          row.category_id === filter.category) &&
        (filter.theme === undefined || row.theme_id === filter.theme),
    );
    if (storylines.length === 0) return [];
    const storylineById = new Map(storylines.map((row) => [row.id, row]));
    const snapshots = rows(
      "golden rank snapshot",
      await this.client
        .from("simple_v1_rank_snapshots")
        .select(
          "position,storyline_id,card_id,rank_key,terms,headline,summary,interest_reason,agencies,feeds,entry_count,newest_entry_at",
        )
        .eq("run_id", sourceRun.id)
        .eq("facet_type", "global")
        .eq("facet_key", "")
        .in(
          "storyline_id",
          storylines.map((row) => row.id),
        )
        .order("position")
        .limit(5000),
      RankSnapshotRowSchema,
    );
    return snapshots
      .filter((row) => {
        const storyline = storylineById.get(row.storyline_id);
        return storyline?.latest_card_id === row.card_id;
      })
      .slice(0, filter.limit)
      .map((row) => {
        const storyline = storylineById.get(row.storyline_id);
        const sourceKey =
          row.terms.source_key ?? storyline?.agency_ids.at(0) ?? null;
        return {
          agencies: row.agencies,
          entryCount: row.entry_count,
          feeds: row.feeds,
          headline: row.headline,
          interestReason: row.interest_reason,
          newestEntryAt: row.newest_entry_at,
          position: row.position,
          rankKey: row.rank_key,
          sourceKey,
          sourceName: sourceKey === null ? null : displayName(sourceKey),
          storylineId: row.storyline_id,
          summary: row.summary,
          terms: row.terms,
        };
      });
  }
}

export function createDemoRepositoryFromClient(
  client: SupabaseClient,
): DemoRepository {
  return new SupabaseDemoRepository(client);
}

export function createDemoRepository(
  config: DemoRepositoryConfig,
): DemoRepository {
  const client = createClient(config.supabaseUrl, config.supabaseKey, {
    auth: {
      autoRefreshToken: false,
      detectSessionInUrl: false,
      persistSession: false,
    },
  });
  return createDemoRepositoryFromClient(client);
}
