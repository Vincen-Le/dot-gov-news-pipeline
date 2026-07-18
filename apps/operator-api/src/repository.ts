import {
  GovernmentSiteSchema,
  InventoryRunSchema,
  InventorySummarySchema,
  PipelineEventRecordSchema,
  type GovernmentSite,
  type InventoryRun,
  type InventorySummary,
  type PipelineEventRecord,
} from "@dot-gov-news/contracts";
import { createClient, type SupabaseClient } from "@supabase/supabase-js";

import { decodeCursor, encodeCursor } from "./cursors";
import type { OperatorEnv } from "./env";

export interface CursorPage<T> {
  items: T[];
  nextCursor: string | null;
}

export interface InventoryRunFilters {
  cursor?: string;
  limit: number;
  status?: "running" | "unchanged" | "succeeded" | "failed";
}

export interface GovernmentSiteFilters {
  active?: boolean;
  agency?: string;
  all: boolean;
  cursor?: string;
  hostname?: string;
  limit: number;
}

export interface PipelineEventFilters {
  cursor?: string;
  entity?: string;
  limit: number;
  since?: string;
  type?: string;
}

export interface OperatorRepository {
  getInventorySummary(): Promise<InventorySummary>;
  getLatestInventoryRun(): Promise<InventoryRun | null>;
  getLatestSuccessfulInventoryRun(): Promise<InventoryRun | null>;
  listInventoryRuns(
    filters: InventoryRunFilters,
  ): Promise<CursorPage<InventoryRun>>;
  listGovernmentSites(
    filters: GovernmentSiteFilters,
  ): Promise<CursorPage<GovernmentSite>>;
  listPipelineEvents(
    filters: PipelineEventFilters,
  ): Promise<CursorPage<PipelineEventRecord>>;
}

function providerError(operation: string, code: string | undefined): Error {
  return new Error(
    `Supabase ${operation} failed${code === undefined ? "" : ` (${code})`}`,
  );
}

function record(value: unknown): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error("Supabase returned an invalid record");
  }
  return value as Record<string, unknown>;
}

function nullableString(value: unknown): string | null {
  if (value === null) return null;
  if (typeof value === "string") return value;
  throw new Error("Supabase returned an invalid nullable string");
}

function requiredString(value: unknown, field: string): string {
  if (typeof value !== "string") {
    throw new Error(`Supabase returned invalid ${field}`);
  }
  return value;
}

function nonnegativeInteger(value: unknown, field: string): number {
  const parsed =
    typeof value === "number"
      ? value
      : typeof value === "string" && /^(?:0|[1-9][0-9]*)$/u.test(value)
        ? Number(value)
        : Number.NaN;
  if (!Number.isSafeInteger(parsed) || parsed < 0) {
    throw new Error(`Supabase returned invalid ${field}`);
  }
  return parsed;
}

function booleanValue(value: unknown, field: string): boolean {
  if (typeof value !== "boolean") {
    throw new Error(`Supabase returned invalid ${field}`);
  }
  return value;
}

export function parseInventorySummary(value: unknown): InventorySummary {
  const row = record(value);
  return InventorySummarySchema.parse({
    activeCount: nonnegativeInteger(row.active_count, "active_count"),
    discoveryBackoffCount: nonnegativeInteger(
      row.discovery_backoff_count,
      "discovery_backoff_count",
    ),
    discoveryLeasedCount: nonnegativeInteger(
      row.discovery_leased_count,
      "discovery_leased_count",
    ),
    discoveryPendingCount: nonnegativeInteger(
      row.discovery_pending_count,
      "discovery_pending_count",
    ),
    gsaFilteredCount: nonnegativeInteger(
      row.gsa_filtered_count,
      "gsa_filtered_count",
    ),
    inactiveCount: nonnegativeInteger(row.inactive_count, "inactive_count"),
    ingestionExcludedCount: nonnegativeInteger(
      row.ingestion_excluded_count,
      "ingestion_excluded_count",
    ),
    latestSourceSha256: nullableString(row.latest_source_sha256),
    latestSuccessAt: nullableString(row.latest_success_at),
    totalCount: nonnegativeInteger(row.total_count, "total_count"),
    usableCount: nonnegativeInteger(row.usable_count, "usable_count"),
  });
}

