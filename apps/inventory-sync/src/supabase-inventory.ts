import { createClient, type SupabaseClient } from "@supabase/supabase-js";

import {
  GSA_INVENTORY_SOURCE,
  type InventoryFinalizeResult,
  type StagedGsaInventoryRow,
} from "./inventory-types";

export interface LatestSuccessfulInventoryRun {
  eligibleCount: number;
  sourceEtag: string | null;
  sourceRowCount: number;
  sourceSha256: string;
}

export interface InventoryRunOutcome extends InventoryFinalizeResult {
  status: "failed" | "running" | "succeeded" | "unchanged";
}

export interface InventoryRepository {
  createRun(sourceUrl: string): Promise<string>;
  failRun(runId: string, code: string, detail: string): Promise<void>;
  finalizeRun(
    runId: string,
    options?: { allowLargeDecrease?: boolean; minimumRowCount?: number },
  ): Promise<InventoryFinalizeResult>;
  findLatestSuccessfulRun(): Promise<LatestSuccessfulInventoryRun | null>;
  getRunOutcome(runId: string): Promise<InventoryRunOutcome | null>;
  markRunUnchanged(
    runId: string,
    input: {
      etag: string | null;
      eligibleCount: number;
      rowCount?: number;
      sha256?: string;
    },
  ): Promise<void>;
  recordSnapshotMetadata(
    runId: string,
    input: {
      artifactKey: string;
      etag: string | null;
      rowCount: number;
      sha256: string;
    },
  ): Promise<void>;
  stageBatch(runId: string, rows: StagedGsaInventoryRow[]): Promise<number>;
}

function databaseError(operation: string, code: string | undefined): Error {
  return new Error(
    `Supabase ${operation} failed${code === undefined ? "" : ` with code ${code}`}`,
  );
}

export function parseInventoryRunId(data: unknown): string {
  if (
    typeof data !== "string" ||
    !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(
      data,
    )
  ) {
    throw new Error("Supabase run creation returned an invalid UUID");
  }

  return data;
}

function parseFinalizeResult(data: unknown): InventoryFinalizeResult {
  if (typeof data !== "object" || data === null) {
    throw new Error("Supabase finalization returned an invalid result");
  }

  const numericField = (name: keyof InventoryFinalizeResult): number => {
    const value = Reflect.get(data, name);
    const parsed = Number(value);
    if (!Number.isSafeInteger(parsed) || parsed < 0) {
      throw new Error(`Supabase finalization returned invalid ${name}`);
    }
    return parsed;
  };

  return {
    deactivated_count: numericField("deactivated_count"),
    eligible_count: numericField("eligible_count"),
    inserted_count: numericField("inserted_count"),
    reactivated_count: numericField("reactivated_count"),
    updated_count: numericField("updated_count"),
  };
}

class SupabaseInventoryRepository implements InventoryRepository {
  readonly #client: SupabaseClient;

  constructor(client: SupabaseClient) {
    this.#client = client;
  }

  async findLatestSuccessfulRun(): Promise<LatestSuccessfulInventoryRun | null> {
    const { data, error } = await this.#client
      .from("inventory_sync_runs")
      .select("eligible_count,source_etag,source_row_count,source_sha256")
      .eq("source", GSA_INVENTORY_SOURCE)
      .eq("status", "succeeded")
      .not("source_sha256", "is", null)
      .not("source_row_count", "is", null)
      .order("completed_at", { ascending: false })
      .limit(1)
      .maybeSingle();

    if (error !== null) {
      throw databaseError("latest-run query", error.code);
    }
    if (data === null) {
      return null;
    }

    return {
      eligibleCount: Number(data.eligible_count),
      sourceEtag:
        typeof data.source_etag === "string" ? data.source_etag : null,
      sourceRowCount: Number(data.source_row_count),
      sourceSha256: String(data.source_sha256),
    };
  }

