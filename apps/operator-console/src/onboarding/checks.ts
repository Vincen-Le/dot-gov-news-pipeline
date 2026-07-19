import { config as loadDotEnv } from "dotenv";
import { spawn } from "node:child_process";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import postgres from "postgres";

import {
  repositoryRoot,
  loadPipelineRegistry,
  type PipelineEntry,
  type PipelineRegistry,
} from "../config";
import { createLabDb } from "../lab/db";
import { namespaceForEngine, namespaceTables } from "../lab/namespace";
import { pipelineDbName, probePipelineDatabase } from "../lab/setup";

export const LOCAL_DSN =
  "postgresql://postgres:postgres@127.0.0.1:57422/postgres";

export interface CheckResult {
  name: string;
  ok: boolean;
  detail: string;
  fix?: string;
}

export interface HostedConfig {
  supabaseUrl: string;
  publishableKey: string;
}

export interface DoctorDeps {
  execVersion: (cmd: string, args: string[]) => Promise<string | null>;
  fetchImpl: typeof fetch;
  /** Returns null when `select 1` succeeds, else a short error detail. */
  probeSql: (dsn: string) => Promise<string | null>;
  env: Record<string, string | undefined>;
  hosted: HostedConfig;
  registry: () => PipelineRegistry | null;
  /** null = ready, string = problem detail */
  probePipeline: (entry: PipelineEntry) => Promise<string | null>;
}

const PLACEHOLDER_PREFIX = "REPLACE_";

export function loadHostedConfig(): HostedConfig {
  return JSON.parse(
    readFileSync(resolve(repositoryRoot, "config/hosted.json"), "utf8"),
  ) as HostedConfig;
}

