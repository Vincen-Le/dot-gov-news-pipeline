import { z } from "zod";

export const OPERATOR_API_VERSION = "v1" as const;

export const OperatorCapabilityNameSchema = z.enum([
  "inventory",
  "discovery",
  "feeds",
  "polling",
  "entries",
  "ranking",
  "events",
  "queues",
  "workerHealth",
  "artifacts",
]);

export type OperatorCapabilityName = z.infer<
  typeof OperatorCapabilityNameSchema
>;

export const OperatorCapabilityStatusSchema = z.enum([
  "available",
  "not_enabled",
  "unavailable",
  "stale",
]);

export const OperatorCapabilityStateSchema = z
  .object({
    reason: z.string().trim().min(1).max(240).optional(),
    status: OperatorCapabilityStatusSchema,
  })
  .strict();

export type OperatorCapabilityState = z.infer<
  typeof OperatorCapabilityStateSchema
>;

export const OperatorCapabilitiesSchema = z
  .object({
    artifacts: OperatorCapabilityStateSchema,
    discovery: OperatorCapabilityStateSchema,
    entries: OperatorCapabilityStateSchema,
    events: OperatorCapabilityStateSchema,
    feeds: OperatorCapabilityStateSchema,
    inventory: OperatorCapabilityStateSchema,
    polling: OperatorCapabilityStateSchema,
    queues: OperatorCapabilityStateSchema,
    ranking: OperatorCapabilityStateSchema,
    workerHealth: OperatorCapabilityStateSchema,
  })
  .strict();

export type OperatorCapabilities = z.infer<typeof OperatorCapabilitiesSchema>;

export const OperatorSourceNameSchema = z.enum([
  "supabase",
  "cloudflare_queue",
  "pipeline_worker",
  "r2",
]);

export const OperatorSourceObservationSchema = z
  .object({
    name: OperatorSourceNameSchema,
    observedAt: z.string().datetime({ offset: true }),
    state: z.enum(["fresh", "stale", "unavailable"]),
  })
  .strict();

export type OperatorSourceObservation = z.infer<
  typeof OperatorSourceObservationSchema
>;

export const OperatorWarningSchema = z
  .object({
    code: z.string().trim().min(1).max(80),
    message: z.string().trim().min(1).max(300),
    source: OperatorSourceNameSchema.optional(),
  })
  .strict();

export const OperatorMetaSchema = z
  .object({
    capabilities: OperatorCapabilitiesSchema,
    environment: z.string().trim().min(1).max(40),
    generatedAt: z.string().datetime({ offset: true }),
    sources: z.array(OperatorSourceObservationSchema).max(16),
    warnings: z.array(OperatorWarningSchema).max(32),
  })
  .strict();

export type OperatorMeta = z.infer<typeof OperatorMetaSchema>;

export function operatorResponseSchema<T extends z.ZodType>(data: T) {
  return z
    .object({
      data,
      meta: OperatorMetaSchema,
    })
    .strict();
}

export interface OperatorResponse<T> {
  data: T;
  meta: OperatorMeta;
}

export const OperatorErrorResponseSchema = z
  .object({
    error: z
      .object({
        code: z.string().trim().min(1).max(80),
        message: z.string().trim().min(1).max(300),
        retryable: z.boolean(),
        source: OperatorSourceNameSchema.optional(),
      })
      .strict(),
    meta: z
      .object({
        generatedAt: z.string().datetime({ offset: true }),
      })
      .strict(),
  })
  .strict();

export type OperatorErrorResponse = z.infer<typeof OperatorErrorResponseSchema>;

export const OperatorCursorSchema = z.string().trim().min(1).max(1024);

export const InventorySummarySchema = z
  .object({
    activeCount: z.number().int().nonnegative(),
    discoveryBackoffCount: z.number().int().nonnegative(),
    discoveryLeasedCount: z.number().int().nonnegative(),
    discoveryPendingCount: z.number().int().nonnegative(),
    gsaFilteredCount: z.number().int().nonnegative(),
    inactiveCount: z.number().int().nonnegative(),
    ingestionExcludedCount: z.number().int().nonnegative(),
    latestSourceSha256: z
      .string()
      .regex(/^[0-9a-f]{64}$/)
      .nullable(),
    latestSuccessAt: z.string().datetime({ offset: true }).nullable(),
    totalCount: z.number().int().nonnegative(),
    usableCount: z.number().int().nonnegative(),
  })
  .strict();

export type InventorySummary = z.infer<typeof InventorySummarySchema>;

export const InventoryRunStatusSchema = z.enum([
  "running",
  "unchanged",
  "succeeded",
  "failed",
]);

export const InventoryRunSchema = z
  .object({
    completedAt: z.string().datetime({ offset: true }).nullable(),
    counts: z
      .object({
        deactivated: z.number().int().nonnegative(),
        eligible: z.number().int().nonnegative(),
        inserted: z.number().int().nonnegative(),
        reactivated: z.number().int().nonnegative(),
        sourceRows: z.number().int().nonnegative().nullable(),
        staged: z.number().int().nonnegative(),
        updated: z.number().int().nonnegative(),
      })
      .strict(),
    errorCode: z.string().max(120).nullable(),
    id: z.string().uuid(),
    rawArtifactKey: z.string().max(1024).nullable(),
    source: z.string().trim().min(1).max(120),
    sourceEtag: z.string().max(512).nullable(),
    sourceSha256: z
      .string()
      .regex(/^[0-9a-f]{64}$/)
      .nullable(),
    startedAt: z.string().datetime({ offset: true }),
    status: InventoryRunStatusSchema,
  })
  .strict();

