import type { SiteDiscoveryRequestedEvent } from "@dot-gov-news/contracts";
import { describe, expect, it, vi } from "vitest";

import type { SiteDiscoveryRepository } from "../src/clients/site-discovery-repository";
import { SiteDiscoveryFailure } from "../src/discovery/discover-site-feeds";
import type { DiscoveryConfig } from "../src/discovery/discovery-config";
import {
  processSiteDiscoveryMessage,
  type DiscoverSite,
} from "../src/discovery/process-site-discovery";

const event: SiteDiscoveryRequestedEvent = {
  id: "80000000-0000-4000-8000-000000000001",
  idempotencyKey:
    "site.discovery:10000000-0000-4000-8000-000000000001:20000000-0000-4000-8000-000000000001",
  occurredAt: "2026-07-17T16:00:00.000Z",
  payload: {
    baseDomain: "agency.gov",
    initialUrl: "agency.gov",
    leaseToken: "20000000-0000-4000-8000-000000000001",
    leaseUntil: "2026-07-17T16:15:00.000Z",
    policyVersion: 1,
    siteId: "10000000-0000-4000-8000-000000000001",
  },
  schemaVersion: 1,
  type: "site.discovery.requested",
};

const config: DiscoveryConfig = {
  claimLimit: 1,
  contact: "ops@example.gov",
  enabled: true,
  leaseSeconds: 900,
  maxDelaySeconds: 30,
  maxPublisherRequests: 36,
  policyVersion: 1,
  queueHighWater: 1,
  siteDeadlineMs: 600_000,
  userAgent: "dot-gov-news-pipeline/1 (+ops@example.gov)",
};

function makeMessage(): Message<unknown> & {
  ack: ReturnType<typeof vi.fn>;
  retry: ReturnType<typeof vi.fn>;
} {
  return {
    ack: vi.fn(),
    attempts: 1,
    body: event,
    id: "message-id",
    retry: vi.fn(),
    timestamp: new Date(event.occurredAt),
  } as Message<unknown> & {
    ack: ReturnType<typeof vi.fn>;
    retry: ReturnType<typeof vi.fn>;
  };
}

function makeRepository(): SiteDiscoveryRepository {
  return {
    claim: vi.fn(),
    complete: vi.fn().mockResolvedValue(true),
    fail: vi.fn().mockResolvedValue(true),
    release: vi.fn(),
    renew: vi.fn().mockResolvedValue("2026-07-17T16:15:00.000Z"),
    summary: vi.fn(),
  };
}

const successfulDiscovery: DiscoverSite = vi.fn().mockResolvedValue({
  feeds: [],
  health: {
    durationMs: 10,
    finalUrl: "https://agency.gov/",
    httpStatus: 200,
  },
  peakResponseBytes: 1_024,
  requestCount: 6,
  result: "no_feed",
});

describe("processSiteDiscoveryMessage", () => {
  it("acknowledges stale leases before publisher I/O", async () => {
    const message = makeMessage();
    const repository = makeRepository();
    vi.mocked(repository.renew).mockResolvedValue(null);
    const discover = vi.fn<DiscoverSite>();
    await processSiteDiscoveryMessage(
      message,
      event,
      config,
      repository,
      undefined,
      discover,
    );
    expect(discover).not.toHaveBeenCalled();
    expect(message.ack).toHaveBeenCalledOnce();
    expect(message.retry).not.toHaveBeenCalled();
  });

  it("renews, completes, and acknowledges a complete scan", async () => {
    const message = makeMessage();
    const repository = makeRepository();
    await processSiteDiscoveryMessage(
      message,
      event,
      config,
      repository,
      undefined,
      successfulDiscovery,
    );
    expect(repository.renew).toHaveBeenCalledWith(
      event.payload.siteId,
      event.payload.leaseToken,
      900,
    );
    expect(repository.complete).toHaveBeenCalledWith(
      expect.objectContaining({
        result: "no_feed",
        siteId: event.payload.siteId,
      }),
    );
    expect(message.ack).toHaveBeenCalledOnce();
  });

  it("persists publisher failure without Queue retry", async () => {
    const message = makeMessage();
    const repository = makeRepository();
    const discover = vi
      .fn<DiscoverSite>()
      .mockRejectedValue(
        new SiteDiscoveryFailure("publisher_timeout", "request timed out", 60),
      );
    await processSiteDiscoveryMessage(
      message,
      event,
      config,
      repository,
      undefined,
      discover,
    );
    expect(repository.fail).toHaveBeenCalledWith(
      expect.objectContaining({
        errorCode: "publisher_timeout",
        retryAfterSeconds: 60,
      }),
    );
    expect(message.ack).toHaveBeenCalledOnce();
    expect(message.retry).not.toHaveBeenCalled();
  });

  it("acknowledges and identifies a stale publisher failure", async () => {
    const message = makeMessage();
    const repository = makeRepository();
    vi.mocked(repository.fail).mockResolvedValue(false);
    const log = vi.spyOn(console, "log").mockImplementation(() => undefined);
    const discover = vi
      .fn<DiscoverSite>()
      .mockRejectedValue(
        new SiteDiscoveryFailure("publisher_timeout", "request timed out"),
      );
    await processSiteDiscoveryMessage(
      message,
      event,
      config,
      repository,
      undefined,
      discover,
    );
    expect(message.ack).toHaveBeenCalledOnce();
    expect(message.retry).not.toHaveBeenCalled();
    expect(log).toHaveBeenCalledWith(expect.stringContaining("stale_failure"));
    log.mockRestore();
  });

  it("retries when result persistence is unavailable", async () => {
    const message = makeMessage();
    const repository = makeRepository();
    vi.mocked(repository.complete).mockRejectedValue(
      new Error("database unavailable"),
    );
    await processSiteDiscoveryMessage(
      message,
      event,
      config,
      repository,
      undefined,
      successfulDiscovery,
    );
    expect(message.ack).not.toHaveBeenCalled();
    expect(message.retry).toHaveBeenCalledWith({ delaySeconds: 1 });
  });

  it("retries unsupported policy versions without publisher I/O", async () => {
    const message = makeMessage();
    const repository = makeRepository();
    const discover = vi.fn<DiscoverSite>();
    await processSiteDiscoveryMessage(
      message,
      event,
      { ...config, policyVersion: 2 },
      repository,
      undefined,
      discover,
    );
    expect(repository.renew).not.toHaveBeenCalled();
    expect(discover).not.toHaveBeenCalled();
    expect(message.retry).toHaveBeenCalled();
  });
});
