import { z } from "zod";

export const PIPELINE_EVENT_SCHEMA_VERSION = 1 as const;

export const PipelineEventSchema = z
  .object({
    id: z.string().uuid(),
    schemaVersion: z.literal(PIPELINE_EVENT_SCHEMA_VERSION),
    type: z.string().trim().min(1).max(128),
    idempotencyKey: z.string().trim().min(1).max(512),
    occurredAt: z.string().datetime({ offset: true }),
    payload: z.record(z.string(), z.unknown()),
  })
  .strict();

export type PipelineEvent = z.infer<typeof PipelineEventSchema>;

export function parsePipelineEvent(input: unknown): PipelineEvent {
  return PipelineEventSchema.parse(input);
}
