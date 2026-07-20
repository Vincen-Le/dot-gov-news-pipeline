import { z } from "zod";

export const LabCapabilitySchema = z.object({
  experimentsEnabled: z.boolean(),
  experimentsReason: z.string().optional(),
  reason: z.string().optional(),
  status: z.enum(["available", "not_enabled"]),
});

export const CorpusSummarySchema = z.object({
  agencies: z.array(z.object({ agency: z.string(), entries: z.number() })),
  clustered: z.number(),
  embedded: z.number(),
  enriched: z.number(),
  entries: z.number(),
  extracted: z.number(),
  firstPublishedAt: z.string().nullable(),
  lastPublishedAt: z.string().nullable(),
  needsPrepare: z.number(),
  sources: z.number(),
});

export const StorylineListItemSchema = z.object({
  agencies: z.array(z.string()),
  categoryName: z.string().nullable(),
  distinctFeeds: z.number(),
  entities: z.array(z.string()),
  entryCount: z.number(),
  episodeCount: z.number(),
  eventKeys: z.array(z.string()),
  firstEntryAt: z.string(),
  headline: z.string().nullable(),
  id: z.string(),
  newestEntryAt: z.string(),
  rankKey: z.number().nullable().default(null),
  themeId: z.string().nullable(),
  themeName: z.string().nullable(),
});

export const EntryEvidenceSchema = z.object({
  agency: z.string(),
  attachMethod: z.string(),
  entitySet: z.array(z.string()),
  eventKeys: z.array(z.string()),
  id: z.string(),
  isSyndicated: z.boolean(),
  matchedEntryId: z.string().nullable(),
  publishedAt: z.string().nullable(),
  similarity: z.number().nullable(),
  thresholdUsed: z.number().nullable(),
  title: z.string().nullable(),
  url: z.string(),
});

export const EventCardSchema = z.object({
  generatedAt: z.string(),
  headline: z.string(),
  id: z.string(),
  interestReason: z.string().nullable(),
  judgeModel: z.string().nullable(),
  kind: z.enum(["overview", "episode"]),
  rankKey: z.number(),
  rubric: z.record(z.string(), z.unknown()).nullable(),
  summary: z.string(),
  supersededBy: z.string().nullable(),
  timeline: z
    .array(
      z.object({
        cited: z.boolean(),
        date: z.string(),
        episodeId: z.string().nullable(),
        text: z.string(),
      }),
    )
    .nullable(),
  version: z.number(),
});

export const EpisodeDetailSchema = z.object({
  adjudicatorModel: z.string().nullable(),
  attachMethod: z.string(),
  attachReason: z.string().nullable(),
  attachSimilarity: z.number().nullable(),
  card: EventCardSchema.nullable(),
  entitySet: z.array(z.string()),
  entries: z.array(EntryEvidenceSchema),
  entryCount: z.number(),
  eventKeys: z.array(z.string()),
  firstEntryAt: z.string(),
  id: z.string(),
  newestEntryAt: z.string(),
  status: z.enum(["open", "dormant"]),
});

export const StorylineDetailSchema = StorylineListItemSchema.extend({
  categoryId: z.string().nullable(),
  episodes: z.array(EpisodeDetailSchema),
  overviewCards: z.array(EventCardSchema),
  themeAttachMethod: z.string().nullable(),
  themeReason: z.string().nullable(),
  themeSimilarity: z.number().nullable(),
});

export const TopicCategorySchema = z.object({
  displayName: z.string(),
  id: z.string(),
  origin: z.enum(["seed", "llm"]),
  proposalReason: z.string().nullable(),
  storylineCount: z.number().default(0),
  themeCount: z.number(),
});

export const AgencyOptionSchema = z
  .union([z.string(), z.object({ displayName: z.string(), key: z.string() })])
  .transform((value) =>
    typeof value === "string" ? { displayName: value, key: value } : value,
  );

