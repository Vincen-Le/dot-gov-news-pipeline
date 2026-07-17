import { createReadStream } from "node:fs";

import { parseGsaCsv } from "./gsa-csv";
import {
  downloadGsaSnapshot,
  type DownloadGsaSnapshotOptions,
  type GsaSnapshotDownload,
} from "./gsa-client";
import {
  analyzeGsaInventoryFile,
  applyGsaInventoryPolicy,
} from "./gsa-inventory-policy";
import {
  DEFAULT_GSA_INVENTORY_URL,
  type InventorySyncResult,
  type StagedGsaInventoryRow,
} from "./inventory-types";
import type { InventorySnapshotStore } from "./r2-snapshot-store";
import type { InventoryRepository } from "./supabase-inventory";

const DEFAULT_STAGE_BATCH_SIZE = 500;

export interface SyncGsaInventoryOptions {
  allowLargeDecrease?: boolean;
  download?: (
    options: DownloadGsaSnapshotOptions,
  ) => Promise<GsaSnapshotDownload>;
  minimumRowCount?: number;
  repository: InventoryRepository;
  snapshotStore: InventorySnapshotStore;
  sourceUrl?: string;
  stageBatchSize?: number;
}

function boundedError(error: unknown): { code: string; detail: string } {
  if (error instanceof Error) {
    const code = Reflect.get(error, "code");
    return {
      code: typeof code === "string" ? code : error.name,
      detail: error.message.slice(0, 1000),
    };
  }

  return { code: "UnknownError", detail: "Unknown inventory sync failure" };
}

export async function syncGsaInventory(
  options: SyncGsaInventoryOptions,
): Promise<InventorySyncResult> {
  const sourceUrl = options.sourceUrl ?? DEFAULT_GSA_INVENTORY_URL;
  const stageBatchSize = options.stageBatchSize ?? DEFAULT_STAGE_BATCH_SIZE;
  if (stageBatchSize < 1 || stageBatchSize > 1000) {
    throw new Error("stageBatchSize must be between 1 and 1000");
  }

  const latestRun = await options.repository.findLatestSuccessfulRun();
  const runId = await options.repository.createRun(sourceUrl);
  let snapshot: GsaSnapshotDownload | undefined;
  let sourceRowCount = 0;

  try {
    snapshot = await (options.download ?? downloadGsaSnapshot)({
      etag: latestRun?.sourceEtag,
      sourceUrl,
    });

    if (snapshot.kind === "not_modified") {
      if (latestRun === null) {
        throw new Error("GSA returned 304 without a prior successful snapshot");
      }

      await options.repository.markRunUnchanged(runId, {
        etag: snapshot.etag,
        eligibleCount: latestRun.eligibleCount,
        rowCount: latestRun.sourceRowCount,
        sha256: latestRun.sourceSha256,
      });
      return {
        deactivated_count: 0,
        eligible_count: latestRun.eligibleCount,
        inserted_count: 0,
        reactivated_count: 0,
        runId,
        sha256: latestRun.sourceSha256,
        sourceRowCount: latestRun.sourceRowCount,
        status: "unchanged",
        updated_count: 0,
      };
    }

    if (latestRun?.sourceSha256 === snapshot.sha256) {
      await options.repository.markRunUnchanged(runId, {
        etag: snapshot.etag,
        eligibleCount: latestRun.eligibleCount,
        rowCount: latestRun.sourceRowCount,
        sha256: snapshot.sha256,
      });
      return {
        deactivated_count: 0,
        eligible_count: latestRun.eligibleCount,
        inserted_count: 0,
        reactivated_count: 0,
        runId,
        sha256: snapshot.sha256,
        sourceRowCount: latestRun.sourceRowCount,
        status: "unchanged",
        updated_count: 0,
      };
    }

    const artifactKey = await options.snapshotStore.archive({
      bytes: snapshot.bytes,
      filePath: snapshot.filePath,
      sha256: snapshot.sha256,
    });
    const analysis = await analyzeGsaInventoryFile(snapshot.filePath);
    const pendingBatch: StagedGsaInventoryRow[] = [];
    sourceRowCount = analysis.sourceRowCount;
    let stagedRowCount = 0;

    for await (const parsedRow of parseGsaCsv(
      createReadStream(snapshot.filePath),
    )) {
      pendingBatch.push(applyGsaInventoryPolicy(parsedRow, analysis));
      stagedRowCount += 1;

      if (pendingBatch.length === stageBatchSize) {
        await options.repository.stageBatch(runId, pendingBatch.splice(0));
      }
    }

    if (pendingBatch.length > 0) {
      await options.repository.stageBatch(runId, pendingBatch);
    }
    if (stagedRowCount !== sourceRowCount) {
      throw new Error("GSA snapshot changed between validation and staging");
    }

    await options.repository.recordSnapshotMetadata(runId, {
      artifactKey,
      etag: snapshot.etag,
      rowCount: sourceRowCount,
      sha256: snapshot.sha256,
    });

    const finalization = await options.repository.finalizeRun(runId, {
      allowLargeDecrease: options.allowLargeDecrease,
      minimumRowCount: options.minimumRowCount,
    });

    return {
      ...finalization,
      runId,
      sha256: snapshot.sha256,
      sourceRowCount,
      status: "succeeded",
    };
  } catch (error) {
    const outcome = await options.repository
      .getRunOutcome(runId)
      .catch(() => null);
    if (outcome?.status === "succeeded") {
      return {
        ...outcome,
        runId,
        sha256:
          snapshot?.kind === "downloaded"
            ? snapshot.sha256
            : (latestRun?.sourceSha256 ?? ""),
        sourceRowCount,
        status: "succeeded",
      };
    }

    const failure = boundedError(error);
    await options.repository
      .failRun(runId, failure.code, failure.detail)
      .catch(() => undefined);
    throw error;
  } finally {
    if (snapshot?.kind === "downloaded") {
      await snapshot.cleanup();
    }
  }
}
