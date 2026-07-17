import { z } from "zod";

import { SiteDiscoveryRequestedEventSchema } from "./site-discovery-event";

export const PIPELINE_EVENT_SCHEMA_VERSION = 1 as const;

export const HeartbeatEventSchema = z
  .object({
    id: z.string().uuid(),
    schemaVersion: z.literal(PIPELINE_EVENT_SCHEMA_VERSION),
    type: z.literal("infra.heartbeat"),
    idempotencyKey: z.string().trim().min(1).max(512),
    occurredAt: z.string().datetime({ offset: true }),
    payload: z
      .object({
        source: z.string().trim().min(1).max(128),
      })
      .strict(),
  })
  .strict();

export const PipelineEventSchema = z.discriminatedUnion("type", [
  HeartbeatEventSchema,
  SiteDiscoveryRequestedEventSchema,
]);

export type PipelineEvent = z.infer<typeof PipelineEventSchema>;
export type HeartbeatEvent = z.infer<typeof HeartbeatEventSchema>;

export function parsePipelineEvent(input: unknown): PipelineEvent {
  return PipelineEventSchema.parse(input);
}