export const TopicThemeSchema = z.object({
  categoryId: z.string().nullable(),
  categoryName: z.string().nullable(),
  categoryOrigin: z.enum(["seed", "llm"]).nullable(),
  displayName: z.string(),
  id: z.string(),
  newestStorylineAt: z.string().nullable(),
  storylineCount: z.number(),
});

export const BorderlinePairSchema = z.object({
  attachMethod: z.string(),
  entryId: z.string(),
  entryTitle: z.string().nullable(),
  matchedEntryId: z.string().nullable(),
  matchedTitle: z.string().nullable(),
  similarity: z.number(),
  thresholdUsed: z.number(),
});

// pipeline/experiment.py::summarize() output, snake_case verbatim; loose so
// future summarize() additions never break the dashboard.
export const ExperimentSummarySchema = z.looseObject({
  cards: z.number(),
  entries_clustered: z.number(),
  entry_attach_mix: z.record(z.string(), z.number()),
  episode_attach_mix: z.record(z.string(), z.number()),
  episodes: z.number(),
  multi_episode_storylines: z.number(),
  singleton_episode_rate: z.number().nullable(),
  storylines: z.number(),
  top_chains: z.array(z.object({ episodes: z.number(), headline: z.string() })),
});

export const ExperimentRunSchema = z.object({
  cacheHits: z.number(),
  cacheMisses: z.number(),
  clusterReport: z
    .looseObject({ episodes_closed: z.number(), processed: z.number() })
    .nullable(),
  config: z.record(z.string(), z.unknown()).nullable(),
  createdAt: z.string(),
  durationSeconds: z.number(),
  finishedAt: z.string(),
  id: z.string(),
  name: z.string(),
  snapshot: z
    .object({
      capturedAt: z.string(),
      isBest: z.boolean(),
      note: z.string().nullable(),
      reward: z.record(z.string(), z.unknown()).nullable(),
      rowCounts: z.record(z.string(), z.number()),
      schemaVersion: z.number(),
    })
    .nullable()
    .default(null),
  startedAt: z.string(),
  summary: ExperimentSummarySchema.nullable(),
});

export const RankTermsSchema = z.object({
  agency_term: z.number(),
  feed_term: z.number(),
  freshness_term: z.number(),
  prior_used: z.boolean(),
  rubric_points: z.number(),
  source_term: z.number(),
});

export const RankSnapshotRowSchema = z.object({
  agencies: z.number(),
  cardId: z.string(),
  entryCount: z.number(),
  facetKey: z.string(),
  facetType: z.string(),
  feeds: z.number(),
  headline: z.string().nullable(),
  interestReason: z.string().nullable(),
  judged: z.boolean(),
  newestEntryAt: z.string().nullable(),
  position: z.number(),
  rankKey: z.number(),
  rubric: z.record(z.string(), z.unknown()).nullable(),
  storylineId: z.string(),
  summary: z.string().nullable(),
  termsAvailable: z.boolean().default(true),
  terms: RankTermsSchema,
});

export const RankFacetSchema = z.object({
  facetKey: z.string(),
  facetType: z.string(),
  rows: z.number(),
});

export const RankAuditPairSchema = z.object({
  facetKey: z.string(),
  facetType: z.string(),
  llmPrefers: z.enum(["a", "b", "inconsistent"]),
  llmReason: z.string().nullable(),
  positionA: z.number(),
  positionB: z.number(),
  runId: z.string(),
  storylineA: z.string(),
  storylineB: z.string(),
});

export const RankAuditRunSchema = z.object({
  createdAt: z.string(),
  id: z.string(),
  metrics: z.record(z.string(), z.unknown()).nullable(),
  runId: z.string(),
});

export const RankExperimentSchema = z.object({
  createdAt: z.string(),
  dataCutoffAt: z.string().nullable(),
  id: z.string(),
  name: z.string(),
  rankSystemVersionId: z.string(),
  rankSystemVersionNumber: z.number(),
  sourceRunId: z.string().nullable(),
  status: z.string(),
});

const FrozenEpisodeSchema = z.object({
  firstEntryAt: z.string().nullable(),
  headline: z.string().nullable(),
  id: z.string(),
  newestEntryAt: z.string().nullable(),
  summary: z.string().nullable(),
});

