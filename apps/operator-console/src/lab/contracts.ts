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
  distinctFeeds: z.number(),
  entities: z.array(z.string()),
  entryCount: z.number(),
  episodeCount: z.number(),
  eventKeys: z.array(z.string()),
  firstEntryAt: z.string(),
  headline: z.string().nullable(),
  id: z.string(),
  newestEntryAt: z.string(),
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
  episodes: z.array(EpisodeDetailSchema),
  overviewCards: z.array(EventCardSchema),
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
  top_chains: z.array(
    z.object({ episodes: z.number(), headline: z.string() }),
  ),
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
  startedAt: z.string(),
  summary: ExperimentSummarySchema.nullable(),
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