  async createRun(sourceUrl: string): Promise<string> {
    const { data, error } = await this.#client.rpc("begin_gsa_inventory_sync", {
      p_source_url: sourceUrl,
    });

    if (error !== null) {
      throw databaseError("run creation", error.code);
    }
    return parseInventoryRunId(data);
  }

  async getRunOutcome(runId: string): Promise<InventoryRunOutcome | null> {
    const { data, error } = await this.#client
      .from("inventory_sync_runs")
      .select(
        "status,inserted_count,updated_count,reactivated_count,deactivated_count,eligible_count",
      )
      .eq("id", runId)
      .maybeSingle();

    if (error !== null) {
      throw databaseError("run outcome query", error.code);
    }
    if (data === null) {
      return null;
    }

    return {
      deactivated_count: Number(data.deactivated_count),
      eligible_count: Number(data.eligible_count),
      inserted_count: Number(data.inserted_count),
      reactivated_count: Number(data.reactivated_count),
      status: data.status as InventoryRunOutcome["status"],
      updated_count: Number(data.updated_count),
    };
  }

  async markRunUnchanged(
    runId: string,
    input: {
      etag: string | null;
      eligibleCount: number;
      rowCount?: number;
      sha256?: string;
    },
  ): Promise<void> {
    if (input.rowCount === undefined || input.sha256 === undefined) {
      throw new Error("Unchanged inventory metadata is incomplete");
    }

    const { error } = await this.#client.rpc(
      "mark_gsa_inventory_sync_unchanged",
      {
        p_eligible_count: input.eligibleCount,
        p_source_etag: input.etag,
        p_source_row_count: input.rowCount,
        p_source_sha256: input.sha256,
        p_sync_run_id: runId,
      },
    );

    if (error !== null) {
      throw databaseError("unchanged-run update", error.code);
    }
  }

  async recordSnapshotMetadata(
    runId: string,
    input: {
      artifactKey: string;
      etag: string | null;
      rowCount: number;
      sha256: string;
    },
  ): Promise<void> {
    const { error } = await this.#client.rpc("record_gsa_inventory_snapshot", {
      p_raw_artifact_key: input.artifactKey,
      p_source_etag: input.etag,
      p_source_row_count: input.rowCount,
      p_source_sha256: input.sha256,
      p_sync_run_id: runId,
    });

    if (error !== null) {
      throw databaseError("snapshot metadata update", error.code);
    }
  }

  async stageBatch(
    runId: string,
    rows: StagedGsaInventoryRow[],
  ): Promise<number> {
    const { data, error } = await this.#client.rpc(
      "stage_gsa_inventory_batch",
      {
        p_rows: rows,
        p_sync_run_id: runId,
      },
    );

    if (error !== null) {
      throw databaseError("staging RPC", error.code);
    }

    return Number(data);
  }

  async finalizeRun(
    runId: string,
    options: { allowLargeDecrease?: boolean; minimumRowCount?: number } = {},
  ): Promise<InventoryFinalizeResult> {
    const { data, error } = await this.#client
      .rpc("finalize_gsa_inventory_sync", {
        p_allow_large_decrease: options.allowLargeDecrease ?? false,
        p_minimum_row_count: options.minimumRowCount ?? 20_000,
        p_sync_run_id: runId,
      })
      .single();

    if (error !== null) {
      throw databaseError("finalization RPC", error.code);
    }

    return parseFinalizeResult(data);
  }

  async failRun(runId: string, code: string, detail: string): Promise<void> {
    const { error } = await this.#client.rpc("fail_gsa_inventory_sync", {
      p_error_code: code.slice(0, 128),
      p_error_detail: detail.slice(0, 1000),
      p_sync_run_id: runId,
    });

    if (error !== null) {
      throw databaseError("failed-run update", error.code);
    }
  }
}

export function createSupabaseInventoryRepository(config: {
  secretKey: string;
  url: string;
}): InventoryRepository {
  const client = createClient(config.url, config.secretKey, {
    auth: {
      autoRefreshToken: false,
      detectSessionInUrl: false,
      persistSession: false,
    },
  });

  return new SupabaseInventoryRepository(client);
}