export function parseInventoryRun(value: unknown): InventoryRun {
  const row = record(value);
  return InventoryRunSchema.parse({
    completedAt: nullableString(row.completed_at),
    counts: {
      deactivated: nonnegativeInteger(
        row.deactivated_count,
        "deactivated_count",
      ),
      eligible: nonnegativeInteger(row.eligible_count, "eligible_count"),
      inserted: nonnegativeInteger(row.inserted_count, "inserted_count"),
      reactivated: nonnegativeInteger(
        row.reactivated_count,
        "reactivated_count",
      ),
      sourceRows:
        row.source_row_count === null
          ? null
          : nonnegativeInteger(row.source_row_count, "source_row_count"),
      staged: nonnegativeInteger(row.staged_count, "staged_count"),
      updated: nonnegativeInteger(row.updated_count, "updated_count"),
    },
    errorCode: nullableString(row.error_code),
    id: requiredString(row.id, "id"),
    rawArtifactKey: nullableString(row.raw_artifact_key),
    source: requiredString(row.source, "source"),
    sourceEtag: nullableString(row.source_etag),
    sourceSha256: nullableString(row.source_sha256),
    startedAt: requiredString(row.started_at, "started_at"),
    status: requiredString(row.status, "status"),
  });
}

export function parseGovernmentSite(value: unknown): GovernmentSite {
  const row = record(value);
  return GovernmentSiteSchema.parse({
    agency: nullableString(row.agency),
    baseDomain: nullableString(row.base_domain),
    branch: nullableString(row.branch),
    bureau: nullableString(row.bureau),
    discoveryStatus: nullableString(row.discovery_status),
    exclusionReason: nullableString(row.exclusion_reason),
    firstSeenAt: requiredString(row.first_seen_at, "first_seen_at"),
    gsaFiltered: booleanValue(row.gsa_filtered, "gsa_filtered"),
    id: requiredString(row.id, "id"),
    initialUrl: nullableString(row.initial_url),
    inventoryActive: booleanValue(row.inventory_active, "inventory_active"),
    inventoryUsable: booleanValue(row.inventory_usable, "inventory_usable"),
    lastSeenAt: requiredString(row.last_seen_at, "last_seen_at"),
    nextDiscoveryAt: nullableString(row.next_discovery_at),
    sourceInitialUrl: requiredString(
      row.source_initial_url,
      "source_initial_url",
    ),
    topLevelDomain: requiredString(row.top_level_domain, "top_level_domain"),
  });
}

export function parsePipelineEvent(value: unknown): PipelineEventRecord {
  const row = record(value);
  return PipelineEventRecordSchema.parse({
    artifactKey: nullableString(row.artifact_key),
    createdAt: requiredString(row.created_at, "created_at"),
    eventType: requiredString(row.event_type, "event_type"),
    id: requiredString(row.id, "id"),
    idempotencyKey: requiredString(row.idempotency_key, "idempotency_key"),
    occurredAt: requiredString(row.occurred_at, "occurred_at"),
    payload: record(row.payload),
    schemaVersion: nonnegativeInteger(row.schema_version, "schema_version"),
  });
}

const inventoryRunColumns = [
  "id",
  "source",
  "status",
  "source_etag",
  "source_sha256",
  "raw_artifact_key",
  "source_row_count",
  "staged_count",
  "inserted_count",
  "updated_count",
  "reactivated_count",
  "deactivated_count",
  "eligible_count",
  "error_code",
  "started_at",
  "completed_at",
].join(",");

class SupabaseOperatorRepository implements OperatorRepository {
  readonly #client: SupabaseClient;

  constructor(client: SupabaseClient) {
    this.#client = client;
  }

