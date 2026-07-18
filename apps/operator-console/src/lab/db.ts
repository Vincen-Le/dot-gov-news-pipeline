import postgres from "postgres";

import type { LabCapability } from "./contracts";

export interface LabDb {
  read: postgres.Sql;
  close(): Promise<void>;
}

export type { LabCapability };

export function createLabDb(databaseUrl: string): LabDb {
  const read = postgres(databaseUrl, {
    connection: { default_transaction_read_only: "on" },
    max: 4,
    prepare: false,
  } as unknown as Parameters<typeof postgres>[1]);
  return {
    async close() {
      await read.end({ timeout: 5 });
    },
    read,
  };
}

/** Same rule as pipeline/bench.py::assert_local_dsn — experiments only ever
 * target the local bench database. */
export function isLocalDsn(dsn: string): boolean {
  try {
    const host = new URL(dsn).hostname;
    return host === "" || host === "127.0.0.1" || host === "localhost";
  } catch {
    return false;
  }
}

export async function labCapability(
  db: LabDb | null,
  databaseUrl?: string,
): Promise<LabCapability> {
  if (db === null) {
    return {
      experimentsEnabled: false,
      reason:
        "Set DATABASE_URL in the root .env (local default postgresql://postgres:postgres@127.0.0.1:54322/postgres) to enable the clustering lab.",
      status: "not_enabled",
    };
  }
  try {
    const rows = await db.read`
      select to_regclass('public.storylines') is not null as clustering,
             to_regclass('public.experiment_runs') is not null as runs
    `;
    if (rows[0]?.clustering !== true) {
      return {
        experimentsEnabled: false,
        reason:
          "Clustering migrations are not applied to this database. Run pnpm supabase db reset (local) or supabase db push.",
        status: "not_enabled",
      };
    }
    if (rows[0]?.runs !== true) {
      return {
        experimentsEnabled: false,
        experimentsReason:
          "The experiment_runs migration (20260718100200) is not applied.",
        status: "available",
      };
    }
    if (databaseUrl === undefined || !isLocalDsn(databaseUrl)) {
      return {
        experimentsEnabled: false,
        experimentsReason:
          "Experiments only run against a local database — the pipeline bench tools structurally refuse remote DSNs.",
        status: "available",
      };
    }
    return { experimentsEnabled: true, status: "available" };
  } catch (error) {
    return {
      experimentsEnabled: false,
      reason: error instanceof Error ? error.message : "Database unreachable",
      status: "not_enabled",
    };
  }
}
