import {
  parsePipelineEvent,
  type PipelineEvent,
} from "@dot-gov-news/contracts";

import {
  createSupabaseEventStore,
  type PipelineEventStore,
} from "../clients/supabase";
import type { WorkerEnv } from "../env";
import { handleSiteDiscoveryQueue } from "./site-discovery-queue";

export const PIPELINE_EVENTS_QUEUE_NAME = "dot-gov-news-events-dev";
export const SITE_DISCOVERY_QUEUE_NAME = "dot-gov-site-discovery-dev";

export function artifactKeyForEvent(event: PipelineEvent): string {
  return `health/${event.id}.json`;
}

async function writeArtifact(
  artifacts: R2Bucket,
  event: PipelineEvent,
  artifactKey: string,
): Promise<void> {
  await artifacts.put(artifactKey, JSON.stringify(event), {
    customMetadata: {
      eventType: event.type,
      schemaVersion: String(event.schemaVersion),
    },
    httpMetadata: {
      contentType: "application/json",
    },
  });
}

function retryDelaySeconds(attempts: number): number {
  return Math.min(60, Math.max(1, 2 ** Math.max(0, attempts - 1)));
}

export async function processQueueMessage(
  message: Message<unknown>,
  env: WorkerEnv,
  eventStore: PipelineEventStore,
): Promise<void> {
  let event: PipelineEvent | undefined;

  try {
    event = parsePipelineEvent(message.body);
    if (event.type !== "infra.heartbeat") {
      throw new Error(
        "Event type does not belong on the pipeline events Queue",
      );
    }
    const artifactKey = artifactKeyForEvent(event);

    await writeArtifact(env.ARTIFACTS, event, artifactKey);
    await eventStore.upsert(event, artifactKey);
    message.ack();

    console.log(
      JSON.stringify({
        event_id: event.id,
        event_type: event.type,
        outcome: "persisted",
      }),
    );
  } catch (error) {
    message.retry({ delaySeconds: retryDelaySeconds(message.attempts) });

    console.error(
      JSON.stringify({
        error_name: error instanceof Error ? error.name : "UnknownError",
        event_id: event?.id ?? message.id,
        event_type: event?.type ?? "unknown",
        outcome: "retrying",
      }),
    );
  }
}

export async function handleQueue(
  batch: MessageBatch<unknown>,
  env: WorkerEnv,
): Promise<void> {
  if (batch.queue === SITE_DISCOVERY_QUEUE_NAME) {
    await handleSiteDiscoveryQueue(batch, env);
    return;
  }

  if (batch.queue !== PIPELINE_EVENTS_QUEUE_NAME) {
    for (const message of batch.messages) {
      message.retry({ delaySeconds: retryDelaySeconds(message.attempts) });
    }
    console.error(
      JSON.stringify({
        outcome: "retrying_unknown_queue",
        queue: batch.queue,
      }),
    );
    return;
  }

  const eventStore = createSupabaseEventStore(env);

  await Promise.all(
    batch.messages.map((message) =>
      processQueueMessage(message, env, eventStore),
    ),
  );
}