export type InventoryRun = z.infer<typeof InventoryRunSchema>;

export const GovernmentSiteSchema = z
  .object({
    agency: z.string().nullable(),
    baseDomain: z.string().nullable(),
    branch: z.string().nullable(),
    bureau: z.string().nullable(),
    discoveryStatus: z.string().nullable(),
    exclusionReason: z.string().nullable(),
    firstSeenAt: z.string().datetime({ offset: true }),
    gsaFiltered: z.boolean(),
    id: z.string().uuid(),
    initialUrl: z.string().nullable(),
    inventoryActive: z.boolean(),
    inventoryUsable: z.boolean(),
    lastSeenAt: z.string().datetime({ offset: true }),
    nextDiscoveryAt: z.string().datetime({ offset: true }).nullable(),
    sourceInitialUrl: z.string(),
    topLevelDomain: z.string(),
  })
  .strict();

export type GovernmentSite = z.infer<typeof GovernmentSiteSchema>;

export const PipelineEventRecordSchema = z
  .object({
    artifactKey: z.string().nullable(),
    createdAt: z.string().datetime({ offset: true }),
    eventType: z.string().trim().min(1).max(128),
    id: z.string().uuid(),
    idempotencyKey: z.string().trim().min(1).max(512),
    occurredAt: z.string().datetime({ offset: true }),
    payload: z.record(z.string(), z.unknown()),
    schemaVersion: z.number().int().positive(),
  })
  .strict();

export type PipelineEventRecord = z.infer<typeof PipelineEventRecordSchema>;

export const QueueMetricSchema = z.discriminatedUnion("state", [
  z
    .object({
      backlogBytes: z.number().int().nonnegative(),
      backlogCount: z.number().int().nonnegative(),
      name: z.string().trim().min(1).max(120),
      observedAt: z.string().datetime({ offset: true }),
      oldestMessageAt: z.string().datetime({ offset: true }).nullable(),
      state: z.literal("available"),
    })
    .strict(),
  z
    .object({
      backlogBytes: z.null(),
      backlogCount: z.null(),
      name: z.string().trim().min(1).max(120),
      observedAt: z.string().datetime({ offset: true }),
      oldestMessageAt: z.null(),
      state: z.literal("unavailable"),
    })
    .strict(),
]);

export type QueueMetric = z.infer<typeof QueueMetricSchema>;

export const ComponentHealthSchema = z
  .object({
    checkedAt: z.string().datetime({ offset: true }),
    latencyMs: z.number().int().nonnegative().nullable(),
    message: z.string().max(240).nullable(),
    name: z.enum([
      "operator_api",
      "pipeline_worker",
      "supabase",
      "r2",
      "main_queue",
      "main_dlq",
    ]),
    status: z.enum(["healthy", "degraded", "failed", "not_enabled"]),
  })
  .strict();

export type ComponentHealth = z.infer<typeof ComponentHealthSchema>;

export const CapabilitiesDataSchema = z
  .object({ capabilities: OperatorCapabilitiesSchema })
  .strict();

export const OverviewDataSchema = z
  .object({
    components: z.array(ComponentHealthSchema),
    inventory: InventorySummarySchema.nullable(),
    queues: z.array(QueueMetricSchema),
  })
  .strict();

export const InventorySummaryDataSchema = z
  .object({
    latestRun: InventoryRunSchema.nullable(),
    summary: InventorySummarySchema,
  })
  .strict();

export const InventoryRunListDataSchema = z
  .object({
    items: z.array(InventoryRunSchema),
    nextCursor: OperatorCursorSchema.nullable(),
  })
  .strict();

export const GovernmentSiteListDataSchema = z
  .object({
    items: z.array(GovernmentSiteSchema),
    nextCursor: OperatorCursorSchema.nullable(),
  })
  .strict();

export const PipelineEventListDataSchema = z
  .object({
    items: z.array(PipelineEventRecordSchema),
    nextCursor: OperatorCursorSchema.nullable(),
  })
  .strict();

export const SiteInspectorDataSchema = z
  .object({
    events: z.array(PipelineEventRecordSchema).max(50),
    site: GovernmentSiteSchema,
  })
  .strict();

export const QueueListDataSchema = z
  .object({ queues: z.array(QueueMetricSchema) })
  .strict();

export const HealthDataSchema = z
  .object({
    components: z.array(ComponentHealthSchema),
    depth: z.enum(["shallow", "deep"]),
    status: z.enum(["healthy", "degraded", "failed"]),
  })
  .strict();

export const OperatorListQuerySchema = z
  .object({
    cursor: OperatorCursorSchema.optional(),
    limit: z.coerce.number().int().min(1).max(250).default(50),
  })
  .strict();

export const InventoryRunsQuerySchema = OperatorListQuerySchema.extend({
  status: InventoryRunStatusSchema.optional(),
}).strict();

export const InventorySitesQuerySchema = OperatorListQuerySchema.extend({
  active: z.enum(["true", "false"]).optional(),
  agency: z.string().trim().min(1).max(200).optional(),
  all: z.enum(["true", "false"]).default("false"),
  cursor: z.string().uuid().optional(),
  hostname: z.string().trim().min(1).max(253).optional(),
}).strict();

export const PipelineEventsQuerySchema = OperatorListQuerySchema.extend({
  entity: z.string().trim().min(1).max(512).optional(),
  since: z.string().datetime({ offset: true }).optional(),
  type: z.string().trim().min(1).max(128).optional(),
}).strict();
