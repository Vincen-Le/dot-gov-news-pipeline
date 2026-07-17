import {
  SITE_DISCOVERY_EVENT_SCHEMA_VERSION,
  type SiteDiscoveryRequestedEvent,
} from "@dot-gov-news/contracts";

import type { SiteDiscoveryRepository } from "../clients/site-discovery-repository";
import type { DiscoveryConfig } from "./discovery-config";

export interface DiscoveryQueue {
  metrics(): Promise<{ backlogCount: number }>;
  sendBatch(
    messages: Iterable<MessageSendRequest<SiteDiscoveryRequestedEvent>>,
  ): Promise<unknown>;
}

export type DiscoveryDispatchOutcome =
  | { outcome: "disabled" }
  | { backlogCount: number; outcome: "backpressure" }
  | { claimedCount: number; enqueuedCount: number; outcome: "dispatched" };

function randomDelaySeconds(maximum: number): number {
  if (maximum === 0) return 0;
  const bytes = new Uint32Array(1);
  crypto.getRandomValues(bytes);
  return (bytes[0] ?? 0) % (maximum + 1);
}

export async function dispatchDueSites(
  scheduledTime: number,
  env: { SITE_DISCOVERY_QUEUE: DiscoveryQueue },
  config: DiscoveryConfig,
  repository: SiteDiscoveryRepository,
): Promise<DiscoveryDispatchOutcome> {
  if (!config.enabled) return { outcome: "disabled" };

  const metrics = await env.SITE_DISCOVERY_QUEUE.metrics();
  if (metrics.backlogCount >= config.queueHighWater) {
    return { backlogCount: metrics.backlogCount, outcome: "backpressure" };
  }

  const claims = await repository.claim(
    crypto.randomUUID(),
    config.claimLimit,
    config.leaseSeconds,
  );
  if (claims.length === 0) {
    return { claimedCount: 0, enqueuedCount: 0, outcome: "dispatched" };
  }

  const occurredAt = new Date(scheduledTime).toISOString();
  const events = claims.map<SiteDiscoveryRequestedEvent>((claim) => ({
    id: crypto.randomUUID(),
    idempotencyKey: `site.discovery:${claim.siteId}:${claim.leaseToken}`,
    occurredAt,
    payload: {
      baseDomain: claim.baseDomain,
      initialUrl: claim.initialUrl,
      leaseToken: claim.leaseToken,
      leaseUntil: claim.leaseUntil,
      policyVersion: config.policyVersion,
      siteId: claim.siteId,
    },
    schemaVersion: SITE_DISCOVERY_EVENT_SCHEMA_VERSION,
    type: "site.discovery.requested",
  }));

  try {
    await env.SITE_DISCOVERY_QUEUE.sendBatch(
      events.map((event) => ({
        body: event,
        contentType: "json" as const,
        delaySeconds: randomDelaySeconds(config.maxDelaySeconds),
      })),
    );
  } catch (error) {
    const releases = await Promise.allSettled(
      claims.map((claim) =>
        repository.release(claim.siteId, claim.leaseToken, "enqueue_failed"),
      ),
    );
    const releaseFailed = releases.some(
      (result) => result.status === "rejected" || result.value === false,
    );
    if (releaseFailed) {
      throw new AggregateError(
        releases.filter((result) => result.status === "rejected"),
        "Queue enqueue and at least one lease release failed",
        { cause: error },
      );
    }
    throw error;
  }

  return {
    claimedCount: claims.length,
    enqueuedCount: events.length,
    outcome: "dispatched",
  };
}
