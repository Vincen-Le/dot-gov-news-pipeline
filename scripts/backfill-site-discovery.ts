#!/usr/bin/env node

import { randomUUID } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";
import { pathToFileURL } from "node:url";

import type {
  SiteDiscoveryClaim,
  SiteDiscoveryRepository,
  SiteDiscoverySummary,
} from "../apps/pipeline-worker/src/clients/site-discovery-repository";
import { createSiteDiscoveryRepository } from "../apps/pipeline-worker/src/clients/site-discovery-repository";
import { parseDiscoveryConfig } from "../apps/pipeline-worker/src/discovery/discovery-config";
import {
  discoverSiteFeeds,
  SiteDiscoveryFailure,
  type DiscoverSiteFeedsOptions,
  type SiteDiscoveryResult,
} from "../apps/pipeline-worker/src/discovery/discover-site-feeds";
import { extractFeedLinksNode } from "./lib/extract-feed-links-node";

const CLAIM_LIMIT = 25;

export interface BackfillArguments {
  concurrency: number;
  dryRun: boolean;
  leaseSeconds: number;
  maxPublisherRequests: number;
  maxSites: number;
  policyVersion: number;
  progressEvery: number;
  siteDeadlineSeconds: number;
}

export interface BackfillCounters {
  claimed: number;
  completed: number;
  feedCount: number;
  noFeed: number;
  publisherFailures: number;
  staleResults: number;
  succeeded: number;
  systemFailures: number;
}

export interface BackfillRunOptions extends BackfillArguments {
  repositoryRetryBaseMs?: number;
  shouldStop?: () => boolean;
  userAgent: string;
  workerId?: string;
}

export type DiscoverSite = (
  options: DiscoverSiteFeedsOptions,
) => Promise<SiteDiscoveryResult>;

export interface BackfillDependencies {
  discover: DiscoverSite;
  log: (record: Record<string, unknown>) => void;
  repository: SiteDiscoveryRepository;
}

export interface BackfillRunResult {
  counters: BackfillCounters;
  databaseSummary: SiteDiscoverySummary;
  durationMs: number;
  stopped: boolean;
}

type SiteOutcome =
  | {
      durationMs: number;
      feedCount: number;
      kind: "completed";
      requestCount: number;
      result: "no_feed" | "succeeded";
      siteId: string;
      stale: boolean;
    }
  | {
      durationMs: number;
      errorCode: string;
      kind: "publisher_failure";
      requestCount: number;
      siteId: string;
      stale: boolean;
    };

const DEFAULT_ARGUMENTS: BackfillArguments = {
  concurrency: 60,
  dryRun: false,
  leaseSeconds: 900,
  maxPublisherRequests: 36,
  maxSites: 0,
  policyVersion: 1,
  progressEvery: 100,
  siteDeadlineSeconds: 600,
};

function integerArgument(
  name: string,
  value: string | undefined,
  minimum: number,
  maximum: number,
): number {
  if (value === undefined || !/^(?:0|[1-9]\d*)$/.test(value)) {
    throw new Error(`${name} requires an integer value`);
  }
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < minimum || parsed > maximum) {
    throw new Error(`${name} must be between ${minimum} and ${maximum}`);
  }
  return parsed;
}

export function parseBackfillArguments(argv: string[]): BackfillArguments {
  const parsed = { ...DEFAULT_ARGUMENTS };
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    switch (argument) {
      case "--concurrency":
        parsed.concurrency = integerArgument(argument, argv[++index], 1, 250);
        break;
      case "--dry-run":
        parsed.dryRun = true;
        break;
      case "--lease-seconds":
        parsed.leaseSeconds = integerArgument(
          argument,
          argv[++index],
          30,
          3_600,
        );
        break;
      case "--max-publisher-requests":
        parsed.maxPublisherRequests = integerArgument(
          argument,
          argv[++index],
          1,
          36,
        );
        break;
      case "--max-sites":
        parsed.maxSites = integerArgument(
          argument,
          argv[++index],
          0,
          1_000_000,
        );
        break;
      case "--policy-version":
        parsed.policyVersion = integerArgument(
          argument,
          argv[++index],
          1,
          1_000_000,
        );
        break;
      case "--progress-every":
        parsed.progressEvery = integerArgument(
          argument,
          argv[++index],
          1,
          1_000_000,
        );
        break;
      case "--site-deadline-seconds":
        parsed.siteDeadlineSeconds = integerArgument(
          argument,
          argv[++index],
          15,
          3_300,
        );
        break;
      default:
        throw new Error(`Unknown argument: ${argument ?? ""}`);
    }
  }
  if (parsed.leaseSeconds < parsed.siteDeadlineSeconds + 60) {
    throw new Error(
      "--lease-seconds must include at least 60 seconds beyond the site deadline",
    );
  }
  return parsed;
}

