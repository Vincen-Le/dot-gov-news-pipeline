import { spawn } from "node:child_process";

import type { PipelineEntry } from "../config";
import { dbNameFromDsn, isLocalDsn, type LabDb } from "./db";
import { namespaceForEngine, namespaceTables } from "./namespace";

/** Tables every pipeline database must have, beyond the
 * create_episode_with_storyline RPC checked separately below. These keys
 * are stable, engine-independent labels — the real table name each one
 * resolves to for a given pipeline comes from requiredTableNames below. */
const REQUIRED_TABLES = ["news_entries", "experiment_runs", "rank_snapshots"] as const;
const REQUIRED_RPC = "create_episode_with_storyline";

type RequiredTableNames = Record<(typeof REQUIRED_TABLES)[number], string>;

/** Resolves each REQUIRED_TABLES label to the real table name for this
 * pipeline's namespace (apps/operator-console/src/lab/namespace.ts):
 * experiment_runs and rank_snapshots are namespaced per pipeline
 * (rank_snapshots stays bare for complex_v1 — it predates namespacing). */
function requiredTableNamesFor(engine?: string): RequiredTableNames {
  const { experimentRuns, rankSnapshots } = namespaceTables(namespaceForEngine(engine));
  return {
    experiment_runs: experimentRuns,
    news_entries: "news_entries",
    rank_snapshots: rankSnapshots,
  };
}

const DEFAULT_TABLE_NAMES: RequiredTableNames = requiredTableNamesFor();

export interface PipelineSetupResult {
  database: string;
  engine: string;
  entries: number | null;
  name: string;
  status: string;
}

export interface PipelineSetupDeps {
  /** Opens a read connection; setupPipeline always closes it. */
  connect: (databaseUrl: string) => LabDb;
  /** Runs scripts/create-pipeline-db.sh <name>, resolving once it exits 0. */
  provision: (name: string) => Promise<void>;
}

/** dbname parsed from a postgres:// URL's path, e.g. "complex_db". Empty
 * string if the DSN cannot be parsed as a URL. */
export function pipelineDbName(entry: PipelineEntry): string {
  return dbNameFromDsn(entry.databaseUrl);
}

/** A pipeline is "managed" when its databaseUrl dbname follows the
 * `<name>_db` convention scripts/create-pipeline-db.sh assumes — only
 * managed pipelines are ever auto-provisioned. */
export function isManagedPipeline(entry: PipelineEntry): boolean {
  return pipelineDbName(entry) === `${entry.name}_db`;
}

/** Refuses to operate at all: non-local DSNs, and the `postgres` primary
 * database (which may hold unrelated production data and must never be
 * provisioned or dropped by this tool). Returns null when setup may proceed. */
export function pipelineSkipReason(entry: PipelineEntry): string | null {
  if (!isLocalDsn(entry.databaseUrl)) {
    return "unmanaged (refusing non-local databaseUrl)";
  }
  if (pipelineDbName(entry) === "postgres") {
    return "unmanaged (primary)";
  }
  return null;
}

export interface DatabaseProbe {
  entries: number;
  missing: string[];
  status: "missing" | "verified";
}

/** Connects to a pipeline database and classifies it: "missing" (database
 * does not exist yet — postgres error code 3D000) or "verified" (connected;
 * `missing` lists any of the required tables/RPC not found). Always closes
 * the connection it opens. */
