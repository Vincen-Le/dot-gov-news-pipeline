import { parsePipelineEvent } from "@dot-gov-news/contracts";

import { createSiteDiscoveryRepository } from "../clients/site-discovery-repository";
import { processSiteDiscoveryMessage } from "../discovery/process-site-discovery";
import { parseDiscoveryConfig } from "../discovery/discovery-config";
import type { WorkerEnv } from "../env";

function retryDelaySeconds(attempts: number): number {
  return Math.min(60, Math.max(1, 2 ** Math.max(0, attempts - 1)));
}

export async function handleSiteDiscoveryQueue(
  batch: MessageBatch<unknown>,
  env: WorkerEnv,
): Promise<void> {
  let config: ReturnType<typeof parseDiscoveryConfig>;
  let repository: ReturnType<typeof createSiteDiscoveryRepository>;
  try {
    config = parseDiscoveryConfig(env);
    repository = createSiteDiscoveryRepository(env);
  } catch (error) {
    for (const message of batch.messages) {
      message.retry({ delaySeconds: retryDelaySeconds(message.attempts) });
    }
    console.error(
      JSON.stringify({
        error_name: error instanceof Error ? error.name : "UnknownError",
        outcome: "retrying_discovery_configuration_failure",
      }),
    );
    return;
  }

  // Production keeps max_batch_size=1 and scales with independent
  // invocations. Keep this sequential so a future batch-size mistake cannot
  // fan out publisher requests inside one invocation.
  for (const message of batch.messages) {
    try {
      const event = parsePipelineEvent(message.body);
      if (event.type !== "site.discovery.requested") {
        throw new Error("Event type does not belong on the discovery Queue");
      }
      await processSiteDiscoveryMessage(message, event, config, repository);
    } catch (error) {
      message.retry({ delaySeconds: retryDelaySeconds(message.attempts) });
      console.error(
        JSON.stringify({
          error_name: error instanceof Error ? error.name : "UnknownError",
          event_id: message.id,
          event_type: "unknown",
          outcome: "retrying_invalid_discovery_message",
        }),
      );
    }
  }
}