function requiredEnvironment(name: string): string {
  const value = process.env[name]?.trim();
  if (value === undefined || value === "") {
    throw new Error(`${name} is required`);
  }
  return value;
}

function emptyCounters(): BackfillCounters {
  return {
    claimed: 0,
    completed: 0,
    feedCount: 0,
    noFeed: 0,
    publisherFailures: 0,
    staleResults: 0,
    succeeded: 0,
    systemFailures: 0,
  };
}

async function repositoryOperation<T>(
  operation: string,
  options: BackfillRunOptions,
  dependencies: BackfillDependencies,
  execute: () => Promise<T>,
): Promise<T> {
  const maximumAttempts = 4;
  for (let attempt = 1; ; attempt += 1) {
    try {
      return await execute();
    } catch (error) {
      if (attempt >= maximumAttempts) throw error;
      const baseDelayMs = options.repositoryRetryBaseMs ?? 250;
      const backoffMs = baseDelayMs * 2 ** (attempt - 1);
      const delayMs = Math.round(backoffMs + Math.random() * backoffMs);
      dependencies.log({
        attempt,
        delay_ms: delayMs,
        error_name: error instanceof Error ? error.name : "UnknownError",
        event: "backfill_repository_retry",
        operation,
      });
      await delay(delayMs);
    }
  }
}

async function releaseAfterSystemFailure(
  repository: SiteDiscoveryRepository,
  claim: SiteDiscoveryClaim,
  cause: unknown,
  options: BackfillRunOptions,
  dependencies: BackfillDependencies,
): Promise<never> {
  try {
    const released = await repositoryOperation(
      "release",
      options,
      dependencies,
      () =>
        repository.release(
          claim.siteId,
          claim.leaseToken,
          "backfill_system_failure",
        ),
    );
    if (!released) {
      throw new Error("The discovery lease was stale during compensation");
    }
  } catch (releaseError) {
    throw new AggregateError(
      [cause, releaseError],
      "Backfill processing and lease compensation both failed",
      { cause: releaseError },
    );
  }
  throw cause;
}

async function processClaim(
  claim: SiteDiscoveryClaim,
  options: BackfillRunOptions,
  dependencies: BackfillDependencies,
): Promise<SiteOutcome> {
  let discovery: SiteDiscoveryResult;
  try {
    discovery = await dependencies.discover({
      baseDomain: claim.baseDomain,
      initialUrl: claim.initialUrl,
      maxPublisherRequests: options.maxPublisherRequests,
      siteDeadlineMs: options.siteDeadlineSeconds * 1_000,
      userAgent: options.userAgent,
    });
  } catch (error) {
    if (!(error instanceof SiteDiscoveryFailure)) {
      return releaseAfterSystemFailure(
        dependencies.repository,
        claim,
        error,
        options,
        dependencies,
      );
    }
    try {
      const persisted = await repositoryOperation(
        "fail",
        options,
        dependencies,
        () =>
          dependencies.repository.fail({
            errorCode: error.code,
            errorDetail: error.message,
            leaseToken: claim.leaseToken,
            policyVersion: options.policyVersion,
            retryAfterSeconds: error.retryAfterSeconds,
            siteId: claim.siteId,
          }),
      );
      return {
        durationMs: error.durationMs,
        errorCode: error.code,
        kind: "publisher_failure",
        requestCount: error.requestCount,
        siteId: claim.siteId,
        stale: !persisted,
      };
    } catch (persistenceError) {
      return releaseAfterSystemFailure(
        dependencies.repository,
        claim,
        persistenceError,
        options,
        dependencies,
      );
    }
  }

  try {
    const persisted = await repositoryOperation(
      "complete",
      options,
      dependencies,
      () =>
        dependencies.repository.complete({
          feeds: discovery.feeds,
          health: discovery.health,
          leaseToken: claim.leaseToken,
          policyVersion: options.policyVersion,
          result: discovery.result,
          siteId: claim.siteId,
        }),
    );
    return {
      durationMs: discovery.health.durationMs ?? 0,
      feedCount: discovery.feeds.length,
      kind: "completed",
      requestCount: discovery.requestCount,
      result: discovery.result,
      siteId: claim.siteId,
      stale: !persisted,
    };
  } catch (error) {
    return releaseAfterSystemFailure(
      dependencies.repository,
      claim,
      error,
      options,
      dependencies,
    );
  }
}