  async getInventorySummary(): Promise<InventorySummary> {
    const { data, error } = await this.#client.rpc(
      "get_government_inventory_summary",
    );
    if (error !== null) {
      throw providerError("inventory summary", error.code);
    }
    if (!Array.isArray(data) || data.length !== 1) {
      throw new Error("Supabase returned an invalid inventory summary");
    }
    return parseInventorySummary(data[0]);
  }

  async getLatestInventoryRun(): Promise<InventoryRun | null> {
    const { data, error } = await this.#client
      .from("inventory_sync_runs")
      .select(inventoryRunColumns)
      .order("started_at", { ascending: false })
      .order("id", { ascending: false })
      .limit(1)
      .maybeSingle();
    if (error !== null) {
      throw providerError("latest inventory run", error.code);
    }
    return data === null ? null : parseInventoryRun(data);
  }

  async getLatestSuccessfulInventoryRun(): Promise<InventoryRun | null> {
    const { data, error } = await this.#client
      .from("inventory_sync_runs")
      .select(inventoryRunColumns)
      .eq("status", "succeeded")
      .order("completed_at", { ascending: false })
      .order("id", { ascending: false })
      .limit(1)
      .maybeSingle();
    if (error !== null) {
      throw providerError("latest successful inventory run", error.code);
    }
    return data === null ? null : parseInventoryRun(data);
  }

  async listInventoryRuns(
    filters: InventoryRunFilters,
  ): Promise<CursorPage<InventoryRun>> {
    let query = this.#client
      .from("inventory_sync_runs")
      .select(inventoryRunColumns)
      .order("started_at", { ascending: false })
      .order("id", { ascending: false })
      .limit(filters.limit + 1);

    if (filters.status !== undefined) {
      query = query.eq("status", filters.status);
    }
    if (filters.cursor !== undefined) {
      const cursor = decodeCursor(filters.cursor);
      query = query.or(
        `started_at.lt.${cursor.timestamp},and(started_at.eq.${cursor.timestamp},id.lt.${cursor.id})`,
      );
    }

    const { data, error } = await query;
    if (error !== null) {
      throw providerError("inventory run list", error.code);
    }

    if (!Array.isArray(data)) {
      throw new Error("Supabase returned an invalid inventory run list");
    }
    const rows = data;
    const pageRows = rows.slice(0, filters.limit);
    const items = pageRows.map(parseInventoryRun);
    const last = items.at(-1);
    return {
      items,
      nextCursor:
        rows.length > filters.limit && last !== undefined
          ? encodeCursor({ id: last.id, timestamp: last.startedAt })
          : null,
    };
  }

  async listGovernmentSites(
    filters: GovernmentSiteFilters,
  ): Promise<CursorPage<GovernmentSite>> {
    const { data, error } = await this.#client.rpc("list_government_sites", {
      p_after_id: filters.cursor ?? null,
      p_agency: filters.agency ?? null,
      p_base_domain: null,
      p_initial_url: filters.hostname?.toLowerCase() ?? null,
      p_inventory_active: filters.active ?? null,
      p_limit: filters.limit + 1,
      p_usable_only: !filters.all,
    });
    if (error !== null) {
      throw providerError("government site list", error.code);
    }

    if (!Array.isArray(data)) {
      throw new Error("Supabase returned an invalid government site list");
    }
    const rows = data;
    const pageRows = rows.slice(0, filters.limit);
    const items = pageRows.map(parseGovernmentSite);
    const last = items.at(-1);
    return {
      items,
      nextCursor:
        rows.length > filters.limit && last !== undefined ? last.id : null,
    };
  }

  async listPipelineEvents(
    filters: PipelineEventFilters,
  ): Promise<CursorPage<PipelineEventRecord>> {
    let query = this.#client
      .from("pipeline_events")
      .select(
        "id,schema_version,event_type,idempotency_key,occurred_at,payload,artifact_key,created_at",
      )
      .order("occurred_at", { ascending: false })
      .order("id", { ascending: false })
      .limit(filters.limit + 1);

    if (filters.type !== undefined) {
      query = query.eq("event_type", filters.type);
    }
    if (filters.since !== undefined) {
      query = query.gte("occurred_at", filters.since);
    }
    if (filters.entity !== undefined) {
      query = query.contains("payload", { entityId: filters.entity });
    }
    if (filters.cursor !== undefined) {
      const cursor = decodeCursor(filters.cursor);
      query = query.or(
        `occurred_at.lt.${cursor.timestamp},and(occurred_at.eq.${cursor.timestamp},id.lt.${cursor.id})`,
      );
    }

    const { data, error } = await query;
    if (error !== null) {
      throw providerError("pipeline event list", error.code);
    }

    if (!Array.isArray(data)) {
      throw new Error("Supabase returned an invalid pipeline event list");
    }
    const rows = data;
    const pageRows = rows.slice(0, filters.limit);
    const items = pageRows.map(parsePipelineEvent);
    const last = items.at(-1);
    return {
      items,
      nextCursor:
        rows.length > filters.limit && last !== undefined
          ? encodeCursor({ id: last.id, timestamp: last.occurredAt })
          : null,
    };
  }
}

export function createOperatorRepository(
  env: Pick<OperatorEnv, "SUPABASE_SECRET_KEY" | "SUPABASE_URL">,
): OperatorRepository {
  const client = createClient(env.SUPABASE_URL, env.SUPABASE_SECRET_KEY, {
    auth: {
      autoRefreshToken: false,
      detectSessionInUrl: false,
      persistSession: false,
    },
  });
  return new SupabaseOperatorRepository(client);
}
