import { z } from "zod";

export const WORKER_LIFECYCLE_LOG_SCHEMA_VERSION = 1 as const;

export const WorkerLifecycleLogSchema = z
  .object({
    action: z.string().trim().min(1).max(80),
    attempt: z.number().int().positive().max(100).optional(),
    correlationId: z.string().trim().min(1).max(128),
    detail: z.string().trim().min(1).max(512).optional(),
    durationMs: z.number().int().nonnegative().max(86_400_000).optional(),
    entityId: z.string().trim().min(1).max(512).optional(),
    entityType: z
      .enum(["system", "inventory", "site", "feed", "event"])
      .optional(),
    logMarker: z.literal("worker_lifecycle"),
    occurredAt: z.string().datetime({ offset: true }),
    outcome: z.enum(["started", "succeeded", "failed", "retried", "skipped"]),
    schemaVersion: z.literal(WORKER_LIFECYCLE_LOG_SCHEMA_VERSION),
    stage: z.enum([
      "cron",
      "queue",
      "inventory",
      "discovery",
      "polling",
      "storage",
      "health",
    ]),
  })
  .strict();

export type WorkerLifecycleLog = z.infer<typeof WorkerLifecycleLogSchema>;

export function parseWorkerLifecycleLog(input: unknown): WorkerLifecycleLog {
  return WorkerLifecycleLogSchema.parse(input);
}
