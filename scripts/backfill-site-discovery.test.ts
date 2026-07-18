import { setTimeout as delay } from "node:timers/promises";

import { describe, expect, it, vi } from "vitest";

import type {
  SiteDiscoveryClaim,
  SiteDiscoveryRepository,
  SiteDiscoverySummary,
} from "../apps/pipeline-worker/src/clients/site-discovery-repository";
import { SiteDiscoveryFailure } from "../apps/pipeline-worker/src/discovery/discover-site-feeds";
import {
  parseBackfillArguments,
  runBackfill,
  type BackfillRunOptions,
} from "./backfill-site-discovery";

function claim(index: number): SiteDiscoveryClaim {
  return {
    baseDomain: `agency-${index}.gov`,
    initialUrl: `agency-${index}.gov`,
    leaseToken: `10000000-0000-4000-8000-${String(index).padStart(12, "0")}`,
    leaseUntil: "2026-07-18T00:00:00Z",
    siteId: `20000000-0000-4000-8000-${String(index).padStart(12, "0")}`,
  };
}

const SUMMARY: SiteDiscoverySummary = {
  activeRelationshipCount: 0,
  backoffCount: 0,
  disabledCount: 0,
  expiredLeaseCount: 0,
  feedCount: 0,
  leasedCount: 0,
  noFeedCount: 0,
  oldestDueAt: null,
  overdueCount: 4,
  pendingCount: 4,
  succeededCount: 0,
};

class FakeRepository implements SiteDiscoveryRepository {
  readonly claims: SiteDiscoveryClaim[];
  readonly complete = vi.fn(async () => true);
  readonly fail = vi.fn(async () => true);
  readonly release = vi.fn(async () => true);
  readonly renew = vi.fn(async () => null);
  readonly summary = vi.fn(async () => SUMMARY);
  readonly claimCalls = vi.fn();

  constructor(claims: SiteDiscoveryClaim[]) {
    this.claims = [...claims];
  }

  async claim(
    workerId: string,
    limit: number,
    leaseSeconds: number,
  ): Promise<SiteDiscoveryClaim[]> {
    this.claimCalls(workerId, limit, leaseSeconds);
    return this.claims.splice(0, limit);
  }
}

function options(
  overrides: Partial<BackfillRunOptions> = {},
): BackfillRunOptions {
  return {
    concurrency: 2,
    dryRun: false,
    leaseSeconds: 900,
    maxPublisherRequests: 36,
    maxSites: 0,
    policyVersion: 1,
    progressEvery: 100,
    siteDeadlineSeconds: 600,
    userAgent: "dot-gov-news-pipeline/1 (+operator@example.gov)",
    workerId: "30000000-0000-4000-8000-000000000001",
    ...overrides,
  };
}

describe("parseBackfillArguments", () => {
  it("parses bounded concurrency and a canary limit", () => {
    expect(
      parseBackfillArguments([
        "--concurrency",
        "120",
        "--max-sites",
        "250",
        "--dry-run",
      ]),
    ).toMatchObject({ concurrency: 120, dryRun: true, maxSites: 250 });
  });

  it("requires lease cleanup headroom", () => {
    expect(() =>
      parseBackfillArguments([
        "--lease-seconds",
        "659",
        "--site-deadline-seconds",
        "600",
      ]),
    ).toThrow("at least 60 seconds");
  });
});

describe("runBackfill", () => {
  it("performs a side-effect-free dry run", async () => {
    const repository = new FakeRepository([claim(1)]);

    const result = await runBackfill(options({ dryRun: true }), {
      discover: vi.fn(),
      log: vi.fn(),
      repository,
    });

    expect(result.counters.claimed).toBe(0);
    expect(repository.claimCalls).not.toHaveBeenCalled();
    expect(repository.complete).not.toHaveBeenCalled();
  });

  it("bounds concurrency, honors max-sites, and persists completions", async () => {
    const repository = new FakeRepository([
      claim(1),
      claim(2),
      claim(3),
      claim(4),
    ]);
    let active = 0;
    let maximumActive = 0;

    const result = await runBackfill(options({ maxSites: 3 }), {
      discover: async () => {
        active += 1;
        maximumActive = Math.max(maximumActive, active);
        await delay(5);
        active -= 1;
        return {
          feeds: [],
          health: { durationMs: 5 },
          peakResponseBytes: 0,
          requestCount: 1,
          result: "no_feed",
        };
      },
      log: vi.fn(),
      repository,
    });

    expect(result.counters).toMatchObject({
      claimed: 3,
      completed: 3,
      noFeed: 3,
      systemFailures: 0,
    });
    expect(maximumActive).toBe(2);
    expect(repository.complete).toHaveBeenCalledTimes(3);
    expect(repository.claims).toHaveLength(1);
  });

  it("persists publisher failures as backoff", async () => {
    const repository = new FakeRepository([claim(1)]);

    const result = await runBackfill(options(), {
      discover: async () => {
        throw new SiteDiscoveryFailure(
          "publisher_timeout",
          "Publisher request timed out",
          0,
          20_000,
          1,
          0,
        );
      },
      log: vi.fn(),
      repository,
    });

    expect(result.counters.publisherFailures).toBe(1);
    expect(repository.fail).toHaveBeenCalledWith(
      expect.objectContaining({ errorCode: "publisher_timeout" }),
    );
    expect(repository.release).not.toHaveBeenCalled();
  });

  it("retries a transient repository write without recrawling", async () => {
    const repository = new FakeRepository([claim(1)]);
    repository.complete.mockRejectedValueOnce(new Error("temporary outage"));
    const discover = vi.fn(async () => ({
      feeds: [],
      health: { durationMs: 5 },
      peakResponseBytes: 0,
      requestCount: 1,
      result: "no_feed" as const,
    }));

    const result = await runBackfill(options({ repositoryRetryBaseMs: 0 }), {
      discover,
      log: vi.fn(),
      repository,
    });

    expect(result.counters.noFeed).toBe(1);
    expect(discover).toHaveBeenCalledTimes(1);
    expect(repository.complete).toHaveBeenCalledTimes(2);
    expect(repository.release).not.toHaveBeenCalled();
  });

  it("releases a lease and stops on a system failure", async () => {
    const repository = new FakeRepository([claim(1), claim(2)]);

    await expect(
      runBackfill(options({ concurrency: 1 }), {
        discover: async () => {
          throw new TypeError("Unexpected parser failure");
        },
        log: vi.fn(),
        repository,
      }),
    ).rejects.toThrow("Unexpected parser failure");
    expect(repository.release).toHaveBeenCalledTimes(1);
    expect(repository.complete).not.toHaveBeenCalled();
  });
});
