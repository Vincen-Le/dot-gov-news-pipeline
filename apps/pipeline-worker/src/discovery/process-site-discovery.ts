import type { SiteDiscoveryRequestedEvent } from "@dot-gov-news/contracts";

import type { SiteDiscoveryRepository } from "../clients/site-discovery-repository";
import type { PublisherFetcher } from "./bounded-fetch";
import {
  discoverSiteFeeds,
  SiteDiscoveryFailure,
  type DiscoverSiteFeedsOptions,
  type SiteDiscoveryResult,
} from "./discover-site-feeds";
import type { DiscoveryConfig } from "./discovery-config";

export type DiscoverSite = (
  options: DiscoverSiteFeedsOptions,
) => Promise<SiteDiscoveryResult>;

function retryDelaySeconds(attempts: number): number {
  return Math.min(60, Math.max(1, 2 ** Math.max(0, attempts - 1)));
}

export async function processSiteDiscoveryMessage(
  message: Message<unknown>,
  event: SiteDiscoveryRequestedEvent,
  config: DiscoveryConfig,
  repository: SiteDiscoveryRepository,
  fetcher?: PublisherFetcher,
  discover: DiscoverSite = discoverSiteFeeds,
): Promise<void> {
  const logContext = {
    event_id: event.id,
    event_type: event.type,
    site_id: event.payload.siteId,
  };

  try {
    if (event.payload.policyVersion !== config.policyVersion) {
      throw new Error("Discovery policy version is not active");
    }
    if (config.userAgent === null) {
      throw new Error("Discovery contact is not configured");
    }

    const leaseUntil = await repository.renew(
      event.payload.siteId,
      event.payload.leaseToken,
      config.leaseSeconds,
    );
    if (leaseUntil === null) {
      message.ack();
      console.log(JSON.stringify({ ...logContext, outcome: "stale_lease" }));
      return;
    }

    let discovery: SiteDiscoveryResult;
    try {
      discovery = await discover({
        baseDomain: event.payload.baseDomain,
        fetcher,
        initialUrl: event.payload.initialUrl,
        maxPublisherRequests: config.maxPublisherRequests,
        siteDeadlineMs: config.siteDeadlineMs,
        userAgent: config.userAgent,
      });
    } catch (error) {
      if (!(error instanceof SiteDiscoveryFailure)) throw error;
      const failed = await repository.fail({
        errorCode: error.code,
        errorDetail: error.message,
        leaseToken: event.payload.leaseToken,
        policyVersion: event.payload.policyVersion,
        retryAfterSeconds: error.retryAfterSeconds,
        siteId: event.payload.siteId,
      });
      message.ack();
      console.log(
        JSON.stringify({
          ...logContext,
          duration_ms: error.durationMs,
          error_code: error.code,
          outcome: failed ? "publisher_failure_persisted" : "stale_failure",
          peak_response_bytes: error.peakResponseBytes,
          publisher_request_count: error.requestCount,
        }),
      );
      return;
    }

    const completed = await repository.complete({
      feeds: discovery.feeds,
      health: discovery.health,
      leaseToken: event.payload.leaseToken,
      policyVersion: event.payload.policyVersion,
      result: discovery.result,
      siteId: event.payload.siteId,
    });
    message.ack();
    console.log(
      JSON.stringify({
        ...logContext,
        duration_ms: discovery.health.durationMs,
        feed_count: discovery.feeds.length,
        outcome: completed ? "completed" : "stale_completion",
        publisher_request_count: discovery.requestCount,
        peak_response_bytes: discovery.peakResponseBytes,
        result: discovery.result,
      }),
    );
  } catch (error) {
    message.retry({ delaySeconds: retryDelaySeconds(message.attempts) });
    console.error(
      JSON.stringify({
        ...logContext,
        error_name: error instanceof Error ? error.name : "UnknownError",
        outcome: "retrying_system_failure",
      }),
    );
  }
}