export async function probePipelineDatabase(
  connect: () => LabDb,
  tableNames: RequiredTableNames = DEFAULT_TABLE_NAMES,
): Promise<DatabaseProbe> {
  const db = connect();
  try {
    const rows = await db.read`
      select
        to_regclass(${`public.${tableNames.news_entries}`}) is not null as news_entries,
        to_regclass(${`public.${tableNames.experiment_runs}`}) is not null as experiment_runs,
        to_regclass(${`public.${tableNames.rank_snapshots}`}) is not null as rank_snapshots,
        exists (
          select 1 from pg_proc p
          join pg_namespace n on n.oid = p.pronamespace
          where n.nspname = 'public' and p.proname = ${REQUIRED_RPC}
        ) as rpc
    `;
    const row = rows[0] as
      | {
          experiment_runs: boolean;
          news_entries: boolean;
          rank_snapshots: boolean;
          rpc: boolean;
        }
      | undefined;
    const missing: string[] = [];
    for (const table of REQUIRED_TABLES) {
      if (row?.[table as keyof typeof row] !== true) missing.push(table);
    }
    if (row?.rpc !== true) missing.push(`${REQUIRED_RPC} (RPC)`);

    let entries = 0;
    if (row?.news_entries === true) {
      const countRows = await db.read`select count(*)::int as count from public.news_entries`;
      entries = (countRows[0] as { count: number } | undefined)?.count ?? 0;
    }
    return { entries, missing, status: "verified" };
  } catch (error) {
    if ((error as { code?: string }).code === "3D000") {
      return { entries: 0, missing: [], status: "missing" };
    }
    throw error;
  } finally {
    await db.close();
  }
}

function brokenStatus(missing: string[]): string {
  return `broken: missing ${missing.join(", ")}`;
}

/** Provisions (if missing) or verifies (if present) one registry pipeline's
 * database, never dropping or re-provisioning an existing one. Custom
 * (non-`<name>_db`) database names and the primary `postgres` database are
 * only ever read, never created. */
export async function setupPipeline(
  entry: PipelineEntry,
  deps: PipelineSetupDeps,
): Promise<PipelineSetupResult> {
  const base = { database: entry.databaseUrl, engine: entry.engine, name: entry.name };

  const skipReason = pipelineSkipReason(entry);
  if (skipReason !== null) {
    return { ...base, entries: null, status: skipReason };
  }

  const managed = isManagedPipeline(entry);
  const connect = () => deps.connect(entry.databaseUrl);
  const tableNames = requiredTableNamesFor(entry.engine);

  if (!managed) {
    // Custom database name: verify only, never create.
    const probe = await probePipelineDatabase(connect, tableNames);
    if (probe.status === "missing") {
      return {
        ...base,
        entries: null,
        status: "custom database (not managed) — missing; will not auto-create a non-standard database name",
      };
    }
    return {
      ...base,
      entries: probe.entries,
      status: `custom database (not managed) — ${probe.missing.length === 0 ? "ok" : brokenStatus(probe.missing)}`,
    };
  }

  let probe = await probePipelineDatabase(connect, tableNames);
  if (probe.status === "missing") {
    await deps.provision(entry.name);
    probe = await probePipelineDatabase(connect, tableNames);
    if (probe.status === "missing") {
      return {
        ...base,
        entries: null,
        status: "broken: provisioning script did not create the database",
      };
    }
    if (probe.missing.length > 0) {
      return { ...base, entries: probe.entries, status: brokenStatus(probe.missing) };
    }
    return { ...base, entries: probe.entries, status: "created" };
  }

  if (probe.missing.length > 0) {
    return { ...base, entries: probe.entries, status: brokenStatus(probe.missing) };
  }
  return { ...base, entries: probe.entries, status: "ok" };
}

/** Real provisioner: spawns scripts/create-pipeline-db.sh <name> from the
 * repository root, streaming its output, resolving once it exits 0. */
export function defaultProvisioner(
  repositoryRoot: string,
): (name: string) => Promise<void> {
  return (name: string) =>
    new Promise((resolveRun, rejectRun) => {
      const child = spawn("./scripts/create-pipeline-db.sh", [name], {
        cwd: repositoryRoot,
        stdio: ["ignore", "pipe", "pipe"],
      });
      let output = "";
      child.stdout.setEncoding("utf8");
      child.stderr.setEncoding("utf8");
      child.stdout.on("data", (chunk: string) => {
        output += chunk;
        process.stdout.write(chunk);
      });
      child.stderr.on("data", (chunk: string) => {
        output += chunk;
        process.stderr.write(chunk);
      });
      child.once("error", rejectRun);
      child.once("close", (code) => {
        if (code === 0) {
          resolveRun();
        } else {
          rejectRun(
            new Error(
              `create-pipeline-db.sh ${name} exited with code ${String(code)}\n${output}`,
            ),
          );
        }
      });
    });
}
