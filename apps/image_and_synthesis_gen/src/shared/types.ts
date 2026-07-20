import { z } from "zod";

export const SHA256_PATTERN = /^[0-9a-f]{64}$/u;
export const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;

const Sha256Schema = z.string().regex(SHA256_PATTERN);
const UuidSchema = z.string().regex(UUID_PATTERN);
const IsoDateTimeSchema = z.iso.datetime({ offset: true });

const TimelineItemSchema = z
  .object({
    date: z.string(),
    episodeId: z.string().nullable(),
    text: z.string().optional(),
  })
  .strict();

export const OverviewInputBasisSchema = z
  .object({
    card: z
      .object({
        headline: z.string().min(1),
        interestReason: z.string().nullable(),
        newestEntryAt: IsoDateTimeSchema,
        summary: z.string().min(1),
        timeline: z.array(TimelineItemSchema).nullable(),
        version: z.number().int().positive(),
      })
      .strict(),
    enrichmentVersion: z.literal(1),
    imagePromptInput: z
      .object({
        agencies: z.array(z.string()),
        category: z.string().nullable(),
        entities: z.array(z.string()),
        eventKeys: z.array(z.string()),
        headline: z.string().min(1),
        summary: z.string().min(1),
        theme: z.string().nullable(),
      })
      .strict(),
    promptVersion: z.literal(1),
    schemaVersion: z.literal("overview-enrichment-input.v1"),
    sources: z.array(
      z
        .object({
          agency: z.string().min(1).max(512),
          bodyText: z.string().nullable(),
          contentHash: Sha256Schema,
          entitySet: z.array(z.string()),
          eventKeys: z.array(z.string()),
          isSyndicated: z.boolean(),
          newsEntryId: UuidSchema,
          publishedAt: IsoDateTimeSchema,
          publisherKey: z.string().min(1).max(128),
          publisherSummary: z.string().nullable(),
          sourceTitle: z.string().nullable(),
          title: z.string().min(1).max(1024),
          url: z.url(),
        })
        .strict(),
    ),
    storyline: z
      .object({
        category: z.string().nullable(),
        entities: z.array(z.string()),
        eventKeys: z.array(z.string()),
        storylineId: UuidSchema,
        theme: z.string().nullable(),
      })
      .strict(),
  })
  .strict();

export const OverviewTaskSchema = z
  .object({
    eventCardId: UuidSchema,
    inputBasis: OverviewInputBasisSchema,
    inputHash: Sha256Schema,
    partition: z.number().int().nonnegative(),
    taskKey: z.string().min(1),
  })
  .strict();

const CitationSchema = z
  .object({
    sourceEntryIds: z.array(UuidSchema).min(1),
    text: z.string().min(1),
  })
  .strict();

export const ArticleOverviewV2Schema = z
  .object({
    keyPoints: z.array(CitationSchema).min(2).max(5),
    summary: CitationSchema,
  })
  .strict();

export const ArticleOverviewEnrichmentV2Schema = z
  .object({
    articleOverview: ArticleOverviewV2Schema,
    enrichmentVersion: z.literal(2),
    eventCardId: UuidSchema,
    generatedAt: IsoDateTimeSchema,
    inputHash: Sha256Schema,
    model: z.string().min(1).max(256),
    promptHash: Sha256Schema,
    promptVersion: z.literal(2),
    schemaVersion: z.literal("article-overview.v2"),
    sourceCutoffAt: IsoDateTimeSchema,
    sourceEntryIds: z.array(UuidSchema).min(1),
  })
  .strict();

export const OverviewEnrichmentSchema = z
  .object({
    articleOverview: z
      .object({
        keyDetails: z.array(CitationSchema).min(3).max(5),
        whatChangedAcrossUpdates: CitationSchema,
        whatRemainsUnresolved: CitationSchema.nullable(),
        whatSourcesEstablish: CitationSchema,
      })
      .strict(),
    enrichmentVersion: z.literal(1),
    eventCardId: UuidSchema,
    generatedAt: IsoDateTimeSchema,
    image: z
      .object({
        altText: z.string().min(1).max(512),
        focalPoint: z
          .object({
            x: z.number().min(0).max(1),
            y: z.number().min(0).max(1),
          })
          .strict(),
        imageConcept: z.string().min(1).max(2048),
        imageModel: z.string().min(1).max(256),
        masterPath: z.string().min(1),
        masterSha256: Sha256Schema,
        mediaType: z.enum(["image/jpeg", "image/png", "image/webp"]),
        promptHash: Sha256Schema,
        promptVersion: z.literal(1),
        width: z.number().int().min(1536),
        height: z.number().int().min(1024),
      })
      .strict(),
    inputHash: Sha256Schema,
    model: z.string().min(1).max(256),
    promptHash: Sha256Schema,
    promptVersion: z.literal(1),
    schemaVersion: z.literal("overview-enrichment.v1"),
    sourceEntryIds: z.array(UuidSchema).min(1),
  })
  .strict();

export type OverviewEnrichment = z.infer<typeof OverviewEnrichmentSchema>;
export type ArticleOverviewEnrichmentV2 = z.infer<
  typeof ArticleOverviewEnrichmentV2Schema
>;
export type OverviewInputBasis = z.infer<typeof OverviewInputBasisSchema>;
export type OverviewTask = z.infer<typeof OverviewTaskSchema>;

export interface ExportIndex {
  cardCount: number;
  exportedAt: string;
  partitionCount: number;
  schemaVersion: "golden-enrichment-export.v1";
}
