import {
  PIPELINE_EVENT_SCHEMA_VERSION,
  type PipelineEvent,
} from "@dot-gov-news/contracts";

import type { WorkerEnv } from "../env";

export function createHeartbeatEvent(
  scheduledTime: number,
  id: string,
): PipelineEvent {
  const occurredAt = new Date(scheduledTime).toISOString();

  return {
    id,
    idempotencyKey: `infra.heartbeat:${occurredAt}`,
    occurredAt,
    payload: {
      source: "cloudflare-cron",
    },
    schemaVersion: PIPELINE_EVENT_SCHEMA_VERSION,
    type: "infra.heartbeat",
  };
}

function formatUuid(bytes: Uint8Array): string {
  const hex = Array.from(bytes, (byte) =>
    byte.toString(16).padStart(2, "0"),
  ).join("");

  return [
    hex.slice(0, 8),
    hex.slice(8, 12),
    hex.slice(12, 16),
    hex.slice(16, 20),
    hex.slice(20, 32),
  ].join("-");
}

export async function createScheduledHeartbeatEvent(
  scheduledTime: number,
): Promise<PipelineEvent> {
  const occurredAt = new Date(scheduledTime).toISOString();
  const idempotencyKey = `infra.heartbeat:${occurredAt}`;
  const digest = new Uint8Array(
    await crypto.subtle.digest(
      "SHA-256",
      new TextEncoder().encode(idempotencyKey),
    ),
  ).slice(0, 16);

  const versionByte = digest[6];
  const variantByte = digest[8];

  if (versionByte === undefined || variantByte === undefined) {
    throw new Error("Unable to derive heartbeat UUID");
  }

  // RFC 9562 UUIDv8 leaves the payload algorithm application-defined. The
  // SHA-256-derived bits make the same scheduled event converge on one R2 key.
  digest[6] = (versionByte & 0x0f) | 0x80;
  digest[8] = (variantByte & 0x3f) | 0x80;

  return createHeartbeatEvent(scheduledTime, formatUuid(digest));
}

export async function handleScheduled(
  controller: ScheduledController,
  env: WorkerEnv,
): Promise<void> {
  const event = await createScheduledHeartbeatEvent(controller.scheduledTime);

  await env.PIPELINE_EVENTS_QUEUE.send(event, { contentType: "json" });

  console.log(
    JSON.stringify({
      event_id: event.id,
      event_type: event.type,
      outcome: "enqueued",
    }),
  );
}