export async function validateCloudflare(
  deps: Pick<DoctorDeps, "fetchImpl">,
  accountId: string,
  token: string,
): Promise<string | null> {
  try {
    const response = await deps.fetchImpl(
      `https://api.cloudflare.com/client/v4/accounts/${accountId}/ai/run/@cf/baai/bge-m3`,
      {
        method: "POST",
        headers: {
          Authorization: `Bearer ${token}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ text: ["doctor probe"] }),
      },
    );
    if (!response.ok) {
      return `Workers AI probe returned HTTP ${String(response.status)}`;
    }
    const body = (await response.json()) as { success?: boolean };
    return body.success ? null : "Workers AI probe returned success=false";
  } catch (error) {
    return `Workers AI probe failed: ${String(error)}`;
  }
}

async function toolChecks(deps: DoctorDeps): Promise<CheckResult[]> {
  const tools: Array<{
    name: string;
    cmd: string;
    args: string[];
    fix: string;
    validate?: (version: string) => string | null;
  }> = [
    {
      name: "mise",
      cmd: "mise",
      args: ["--version"],
      fix: "Install mise: https://mise.jdx.dev/getting-started.html",
    },
    {
      name: "node",
      cmd: "node",
      args: ["--version"],
      fix: "Run: mise install",
      validate: (v) =>
        v.startsWith("v24") ? null : `need node 24, found ${v}`,
    },
    {
      name: "pnpm",
      cmd: "pnpm",
      args: ["--version"],
      fix: "Run: mise install",
    },
    { name: "uv", cmd: "uv", args: ["--version"], fix: "Run: mise install" },
    {
      name: "docker",
      cmd: "docker",
      args: ["info", "--format", "{{.ServerVersion}}"],
      fix: "Install and start Docker Desktop: https://docs.docker.com/desktop/",
    },
    {
      name: "supabase",
      cmd: "pnpm",
      args: ["supabase", "--version"],
      fix: "Run: pnpm install",
    },
  ];
  return Promise.all(
    tools.map(async (tool) => {
      const version = await deps.execVersion(tool.cmd, tool.args);
      if (version === null) {
        return {
          name: tool.name,
          ok: false,
          detail: "not found or not running",
          fix: tool.fix,
        };
      }
      const invalid = tool.validate?.(version.trim()) ?? null;
      return invalid === null
        ? { name: tool.name, ok: true, detail: version.trim() }
        : { name: tool.name, ok: false, detail: invalid, fix: tool.fix };
    }),
  );
}

async function credentialChecks(deps: DoctorDeps): Promise<CheckResult[]> {
  const results: CheckResult[] = [];

  const localError = await deps.probeSql(LOCAL_DSN);
  results.push(
    localError === null
      ? { name: "local database", ok: true, detail: "reachable on 57422" }
      : {
          name: "local database",
          ok: false,
          detail: localError,
          fix: "Run: pnpm supabase start",
        },
  );

  const registry = deps.registry();
  if (registry !== null) {
    for (const entry of registry.pipelines) {
      const problem = await deps.probePipeline(entry);
      results.push(
        problem === null
          ? {
              name: `pipeline ${entry.name}`,
              ok: true,
              detail: `${pipelineDbName(entry) || "postgres"} ready`,
            }
          : {
              name: `pipeline ${entry.name}`,
              ok: false,
              detail: problem,
              fix: "Run: pnpm ops setup",
            },
      );
    }
  }

  const accountId = deps.env.CLOUDFLARE_ACCOUNT_ID;
  const token = deps.env.CLOUDFLARE_API_TOKEN;
  if (!accountId || !token) {
    results.push({
      name: "cloudflare token",
      ok: false,
      detail: "CLOUDFLARE_ACCOUNT_ID / CLOUDFLARE_API_TOKEN not set",
      fix: "Run: pnpm ops env init",
    });
  } else {
    const cfError = await validateCloudflare(deps, accountId, token);
    results.push(
      cfError === null
        ? { name: "cloudflare token", ok: true, detail: "Workers AI reachable" }
        : {
            name: "cloudflare token",
            ok: false,
            detail: cfError,
            fix: "Run: pnpm ops env init",
          },
    );
  }

  if (deps.hosted.publishableKey.startsWith(PLACEHOLDER_PREFIX)) {
    results.push({
      name: "hosted corpus read",
      ok: false,
      detail: "publishable key placeholder in config/hosted.json",
      fix: "Fill config/hosted.json (docs/infrastructure/access.md#hosted-rollout)",
    });
  } else {
    try {
      const response = await deps.fetchImpl(
        `${deps.hosted.supabaseUrl}/rest/v1/news_sources?select=id&limit=1`,
        {
          headers: {
            apikey: deps.hosted.publishableKey,
            Authorization: `Bearer ${deps.hosted.publishableKey}`,
          },
        },
      );
      results.push(
        response.ok
          ? { name: "hosted corpus read", ok: true, detail: "REST probe ok" }
          : {
              name: "hosted corpus read",
              ok: false,
              detail: `REST probe returned HTTP ${String(response.status)}`,
              fix: "Check config/hosted.json and hosted RLS grants",
            },
      );
    } catch (error) {
      results.push({
        name: "hosted corpus read",
        ok: false,
        detail: `REST probe failed: ${String(error)}`,
        fix: "Check network access to Supabase",
      });
    }
  }

  const hostedDsn = deps.env.HOSTED_READONLY_DATABASE_URL;
  if (!hostedDsn) {
    results.push({
      name: "hosted direct read",
      ok: true,
      detail: "not configured (optional)",
    });
  } else {
    const dsnError = await deps.probeSql(hostedDsn);
    results.push(
      dsnError === null
        ? { name: "hosted direct read", ok: true, detail: "select 1 ok" }
        : {
            name: "hosted direct read",
            ok: false,
            detail: dsnError,
            fix: "Ask the repo owner for a fresh corpus_reader DSN",
          },
    );
  }

  results.push(
    deps.env.OPS_API_URL
      ? {
          name: "remote API",
          ok: true,
          detail: `configured (${deps.env.OPS_API_URL})`,
        }
      : {
          name: "remote API",
          ok: true,
          detail:
            "not deployed (optional) — pnpm ops deploy enables remote commands",
        },
  );

  return results;
}

export async function runDoctor(
  deps: DoctorDeps,
  opts: { toolingOnly?: boolean } = {},
): Promise<CheckResult[]> {
  const tooling = await toolChecks(deps);
  if (opts.toolingOnly) return tooling;
  return [...tooling, ...(await credentialChecks(deps))];
}

export function defaultDoctorDeps(): DoctorDeps {
  loadDotEnv({ path: resolve(repositoryRoot, ".env"), quiet: true });
  return {
    execVersion: (cmd, args) =>
      new Promise((resolveVersion) => {
        const child = spawn(cmd, args, { stdio: ["ignore", "pipe", "ignore"] });
        let output = "";
        child.stdout.setEncoding("utf8");
        child.stdout.on("data", (chunk: string) => (output += chunk));
        child.once("error", () => resolveVersion(null));
        child.once("close", (code) =>
          resolveVersion(code === 0 ? output : null),
        );
      }),
    fetchImpl: fetch,
    probeSql: async (dsn) => {
      const sql = postgres(dsn, {
        max: 1,
        connect_timeout: 5,
        onnotice: () => undefined,
      });
      try {
        await sql`select 1`;
        return null;
      } catch (error) {
        return String(error);
      } finally {
        await sql.end({ timeout: 1 });
      }
    },
    env: process.env,
    hosted: loadHostedConfig(),
    registry: () => loadPipelineRegistry(),
    probePipeline: async (entry) => {
      const { experimentRuns, rankSnapshots } = namespaceTables(
        namespaceForEngine(entry.engine),
      );
      const probe = await probePipelineDatabase(
        () => createLabDb(entry.databaseUrl),
        {
          experiment_runs: experimentRuns,
          news_entries: "news_entries",
          rank_snapshots: rankSnapshots,
        },
      );
      if (probe.status === "missing") {
        return `database ${pipelineDbName(entry) || entry.databaseUrl} does not exist`;
      }
      return probe.missing.length === 0
        ? null
        : `missing ${probe.missing.join(", ")}`;
    },
  };
}