const FrozenSourceEntrySchema = z.object({
  agencies: z.array(z.string()),
  contentHash: z.string(),
  episodeId: z.string().nullable(),
  id: z.string(),
  isSyndicated: z.boolean().nullable(),
  publishedAt: z.string().nullable(),
  title: z.string().nullable(),
  url: z.string(),
});

export const RankRowDetailSchema = z.object({
  calculation: z.object({
    formulaKey: z.string(),
    rankInput: z.record(z.string(), z.unknown()),
    rankKey: z.number(),
    rubricDecisions: z.array(z.object({ key: z.string(), value: z.boolean() })),
    termBreakdown: z.array(
      z.object({ key: z.string(), label: z.string(), value: z.number() }),
    ),
  }),
  categoryNeighbors: z.array(
    z.object({
      categoryPosition: z.number(),
      goldenEventCardId: z.string(),
      headline: z.string(),
      rankKey: z.number(),
      relation: z.enum(["above", "target", "below"]),
    }),
  ),
  identity: z.object({
    experimentId: z.string(),
    goldenEventCardId: z.string(),
    rankSystemVersionId: z.string(),
    rankSystemVersionNumber: z.number(),
    storylineId: z.string(),
  }),
  positionOpinion: z
    .object({
      currentCategoryPosition: z.number(),
      direction: z.enum(["up", "down", "stay", "uncertain"]),
      positionDelta: z.number().nullable(),
      reason: z.string().nullable(),
      status: z.enum([
        "available",
        "bounded",
        "not_run",
        "insufficient_neighbors",
        "inconsistent",
        "failed",
      ]),
      suggestedCategoryPosition: z.number().nullable(),
    })
    .nullable(),
  provenance: z.object({
    codeCommit: z.string().nullable(),
    configHash: z.string(),
    contextHash: z.string(),
    dataSnapshotHash: z.string().nullable(),
    experimentStatus: z.string(),
    rankInputHash: z.string(),
  }),
  storylineSnapshot: z.object({
    agencies: z.array(z.string()),
    categoryId: z.string().nullable(),
    entryCount: z.number(),
    episodes: z.array(FrozenEpisodeSchema),
    headline: z.string(),
    knowledgeCutoffAt: z.string(),
    sourceEntries: z.array(FrozenSourceEntrySchema),
    summary: z.string(),
    themeId: z.string().nullable(),
    timeline: z.array(z.record(z.string(), z.unknown())),
  }),
});

export function labResponse<T extends z.ZodType>(schema: T) {
  return z.object({ data: schema });
}

export type LabCapability = z.infer<typeof LabCapabilitySchema>;
export type CorpusSummary = z.infer<typeof CorpusSummarySchema>;
export type StorylineListItem = z.infer<typeof StorylineListItemSchema>;
export type EntryEvidence = z.infer<typeof EntryEvidenceSchema>;
export type EventCard = z.infer<typeof EventCardSchema>;
export type EpisodeDetail = z.infer<typeof EpisodeDetailSchema>;
export type StorylineDetail = z.infer<typeof StorylineDetailSchema>;
export type BorderlinePair = z.infer<typeof BorderlinePairSchema>;
export type ExperimentSummary = z.infer<typeof ExperimentSummarySchema>;
export type ExperimentRun = z.infer<typeof ExperimentRunSchema>;
export type TopicCategory = z.infer<typeof TopicCategorySchema>;
export type TopicTheme = z.infer<typeof TopicThemeSchema>;
export type RankTerms = z.infer<typeof RankTermsSchema>;
export type RankSnapshotRow = z.infer<typeof RankSnapshotRowSchema>;
export type RankFacet = z.infer<typeof RankFacetSchema>;
export type RankAuditPair = z.infer<typeof RankAuditPairSchema>;
export type RankAuditRun = z.infer<typeof RankAuditRunSchema>;
export type RankExperiment = z.infer<typeof RankExperimentSchema>;
export type RankRowDetail = z.infer<typeof RankRowDetailSchema>;