function applyOutcome(counters: BackfillCounters, outcome: SiteOutcome): void {
  counters.completed += 1;
  if (outcome.stale) counters.staleResults += 1;
  if (outcome.kind === "publisher_failure") {
    counters.publisherFailures += 1;
    return;
  }
  counters.feedCount += outcome.feedCount;
  if (outcome.result === "succeeded") counters.succeeded += 1;
  else counters.noFeed += 1;
}

export async function runBackfill(
  options: BackfillRunOptions,
  dependencies: BackfillDependencies,
): Promise<BackfillRunResult> {
  const startedAt = Date.now();
  const counters = emptyCounters();
  const initialSummary = await repositoryOperation(
    "summary",
    options,
    dependencies,
    () => dependencies.repository.summary(),
  );
  dependencies.log({
    concurrency: options.concurrency,
    dry_run: options.dryRun,
    event: "backfill_start",
    max_sites: options.maxSites,
    leased_count: initialSummary.leasedCount,
    overdue_count: initialSummary.overdueCount,
    pending_count: initialSummary.pendingCount,
  });

  if (options.dryRun) {
    return {
      counters,
      databaseSummary: initialSummary,
      durationMs: Date.now() - startedAt,
      stopped: false,
    };
  }

  const workerId = options.workerId ?? randomUUID();
  const active = new Set<Promise<void>>();
  let fatalError: unknown;
  const shouldStop = options.shouldStop ?? (() => false);

  const logProgress = (outcome: SiteOutcome): void => {
    if (counters.completed % options.progressEvery !== 0) return;
    const elapsedSeconds = Math.max(0.001, (Date.now() - startedAt) / 1_000);
    dependencies.log({
      ...counters,
      active: Math.max(0, active.size - 1),
      elapsed_seconds: Math.round(elapsedSeconds * 10) / 10,
      event: "backfill_progress",
      last_duration_ms: outcome.durationMs,
      last_outcome:
        outcome.kind === "completed" ? outcome.result : outcome.errorCode,
      sites_per_second:
        Math.round((counters.completed / elapsedSeconds) * 100) / 100,
    });
  };

  const launch = (claim: SiteDiscoveryClaim): void => {
    const task = processClaim(claim, options, dependencies)
      .then((outcome) => {
        applyOutcome(counters, outcome);
        logProgress(outcome);
      })
      .catch((error: unknown) => {
        counters.systemFailures += 1;
        fatalError ??= error;
        dependencies.log({
          error_message:
            error instanceof Error ? error.message.slice(0, 300) : undefined,
          error_name: error instanceof Error ? error.name : "UnknownError",
          event: "backfill_system_failure",
          site_id: claim.siteId,
        });
      })
      .finally(() => {
        active.delete(task);
      });
    active.add(task);
  };

  try {
    while (!shouldStop() && fatalError === undefined) {
      while (
        active.size < options.concurrency &&
        fatalError === undefined &&
        !shouldStop() &&
        (options.maxSites === 0 || counters.claimed < options.maxSites)
      ) {
        const remaining =
          options.maxSites === 0
            ? CLAIM_LIMIT
            : Math.min(CLAIM_LIMIT, options.maxSites - counters.claimed);
        const claimLimit = Math.min(
          CLAIM_LIMIT,
          remaining,
          options.concurrency - active.size,
        );
        const claims = await repositoryOperation(
          "claim",
          options,
          dependencies,
          () =>
            dependencies.repository.claim(
              workerId,
              claimLimit,
              options.leaseSeconds,
              true,
            ),
        );
        if (claims.length === 0) {
          break;
        }
        counters.claimed += claims.length;
        for (const claim of claims) launch(claim);
      }

      if (active.size === 0) break;
      await Promise.race(active);
    }
  } catch (error) {
    fatalError ??= error;
  }

  await Promise.allSettled(active);
  if (fatalError !== undefined) throw fatalError;

  const databaseSummary = await repositoryOperation(
    "summary",
    options,
    dependencies,
    () => dependencies.repository.summary(),
  );
  const durationMs = Date.now() - startedAt;
  dependencies.log({
    ...counters,
    duration_seconds: Math.round(durationMs / 100) / 10,
    event: "backfill_complete",
    overdue_count: databaseSummary.overdueCount,
    stopped: shouldStop(),
  });
  return {
    counters,
    databaseSummary,
    durationMs,
    stopped: shouldStop(),
  };
}

