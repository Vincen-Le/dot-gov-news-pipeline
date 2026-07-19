import { describe, expect, it } from "vitest";

import { isLocalDsn, labCapability, type LabDb } from "../src/lab/db";

const LOCAL = "postgresql://postgres:postgres@127.0.0.1:54322/postgres";
const REMOTE =
  "postgresql://u:p@aws-1-us-east-2.pooler.supabase.com:5432/postgres";

function fakeDb(
  handler: () => Promise<{ clustering: boolean; runs: boolean }[]>,
): LabDb {
  return {
    close: async () => undefined,
    read: handler as unknown as LabDb["read"],
  };
}

describe("isLocalDsn", () => {
  it("accepts loopback hosts only", () => {
    expect(isLocalDsn(LOCAL)).toBe(true);
    expect(isLocalDsn("postgresql://postgres@localhost/postgres")).toBe(true);
    expect(isLocalDsn(REMOTE)).toBe(false);
    expect(isLocalDsn("not a dsn")).toBe(false);
  });
});

describe("labCapability", () => {
  it("reports not_enabled without a DATABASE_URL", async () => {
    const capability = await labCapability(null);
    expect(capability.status).toBe("not_enabled");
    expect(capability.experimentsEnabled).toBe(false);
    expect(capability.reason).toContain("DATABASE_URL");
  });

  it("reports not_enabled when clustering tables are missing", async () => {
    const capability = await labCapability(
      fakeDb(async () => [{ clustering: false, runs: false }]),
      LOCAL,
    );
    expect(capability.status).toBe("not_enabled");
    expect(capability.reason).toContain("migrations");
  });

  it("enables experiments only on a local DSN with complex_v1_experiment_runs", async () => {
    const full = await labCapability(
      fakeDb(async () => [{ clustering: true, runs: true }]),
      LOCAL,
    );
    expect(full).toEqual({ experimentsEnabled: true, status: "available" });

    const remote = await labCapability(
      fakeDb(async () => [{ clustering: true, runs: true }]),
      REMOTE,
    );
    expect(remote.status).toBe("available");
    expect(remote.experimentsEnabled).toBe(false);
    expect(remote.experimentsReason).toContain("local");

    const noRuns = await labCapability(
      fakeDb(async () => [{ clustering: true, runs: false }]),
      LOCAL,
    );
    expect(noRuns.experimentsEnabled).toBe(false);
    expect(noRuns.experimentsReason).toContain("complex_v1_experiment_runs");
  });

  it("surfaces connection failures as the reason", async () => {
    const capability = await labCapability(
      fakeDb(async () => {
        throw new Error("connection refused");
      }),
      LOCAL,
    );
    expect(capability.status).toBe("not_enabled");
    expect(capability.reason).toContain("connection refused");
  });
});
