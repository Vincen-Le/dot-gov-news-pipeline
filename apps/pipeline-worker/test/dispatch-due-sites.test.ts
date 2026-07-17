import type { SiteDiscoveryRequestedEvent } from "@dot-gov-news/contracts";
import { describe, expect, it, vi } from "vitest";

import type { SiteDiscoveryRepository } from "../src/clients/site-discovery-repository";
import {
  dispatchDueSites,
  type DiscoveryQueue,
} from "../src/discovery/dispatch-due-sites";
import type { DiscoveryConfig } from "../src/discovery/discovery-config";

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

function makeRepository(): SiteDiscoveryRepository {
  return {
    claim: vi.fn().mockResolvedValue([
      {
        baseDomain: "agency.gov",
        initialUrl: "www.agency.gov",
        leaseToken: "20000000-0000-4000-8000-000000000001",
        leaseUntil: "2026-07-17T16:15:00.000Z",
        siteId: "10000000-0000-4000-8000-000000000001",
      },
    ]),
    complete: vi.fn(),
    fail: vi.fn(),
    release: vi.fn().mockResolvedValue(true),
    renew: vi.fn(),
    summary: vi.fn(),
  };
}

function makeQueue(backlogCount = 0): DiscoveryQueue & {
  metrics: ReturnType<typeof vi.fn>;
  sendBatch: ReturnType<typeof vi.fn>;
} {
  return {
    metrics: vi.fn().mockResolvedValue({ backlogCount }),
    sendBatch: vi.fn().mockResolvedValue({}),
  };
}

describe("discovery dispatcher", () => {
  it("does no Queue or database work while disabled", async () => {
    const queue = makeQueue();
    const repository = makeRepository();
    await expect(
      dispatchDueSites(
        Date.parse("2026-07-17T16:00:00.000Z"),
        { SITE_DISCOVERY_QUEUE: queue },
        { ...config, enabled: false },
        repository,
      ),
    ).resolves.toEqual({ outcome: "disabled" });
    expect(queue.metrics).not.toHaveBeenCalled();
    expect(repository.claim).not.toHaveBeenCalled();
  });

  it("uses approximate Queue pressure before claiming", async () => {
    const repository = makeRepository();
    await expect(
      dispatchDueSites(
        Date.parse("2026-07-17T16:00:00.000Z"),
        { SITE_DISCOVERY_QUEUE: makeQueue(1) },
        config,
        repository,
      ),
    ).resolves.toEqual({ backlogCount: 1, outcome: "backpressure" });
    expect(repository.claim).not.toHaveBeenCalled();
  });

  it("sends one strict event per claimed lease", async () => {
    const queue = makeQueue();
    const repository = makeRepository();
    await expect(
      dispatchDueSites(
        Date.parse("2026-07-17T16:00:00.000Z"),
        { SITE_DISCOVERY_QUEUE: queue },
        config,
        repository,
      ),
    ).resolves.toEqual({
      claimedCount: 1,
      enqueuedCount: 1,
      outcome: "dispatched",
    });
    const requests = queue.sendBatch.mock.calls[0]?.[0] as Array<
      MessageSendRequest<SiteDiscoveryRequestedEvent>
    >;
    expect(requests[0]?.body).toEqual(
      expect.objectContaining({
        idempotencyKey:
          "site.discovery:10000000-0000-4000-8000-000000000001:20000000-0000-4000-8000-000000000001",
        type: "site.discovery.requested",
      }),
    );
    expect(requests[0]?.delaySeconds).toBeGreaterThanOrEqual(0);
    expect(requests[0]?.delaySeconds).toBeLessThanOrEqual(30);
  });

  it("releases matching leases after ambiguous enqueue failure", async () => {
    const queue = makeQueue();
    queue.sendBatch.mockRejectedValue(new Error("ambiguous Queue failure"));
    const repository = makeRepository();
    await expect(
      dispatchDueSites(
        Date.parse("2026-07-17T16:00:00.000Z"),
        { SITE_DISCOVERY_QUEUE: queue },
        config,
        repository,
      ),
    ).rejects.toThrow("ambiguous Queue failure");
    expect(repository.release).toHaveBeenCalledWith(
      "10000000-0000-4000-8000-000000000001",
      "20000000-0000-4000-8000-000000000001",
      "enqueue_failed",
    );
  });
});