async function main(): Promise<void> {
  const arguments_ = parseBackfillArguments(process.argv.slice(2));
  const supabaseUrl = requiredEnvironment("SUPABASE_URL").replace(/\/$/, "");
  const supabaseSecretKey = requiredEnvironment("SUPABASE_SECRET_KEY");
  const contact = requiredEnvironment("DISCOVERY_CONTACT");
  const discoveryConfig = parseDiscoveryConfig({
    DISCOVERY_CLAIM_LIMIT: String(CLAIM_LIMIT),
    DISCOVERY_CONTACT: contact,
    DISCOVERY_ENABLED: "true",
    DISCOVERY_LEASE_SECONDS: String(arguments_.leaseSeconds),
    DISCOVERY_MAX_DELAY_SECONDS: "0",
    DISCOVERY_MAX_PUBLISHER_REQUESTS: String(arguments_.maxPublisherRequests),
    DISCOVERY_POLICY_VERSION: String(arguments_.policyVersion),
    DISCOVERY_QUEUE_HIGH_WATER: String(arguments_.concurrency),
    DISCOVERY_SITE_DEADLINE_SECONDS: String(arguments_.siteDeadlineSeconds),
  });
  if (discoveryConfig.userAgent === null) {
    throw new Error("Discovery contact did not produce a User-Agent");
  }

  let stopRequested = false;
  const requestStop = (): void => {
    stopRequested = true;
    console.log(
      JSON.stringify({ event: "backfill_stop_requested", at: new Date() }),
    );
  };
  process.once("SIGINT", requestStop);
  process.once("SIGTERM", requestStop);

  try {
    await runBackfill(
      {
        ...arguments_,
        shouldStop: () => stopRequested,
        userAgent: discoveryConfig.userAgent,
      },
      {
        discover: (options) =>
          discoverSiteFeeds({
            ...options,
            extractPageLinks: extractFeedLinksNode,
          }),
        log: (record) => {
          console.log(JSON.stringify({ ...record, at: new Date() }));
        },
        repository: createSiteDiscoveryRepository({
          SUPABASE_SECRET_KEY: supabaseSecretKey,
          SUPABASE_URL: supabaseUrl,
        }),
      },
    );
  } finally {
    process.off("SIGINT", requestStop);
    process.off("SIGTERM", requestStop);
  }
}

const entrypoint = process.argv[1];
if (
  entrypoint !== undefined &&
  import.meta.url === pathToFileURL(entrypoint).href
) {
  void main().catch((error: unknown) => {
    console.error(
      JSON.stringify({
        error_message:
          error instanceof Error ? error.message.slice(0, 300) : undefined,
        error_name: error instanceof Error ? error.name : "UnknownError",
        event: "backfill_fatal",
      }),
    );
    process.exitCode = 1;
  });
}
