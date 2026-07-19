import { describe, expect, it, vi } from "vitest";

import type { PipelineEntry } from "../src/config";
import type { LabDb } from "../src/lab/db";
import {
  isManagedPipeline,
  pipelineDbName,
  pipelineSkipReason,
  probePipelineDatabase,
  setupPipeline,
} from "../src/lab/setup";

function entry(overrides: Partial<PipelineEntry> = {}): PipelineEntry {
  return {
    databaseUrl: "postgresql://postgres:postgres@127.0.0.1:57422/complex_db",
    engine: "classic",
    name: "complex",
    ...overrides,
  };
}

/** Fakes a sequence of `db.read` results (or errors) shared across every
 * connection the code under test opens, in call order. */
function fakeConnect(
  responses: Array<Record<string, unknown>[] | Error>,
): () => LabDb {
  let index = 0;
  return () => ({
    close: async () => undefined,
    read: (async () => {
      const response = responses[index];
      index += 1;
      if (response instanceof Error) throw response;
      return response ?? [];
    }) as unknown as LabDb["read"],
  });
}

const notExist = Object.assign(new Error('database "x_db" does not exist'), {
  code: "3D000",
});

const allTablesRow = [
  {
    experiment_runs: true,
    news_entries: true,
    rank_snapshots: true,
    rpc: true,
  },
];

describe("pipelineDbName / isManagedPipeline", () => {
  it("parses the dbname from a postgres URL", () => {
    expect(pipelineDbName(entry())).toBe("complex_db");
  });

  it("returns an empty string for an unparsable databaseUrl", () => {
    expect(pipelineDbName(entry({ databaseUrl: "not a url" }))).toBe("");
  });

  it("is managed only when dbname matches <name>_db", () => {
    expect(isManagedPipeline(entry())).toBe(true);
    expect(
      isManagedPipeline(
        entry({
          databaseUrl: "postgresql://postgres:postgres@127.0.0.1:57422/other_db",
        }),
      ),
    ).toBe(false);
  });
});

describe("pipelineSkipReason", () => {
  it("refuses non-local DSNs", () => {
    const remote = entry({
      databaseUrl: "postgresql://u:p@aws-1-us-east-2.pooler.supabase.com:5432/complex_db",
    });
    expect(pipelineSkipReason(remote)).toContain("non-local");
  });

  it("refuses the primary postgres database", () => {
    const primary = entry({
      databaseUrl: "postgresql://postgres:postgres@127.0.0.1:57422/postgres",
    });
    expect(pipelineSkipReason(primary)).toBe("unmanaged (primary)");
  });

  it("allows a local, non-primary DSN", () => {
    expect(pipelineSkipReason(entry())).toBeNull();
  });
});

describe("probePipelineDatabase", () => {
  it("classifies a nonexistent database as missing", async () => {
    const probe = await probePipelineDatabase(fakeConnect([notExist]));
    expect(probe).toEqual({ entries: 0, missing: [], status: "missing" });
  });

  it("rethrows non-3D000 errors", async () => {
    const other = new Error("connection refused");
    await expect(probePipelineDatabase(fakeConnect([other]))).rejects.toThrow(
      "connection refused",
    );
  });

  it("reports verified with an entry count when every table and the RPC exist", async () => {
    const probe = await probePipelineDatabase(
      fakeConnect([allTablesRow, [{ count: 42 }]]),
    );
    expect(probe).toEqual({ entries: 42, missing: [], status: "verified" });
  });

  it("lists missing tables and the RPC, skipping the entry count query", async () => {
    const probe = await probePipelineDatabase(
      fakeConnect([
        [
          {
            experiment_runs: false,
            news_entries: false,
            rank_snapshots: true,
            rpc: false,
          },
        ],
      ]),
    );
    expect(probe.status).toBe("verified");
    expect(probe.entries).toBe(0);
    expect(probe.missing).toEqual([
      "news_entries",
      "experiment_runs",
      "create_episode_with_storyline (RPC)",
    ]);
  });
});

describe("setupPipeline", () => {
  it("skips non-local DSNs without connecting or provisioning", async () => {
    const connect = vi.fn();
    const provision = vi.fn();
    const result = await setupPipeline(
      entry({ databaseUrl: "postgresql://u:p@example.com:5432/complex_db" }),
      { connect, provision },
    );
    expect(result.status).toContain("non-local");
    expect(connect).not.toHaveBeenCalled();
    expect(provision).not.toHaveBeenCalled();
  });

  it("skips the primary postgres database without connecting or provisioning", async () => {
    const connect = vi.fn();
    const provision = vi.fn();
    const result = await setupPipeline(
      entry({ databaseUrl: "postgresql://postgres:postgres@127.0.0.1:57422/postgres" }),
      { connect, provision },
    );
    expect(result.status).toBe("unmanaged (primary)");
    expect(connect).not.toHaveBeenCalled();
    expect(provision).not.toHaveBeenCalled();
  });

  it("reports ok for an existing, healthy managed database without provisioning", async () => {
    const provision = vi.fn();
    const result = await setupPipeline(entry(), {
      connect: fakeConnect([allTablesRow, [{ count: 7 }]]),
      provision,
    });
    expect(result).toMatchObject({ entries: 7, status: "ok" });
    expect(provision).not.toHaveBeenCalled();
  });

  it("reports broken with the missing tables for an existing managed database", async () => {
    const provision = vi.fn();
    const result = await setupPipeline(entry(), {
      connect: fakeConnect([
        [
          {
            experiment_runs: true,
            news_entries: true,
            rank_snapshots: false,
            rpc: true,
          },
        ],
        [{ count: 3 }],
      ]),
      provision,
    });
    expect(result.status).toBe("broken: missing rank_snapshots");
    expect(provision).not.toHaveBeenCalled();
  });

  it("provisions a missing managed database and reports created on success", async () => {
    const provision = vi.fn(async () => undefined);
    const result = await setupPipeline(entry(), {
      connect: fakeConnect([notExist, allTablesRow, [{ count: 10 }]]),
      provision,
    });
    expect(provision).toHaveBeenCalledWith("complex");
    expect(provision).toHaveBeenCalledTimes(1);
    expect(result).toMatchObject({ entries: 10, status: "created" });
  });

  it("reports broken when the database is still missing after provisioning", async () => {
    const provision = vi.fn(async () => undefined);
    const result = await setupPipeline(entry(), {
      connect: fakeConnect([notExist, notExist]),
      provision,
    });
    expect(result.status).toContain("provisioning script did not create");
  });

  it("never provisions a custom (non <name>_db) database, even when missing", async () => {
    const provision = vi.fn();
    const custom = entry({
      databaseUrl: "postgresql://postgres:postgres@127.0.0.1:57422/complex_custom",
    });
    const result = await setupPipeline(custom, {
      connect: fakeConnect([notExist]),
      provision,
    });
    expect(result.status).toContain("custom database (not managed)");
    expect(result.status).toContain("missing");
    expect(provision).not.toHaveBeenCalled();
  });

  it("verifies but never provisions an existing custom database", async () => {
    const provision = vi.fn();
    const custom = entry({
      databaseUrl: "postgresql://postgres:postgres@127.0.0.1:57422/complex_custom",
    });
    const result = await setupPipeline(custom, {
      connect: fakeConnect([allTablesRow, [{ count: 5 }]]),
      provision,
    });
    expect(result.status).toBe("custom database (not managed) — ok");
    expect(result.entries).toBe(5);
    expect(provision).not.toHaveBeenCalled();
  });
});
