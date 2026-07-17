import { resolve } from "node:path";

import { beforeEach, describe, expect, it, vi } from "vitest";

import { snapshotFromLocalFile } from "../src/gsa-client";
import type { InventorySnapshotStore } from "../src/r2-snapshot-store";
import type {
  InventoryRepository,
  InventoryRunOutcome,
  LatestSuccessfulInventoryRun,
} from "../src/supabase-inventory";
import { syncGsaInventory } from "../src/sync-gsa-inventory";

const validFixture = resolve(import.meta.dirname, "fixtures/gsa-valid.csv");

function makeRepository(
  latest: LatestSuccessfulInventoryRun | null = null,
): InventoryRepository & {
  createRun: ReturnType<typeof vi.fn>;
  failRun: ReturnType<typeof vi.fn>;
  finalizeRun: ReturnType<typeof vi.fn>;
  findLatestSuccessfulRun: ReturnType<typeof vi.fn>;
  getRunOutcome: ReturnType<typeof vi.fn>;
  markRunUnchanged: ReturnType<typeof vi.fn>;
  recordSnapshotMetadata: ReturnType<typeof vi.fn>;
  stageBatch: ReturnType<typeof vi.fn>;
} {
  return {
    createRun: vi.fn().mockResolvedValue("run-id"),
    failRun: vi.fn().mockResolvedValue(undefined),
    finalizeRun: vi.fn().mockResolvedValue({
      deactivated_count: 0,
      eligible_count: 2,
      inserted_count: 3,
      reactivated_count: 0,
      updated_count: 0,
    }),
    findLatestSuccessfulRun: vi.fn().mockResolvedValue(latest),
    getRunOutcome: vi
      .fn()
      .mockResolvedValue({ status: "running" } as InventoryRunOutcome),
    markRunUnchanged: vi.fn().mockResolvedValue(undefined),
    recordSnapshotMetadata: vi.fn().mockResolvedValue(undefined),
    stageBatch: vi.fn().mockResolvedValue(3),
  };
}

function makeSnapshotStore(): InventorySnapshotStore & {
  archive: ReturnType<typeof vi.fn>;
} {
  return {
    archive: vi.fn().mockResolvedValue("inventory/gsa/snapshot-checksum.csv"),
  };
}

describe("GSA inventory synchronization", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it("archives, stages, and finalizes a valid snapshot", async () => {
    const repository = makeRepository();
    const snapshotStore = makeSnapshotStore();

    const result = await syncGsaInventory({
      download: async () => snapshotFromLocalFile(validFixture),
      minimumRowCount: 1,
      repository,
      snapshotStore,
      stageBatchSize: 2,
    });

    expect(result).toMatchObject({
      eligible_count: 2,
      inserted_count: 3,
      runId: "run-id",
      sourceRowCount: 3,
      status: "succeeded",
    });
    expect(snapshotStore.archive).toHaveBeenCalledOnce();
    expect(repository.stageBatch).toHaveBeenCalledTimes(2);
    expect(repository.stageBatch.mock.calls[0]?.[1]).toHaveLength(2);
    expect(repository.stageBatch.mock.calls[1]?.[1]).toHaveLength(1);
    expect(repository.recordSnapshotMetadata).toHaveBeenCalledWith(
      "run-id",
      expect.objectContaining({ rowCount: 3 }),
    );
    expect(repository.finalizeRun).toHaveBeenCalledOnce();
    expect(repository.failRun).not.toHaveBeenCalled();
  });

  it("short-circuits an unchanged checksum before R2 or staging", async () => {
    const snapshot = await snapshotFromLocalFile(validFixture);
    const repository = makeRepository({
      eligibleCount: 2,
      sourceEtag: '"old"',
      sourceRowCount: 3,
      sourceSha256: snapshot.sha256,
    });
    const snapshotStore = makeSnapshotStore();

    const result = await syncGsaInventory({
      download: async () => snapshot,
      repository,
      snapshotStore,
    });

    expect(result.status).toBe("unchanged");
    expect(result.eligible_count).toBe(2);
    expect(repository.markRunUnchanged).toHaveBeenCalledOnce();
    expect(snapshotStore.archive).not.toHaveBeenCalled();
    expect(repository.stageBatch).not.toHaveBeenCalled();
  });

  it("records a bounded failure without finalizing malformed input", async () => {
    const malformedFixture = resolve(
      import.meta.dirname,
      "fixtures/gsa-malformed.csv",
    );
    const repository = makeRepository();

    await expect(
      syncGsaInventory({
        download: async () => snapshotFromLocalFile(malformedFixture),
        minimumRowCount: 1,
        repository,
        snapshotStore: makeSnapshotStore(),
      }),
    ).rejects.toThrow();

    expect(repository.finalizeRun).not.toHaveBeenCalled();
    expect(repository.failRun).toHaveBeenCalledWith(
      "run-id",
      expect.any(String),
      expect.any(String),
    );
  });
});
