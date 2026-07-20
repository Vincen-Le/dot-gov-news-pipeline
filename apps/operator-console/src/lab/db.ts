import postgres from "postgres";

import type { LabCapability } from "./contracts";
import { namespaceForEngine, namespaceTables } from "./namespace";

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

/** dbname parsed from a postgres:// URL's path, e.g. "complex_db". Empty
 * string if the DSN cannot be parsed as a URL. */
export function dbNameFromDsn(dsn: string): string {
  try {
    return new URL(dsn).pathname.replace(/^\//u, "");
  } catch {
    return "";
  }
}

export async function labCapability(
  db: LabDb | null,
  databaseUrl?: string,
  engine?: string,
  /** True only for registry-mounted pipeline connections whose harness is
   * withheld from the primary database (see buildLabConnection in
   * server.ts) — surfaces *why* runs are disabled instead of leaving the
   * dashboard's run button mysteriously absent. */
  primaryReadOnly = false,
): Promise<LabCapability> {
  if (db === null) {
    return {
      experimentsEnabled: false,
      reason:
        "Set DATABASE_URL in the root .env (local default postgresql://postgres:postgres@127.0.0.1:57422/postgres) to enable the clustering lab.",
      status: "not_enabled",
    };
  }
  const { experimentRuns, experimentClusterSnapshots } = namespaceTables(
    namespaceForEngine(engine),
  );
  try {
    const rows = await db.read`
      select to_regclass('public.storylines') is not null as clustering,
             to_regclass(${`public.${experimentRuns}`}) is not null as runs,
             to_regclass(${`public.${experimentClusterSnapshots}`})
               is not null as snapshots
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
        experimentsReason: `The ${experimentRuns} table is not present.`,
        status: "available",
      };
    }
    if (rows[0]?.snapshots === false) {
      return {
        experimentsEnabled: false,
        reason: `The ${experimentClusterSnapshots} migrations are not applied.`,
        status: "not_enabled",
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
    if (primaryReadOnly && dbNameFromDsn(databaseUrl) === "postgres") {
      return {
        experimentsEnabled: false,
        experimentsReason:
          "Runs disabled: primary database is read-only from the dashboard — this pipeline points at the live primary, and the experiment harness resets derived clustering state.",
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
