import { createClient } from "@supabase/supabase-js";

import type { WorkerEnv } from "../env";

export type FeedType = "atom" | "json_feed" | "rss";
export type DiscoveryMethod =
  | "anchor"
  | "conventional_path"
  | "html_alternate"
  | "http_link"
  | "root_document";

export interface SiteDiscoveryClaim {
  baseDomain: string;
  initialUrl: string;
  leaseToken: string;
  leaseUntil: string;
  siteId: string;
}

export interface SiteDiscoveryHealth {
  durationMs?: number;
  finalUrl?: string;
  httpStatus?: number;
}

export interface DiscoveredFeed {
  canonicalUrl: string;
  discoveryMethod: DiscoveryMethod;
  discoveryUrl: string;
  feedType: FeedType;
  homePageUrl: string | null;
  httpStatus: number | null;
  title: string | null;
}

export interface SiteDiscoverySummary {
  activeRelationshipCount: number;
  backoffCount: number;
  disabledCount: number;
  expiredLeaseCount: number;
  feedCount: number;
  leasedCount: number;
  noFeedCount: number;
  oldestDueAt: string | null;
  overdueCount: number;
  pendingCount: number;
  succeededCount: number;
}

export interface SiteDiscoveryRepository {
  claim(
    workerId: string,
    limit: number,
    leaseSeconds: number,
  ): Promise<SiteDiscoveryClaim[]>;
  complete(input: {
    feeds: DiscoveredFeed[];
    health: SiteDiscoveryHealth;
    leaseToken: string;
    policyVersion: number;
    result: "no_feed" | "succeeded";
    siteId: string;
  }): Promise<boolean>;
  fail(input: {
    errorCode: string;
    errorDetail: string;
    leaseToken: string;
    policyVersion: number;
    retryAfterSeconds: number;
    siteId: string;
  }): Promise<boolean>;
  release(
    siteId: string,
    leaseToken: string,
    reasonCode: string,
  ): Promise<boolean>;
  renew(
    siteId: string,
    leaseToken: string,
    leaseSeconds: number,
  ): Promise<string | null>;
  summary(): Promise<SiteDiscoverySummary>;
}

interface RpcError {
  code: string;
}

type Rpc = (
  functionName: string,
  arguments_: Record<string, unknown>,
) => Promise<{ data: unknown; error: RpcError | null }>;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function requireUuid(value: unknown, field: string): string {
  if (
    typeof value !== "string" ||
    !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(
      value,
    )
  ) {
    throw new Error(`Supabase returned an invalid ${field}`);
  }
  return value;
}

function requireString(value: unknown, field: string, maximum: number): string {
  if (typeof value !== "string" || value.length < 1 || value.length > maximum) {
    throw new Error(`Supabase returned an invalid ${field}`);
  }
  return value;
}

function requireTimestamp(value: unknown, field: string): string {
  const timestamp = requireString(value, field, 64);
  if (!Number.isFinite(Date.parse(timestamp))) {
    throw new Error(`Supabase returned an invalid ${field}`);
  }
  return timestamp;
}

function requireCount(value: unknown, field: string): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) {
    throw new Error(`Supabase returned an invalid ${field}`);
  }
  return value;
}

function parseClaim(value: unknown): SiteDiscoveryClaim {
  if (!isRecord(value)) throw new Error("Supabase returned an invalid claim");
  return {
    baseDomain: requireString(value.base_domain, "base_domain", 253),
    initialUrl: requireString(value.initial_url, "initial_url", 253),
    leaseToken: requireUuid(value.lease_token, "lease_token"),
    leaseUntil: requireTimestamp(value.lease_until, "lease_until"),
    siteId: requireUuid(value.site_id, "site_id"),
  };
}

function parseSummary(value: unknown): SiteDiscoverySummary {
  if (!isRecord(value)) throw new Error("Supabase returned an invalid summary");
  return {
    activeRelationshipCount: requireCount(
      value.active_relationship_count,
      "active_relationship_count",
    ),
    backoffCount: requireCount(value.backoff_count, "backoff_count"),
    disabledCount: requireCount(value.disabled_count, "disabled_count"),
    expiredLeaseCount: requireCount(
      value.expired_lease_count,
      "expired_lease_count",
    ),
    feedCount: requireCount(value.feed_count, "feed_count"),
    leasedCount: requireCount(value.leased_count, "leased_count"),
    noFeedCount: requireCount(value.no_feed_count, "no_feed_count"),
    oldestDueAt:
      value.oldest_due_at === null
        ? null
        : requireTimestamp(value.oldest_due_at, "oldest_due_at"),
    overdueCount: requireCount(value.overdue_count, "overdue_count"),
    pendingCount: requireCount(value.pending_count, "pending_count"),
    succeededCount: requireCount(value.succeeded_count, "succeeded_count"),
  };
}

