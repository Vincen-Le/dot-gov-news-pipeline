import { z } from "zod";

export const AgencyOptionSchema = z
  .union([z.string(), z.object({ displayName: z.string(), key: z.string() })])
  .transform((value) =>
    typeof value === "string" ? { displayName: value, key: value } : value,
  );

export const StorylineListItemSchema = z.object({
  agencies: z.array(z.string()),
  categoryName: z.string().nullable(),
  distinctFeeds: z.number(),
  entities: z.array(z.string()),
  entryCount: z.number(),
  episodeCount: z.number(),
  eventKeys: z.array(z.string()),
  firstEntryAt: z.string(),
  firstOverviewAt: z.string().nullable(),
  headline: z.string().nullable(),
  id: z.string(),
  newestEntryAt: z.string(),
  rankKey: z.number().nullable().default(null),
  rankHistory: z
    .array(
      z.object({
        newestEntryAt: z.string(),
        rankKey: z.number(),
        version: z.number().int().positive(),
      }),
    )
    .optional(),
  themeId: z.string().nullable(),
  themeName: z.string().nullable(),
  unreviewedEntryCount: z.number().int().nonnegative(),
});

export const EntrySchema = z.object({
  agency: z.string(),
  attachMethod: z.string(),
  entitySet: z.array(z.string()),
  eventKeys: z.array(z.string()),
  id: z.string(),
  matchedEntryId: z.string().nullable(),
  publishedAt: z.string().nullable(),
  similarity: z.number().nullable(),
  thresholdUsed: z.number().nullable(),
  title: z.string().nullable(),
  url: z.string(),
});

export const ArticleOverviewCitationSchema = z.object({
  sourceEntryIds: z.array(z.string()).min(1),
  text: z.string(),
});

export const ArticleOverviewSchema = z.object({
  keyPoints: z.array(ArticleOverviewCitationSchema).min(2).max(5),
  summary: ArticleOverviewCitationSchema,
});

export const ThumbnailSchema = z.object({
  altText: z.string().min(1),
  cardUrl: z.string().min(1),
  focalX: z.number().min(0).max(1),
  focalY: z.number().min(0).max(1),
});

export const CardSchema = z.object({
  articleOverview: ArticleOverviewSchema.nullable().default(null),
  generatedAt: z.string(),
  headline: z.string(),
  id: z.string(),
  interestReason: z.string().nullable(),
  kind: z.enum(["overview", "episode"]),
  newestEntryAt: z.string(),
  rankKey: z.number(),
  summary: z.string(),
  thumbnail: ThumbnailSchema.nullable().default(null),
  timeline: z
    .array(
      z.object({
        date: z.string(),
        episodeId: z.string().nullable(),
        text: z.string().nullable().optional().default(null),
      }),
    )
    .nullable(),
  version: z.number(),
});

export const EpisodeSchema = z.object({
  attachMethod: z.string(),
  attachReason: z.string().nullable(),
  card: CardSchema.nullable(),
  entries: z.array(EntrySchema),
  entryCount: z.number(),
  firstEntryAt: z.string(),
  id: z.string(),
  newestEntryAt: z.string(),
  status: z.enum(["open", "dormant"]),
});

export const StorylineDetailSchema = StorylineListItemSchema.extend({
  categoryId: z.string().nullable(),
  episodes: z.array(EpisodeSchema),
  overviewCards: z.array(CardSchema),
});

export const CategorySchema = z.object({
  displayName: z.string(),
  id: z.string(),
  origin: z.enum(["seed", "llm"]),
  proposalReason: z.string().nullable(),
  storylineCount: z.number().default(0),
  themeCount: z.number(),
});

export const ThemeSchema = z.object({
  categoryId: z.string().nullable(),
  categoryName: z.string().nullable(),
  displayName: z.string(),
  firstStorylineAt: z.string().nullable().optional().default(null),
  id: z.string(),
  manuallySet: z.boolean().optional().default(false),
  newestStorylineAt: z.string().nullable(),
  storylineCount: z.number(),
});

export const RankTermsSchema = z
  .object({
    agency_term: z.number(),
    feed_term: z.number(),
    freshness_term: z.number(),
    prior_used: z.boolean(),
    rubric_points: z.number(),
    source_term: z.number(),
  })
  .transform((terms) => ({
    agencyTerm: terms.agency_term,
    feedTerm: terms.feed_term,
    freshnessTerm: terms.freshness_term,
    priorUsed: terms.prior_used,
    rubricPoints: terms.rubric_points,
    sourceTerm: terms.source_term,
  }));

export const RankRowSchema = z.object({
  agencies: z.number(),
  entryCount: z.number(),
  feeds: z.number(),
  headline: z.string().nullable(),
  interestReason: z.string().nullable(),
  newestEntryAt: z.string().nullable(),
  position: z.number(),
  rankKey: z.number(),
  sourceKey: z.string().nullable().default(null),
  sourceName: z.string().nullable().default(null),
  storylineId: z.string(),
  summary: z.string().nullable(),
  terms: RankTermsSchema,
});

export const RankDatasetSchema = z
  .object({
    reviewedAt: z.string().nullable(),
    reviewedEntries: z.number(),
    sourceRunName: z.string(),
    storylines: z.number(),
  })
  .transform((dataset) => ({
    approvedAt: dataset.reviewedAt,
    approvedEntries: dataset.reviewedEntries,
    sourceRunName: dataset.sourceRunName,
    storylines: dataset.storylines,
  }));

export type AgencyOption = z.infer<typeof AgencyOptionSchema>;
export type ArticleOverview = z.infer<typeof ArticleOverviewSchema>;
export type Card = z.infer<typeof CardSchema>;
export type Category = z.infer<typeof CategorySchema>;
export type Episode = z.infer<typeof EpisodeSchema>;
export type RankRow = z.infer<typeof RankRowSchema>;
export type StorylineDetail = z.infer<typeof StorylineDetailSchema>;
export type StorylineListItem = z.infer<typeof StorylineListItemSchema>;
export type Theme = z.infer<typeof ThemeSchema>;
export type Thumbnail = z.infer<typeof ThumbnailSchema>;
