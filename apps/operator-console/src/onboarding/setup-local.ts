import { config as loadDotEnv } from "dotenv";
import { spawn } from "node:child_process";
import { resolve } from "node:path";
import { createInterface } from "node:readline/promises";
import { stdin, stdout } from "node:process";

import {
  loadPipelineRegistry,
  LOCAL_DATABASE_URL,
  repositoryRoot,
  type PipelineEntry,
  type PipelineRegistry,
} from "../config";
import { createLabDb } from "../lab/db";
import {
  defaultProvisioner,
  setupPipeline,
  type PipelineSetupResult,
} from "../lab/setup";
import { defaultDoctorDeps } from "./checks";

export interface SetupLocalOpts {
  dryRun?: boolean;
  fresh?: boolean;
  yes?: boolean;
}

export interface SetupLocalReport {
  ok: boolean;
  pipelines: PipelineSetupResult[];
  steps: string[];
}

export interface SetupLocalDeps {
  dbUp(): Promise<boolean>;
  run(command: string, args: string[]): Promise<void>;
  confirm(question: string): Promise<boolean>;
  registry(): PipelineRegistry | null;
  setupPipeline(entry: PipelineEntry): Promise<PipelineSetupResult>;
  log(message: string): void;
}

export async function setupLocal(
  deps: SetupLocalDeps,
  opts: SetupLocalOpts,
): Promise<SetupLocalReport> {
  const steps: string[] = [];
  const act = async (label: string, fn: () => Promise<void>) => {
    steps.push(label);
    if (opts.dryRun) {
      deps.log(`[dry-run] would ${label}`);
      return;
    }
    deps.log(`→ ${label}`);
    await fn();
  };

  if (!(opts.dryRun ? false : await deps.dbUp())) {
    await act("start local supabase", () =>
      deps.run("pnpm", ["supabase", "start"]),
    );
  } else {
    deps.log("✓ local database running");
  }

  if (opts.fresh) {
    if (!opts.yes && !opts.dryRun) {
      const confirmed = await deps.confirm(
        "--fresh wipes the local corpus and every derived table. Type yes to continue: ",
      );
      if (!confirmed) {
        throw new Error(
          "fresh reset not confirmed — aborting before any change",
        );
      }
    }
    await act("rebuild database (supabase db reset)", () =>
      deps.run("pnpm", ["supabase", "db", "reset"]),
    );
  } else {
    await act("apply pending migrations (supabase migration up)", () =>
      deps.run("pnpm", ["supabase", "migration", "up", "--local"]),
    );
  }

  await act("install python environment (uv sync)", () =>
    deps.run("uv", ["sync"]),
  );
  await act("sync hosted corpus into the primary database", () =>
    deps.run("uv", ["run", "python", "-m", "pipeline.cli", "sync"]),
  );

  const registry = deps.registry();
  const pipelines: PipelineSetupResult[] = [];
  if (registry === null) {
    deps.log("no config/pipelines.json registry — single-pipeline mode");
  } else {
    for (const entry of registry.pipelines) {
      steps.push(`verify pipeline ${entry.name}`);
      if (opts.dryRun) {
        deps.log(`[dry-run] would verify pipeline ${entry.name}`);
        continue;
      }
      deps.log(`→ verify pipeline ${entry.name} (${entry.engine})`);
      pipelines.push(await deps.setupPipeline(entry));
    }
  }

  const ok = pipelines.every((p) => !p.status.startsWith("broken"));
  return { ok, pipelines, steps };
}

export function defaultSetupLocalDeps(): SetupLocalDeps {
  loadDotEnv({ path: resolve(repositoryRoot, ".env"), quiet: true });
  const doctor = defaultDoctorDeps();
  const childEnv = {
    ...process.env,
    DATABASE_URL: process.env.DATABASE_URL ?? LOCAL_DATABASE_URL,
  };
  return {
    confirm: async (question) => {
      const readline = createInterface({ input: stdin, output: stdout });
      try {
        const answer = await readline.question(question);
        return answer.trim().toLowerCase() === "yes";
      } finally {
        readline.close();
      }
    },
    dbUp: async () => (await doctor.probeSql(LOCAL_DATABASE_URL)) === null,
    log: (message) => console.log(message),
    registry: () => loadPipelineRegistry(),
    run: (command, args) =>
      new Promise((resolveRun, rejectRun) => {
        const child = spawn(command, args, {
          cwd: repositoryRoot,
          env: childEnv,
          stdio: "inherit",
        });
        child.once("error", rejectRun);
        child.once("close", (code) => {
          if (code === 0) resolveRun();
          else
            rejectRun(
              new Error(
                `${command} ${args.join(" ")} exited with code ${String(code)}`,
              ),
            );
        });
      }),
    setupPipeline: (entry) =>
      setupPipeline(entry, {
        connect: createLabDb,
        provision: defaultProvisioner(repositoryRoot),
      }),
  };
}