function mapHealth(health: SiteDiscoveryHealth): Record<string, unknown> {
  return {
    ...(health.durationMs === undefined
      ? {}
      : { duration_ms: health.durationMs }),
    ...(health.finalUrl === undefined ? {} : { final_url: health.finalUrl }),
    ...(health.httpStatus === undefined
      ? {}
      : { http_status: health.httpStatus }),
  };
}

function mapFeed(feed: DiscoveredFeed): Record<string, unknown> {
  return {
    canonical_url: feed.canonicalUrl,
    discovery_method: feed.discoveryMethod,
    discovery_url: feed.discoveryUrl,
    feed_type: feed.feedType,
    home_page_url: feed.homePageUrl,
    http_status: feed.httpStatus,
    title: feed.title,
  };
}

async function callRpc(
  rpc: Rpc,
  name: string,
  arguments_: Record<string, unknown>,
): Promise<unknown> {
  const { data, error } = await rpc(name, arguments_);
  if (error !== null) {
    throw new Error(`Supabase RPC ${name} failed with code ${error.code}`);
  }
  return data;
}

export function createSiteDiscoveryRepositoryForRpc(
  rpc: Rpc,
): SiteDiscoveryRepository {
  return {
    async claim(workerId, limit, leaseSeconds) {
      const data = await callRpc(rpc, "claim_due_site_discoveries", {
        p_claim_limit: limit,
        p_lease_seconds: leaseSeconds,
        p_worker_id: workerId,
      });
      if (!Array.isArray(data) || data.length > limit) {
        throw new Error("Supabase returned an invalid claim collection");
      }
      return data.map(parseClaim);
    },

    async complete(input) {
      const data = await callRpc(rpc, "complete_site_discovery", {
        p_feeds: input.feeds.map(mapFeed),
        p_lease_token: input.leaseToken,
        p_policy_version: input.policyVersion,
        p_result: input.result,
        p_site_health: mapHealth(input.health),
        p_site_id: input.siteId,
      });
      if (typeof data !== "boolean") {
        throw new Error("Supabase returned an invalid completion result");
      }
      return data;
    },

    async fail(input) {
      const data = await callRpc(rpc, "fail_site_discovery", {
        p_error_code: input.errorCode,
        p_error_detail: input.errorDetail,
        p_lease_token: input.leaseToken,
        p_policy_version: input.policyVersion,
        p_retry_after_seconds: input.retryAfterSeconds,
        p_site_id: input.siteId,
      });
      if (typeof data !== "boolean") {
        throw new Error("Supabase returned an invalid failure result");
      }
      return data;
    },

    async release(siteId, leaseToken, reasonCode) {
      const data = await callRpc(rpc, "release_site_discovery_lease", {
        p_lease_token: leaseToken,
        p_reason_code: reasonCode,
        p_site_id: siteId,
      });
      if (typeof data !== "boolean") {
        throw new Error("Supabase returned an invalid release result");
      }
      return data;
    },

    async renew(siteId, leaseToken, leaseSeconds) {
      const data = await callRpc(rpc, "renew_site_discovery_lease", {
        p_lease_seconds: leaseSeconds,
        p_lease_token: leaseToken,
        p_site_id: siteId,
      });
      return data === null ? null : requireTimestamp(data, "renewed lease");
    },

    async summary() {
      const data = await callRpc(rpc, "get_site_discovery_summary", {});
      if (!Array.isArray(data) || data.length !== 1) {
        throw new Error("Supabase returned an invalid summary collection");
      }
      return parseSummary(data[0]);
    },
  };
}

export function createSiteDiscoveryRepository(
  env: Pick<WorkerEnv, "SUPABASE_SECRET_KEY" | "SUPABASE_URL">,
): SiteDiscoveryRepository {
  const client = createClient(env.SUPABASE_URL, env.SUPABASE_SECRET_KEY, {
    auth: {
      autoRefreshToken: false,
      detectSessionInUrl: false,
      persistSession: false,
    },
  });
  return createSiteDiscoveryRepositoryForRpc(async (name, arguments_) => {
    const result = await client.rpc(name, arguments_);
    return { data: result.data, error: result.error };
  });
}
