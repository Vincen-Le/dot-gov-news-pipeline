import { config as loadDotEnv } from "dotenv";
import { spawn } from "node:child_process";
import { resolve } from "node:path";

import postgres from "postgres";

import { repositoryRoot } from "../config";
import {
  defaultDoctorDeps,
  LOCAL_DSN,
  runDoctor,
  type CheckResult,
} from "./checks";
import { defaultEnvInitDeps, envInit } from "./env-init";

export interface OnboardDeps {
  doctorTooling: () => Promise<CheckResult[]>;
  envReady: () => Promise<boolean>;
  envInit: () => Promise<void>;
  dbUp: () => Promise<boolean>;
  corpusCount: () => Promise<number>;
  embeddedCount: () => Promise<number>;
  run: (command: string, args: string[]) => Promise<void>;
  log: (message: string) => void;
}

export async function onboard(
  deps: OnboardDeps,
  opts: { dryRun?: boolean; fresh?: boolean },
): Promise<void> {
  const act = async (label: string, fn: () => Promise<void>) => {
    if (opts.dryRun) {
      deps.log(`[dry-run] would ${label}`);
      return;
    }
    deps.log(`→ ${label}`);
    await fn();
  };

  const tooling = await deps.doctorTooling();
  const broken = tooling.filter((r) => !r.ok);
  if (broken.length > 0) {
    const details = broken
      .map((r) => `${r.name}: ${r.detail}${r.fix ? ` — ${r.fix}` : ""}`)
      .join("\n");
    throw new Error(`Toolchain not ready:\n${details}`);
  }
  deps.log(`✓ toolchain ok (${String(tooling.length)} checks)`);

  if (!(await deps.envReady())) {
    await act("collect credentials (ops env init)", () => deps.envInit());
  } else {
    deps.log("✓ credentials present");
  }

  const dbWasUp = await deps.dbUp();
  if (!dbWasUp) {
    await act("start local supabase", () =>
      deps.run("pnpm", ["supabase", "start"]),
    );
  } else {
    deps.log("✓ local database running");
  }

  const corpus =
    opts.dryRun && !dbWasUp ? 0 : await deps.corpusCount();
  if (opts.fresh || corpus === 0) {
    await act("apply migrations (supabase db reset)", () =>
      deps.run("pnpm", ["supabase", "db", "reset"]),
    );
  } else {
    deps.log(`✓ schema present (${String(corpus)} corpus entries)`);
  }

  await act("install python environment (uv sync)", () =>
    deps.run("uv", ["sync"]),
  );
  await act("sync hosted corpus", () =>
    deps.run("uv", ["run", "python", "-m", "pipeline.cli", "sync"]),
  );

  const embedded =
    opts.dryRun && !dbWasUp ? 0 : await deps.embeddedCount();
  if (embedded === 0) {
    await act("embed a 25-entry sample with your Cloudflare models", () =>
      deps.run("uv", [
        "run",
        "python",
        "-m",
        "pipeline.cli",
        "prepare",
        "--limit",
        "25",
      ]),
    );
  } else {
    deps.log(`✓ embeddings present (${String(embedded)} entries)`);
  }

  await act("run smoke experiment", () =>
    deps.run("uv", [
      "run",
      "python",
      "-m",
      "pipeline.cli",
      "experiment",
      "onboarding-smoke",
      "--limit",
      "25",
    ]),
  );

  deps.log("");
  deps.log("Done. Next steps:");
  deps.log(
    "  pnpm ops doctor                                   # re-verify anytime",
  );
  deps.log(
    "  uv run python -m pipeline.cli prepare --limit 500 # embed more corpus",
  );
  deps.log(
    "  docs/operations/cli-cheatsheet.md                 # everyday commands",
  );
}

export function defaultOnboardDeps(): OnboardDeps {
  loadDotEnv({ path: resolve(repositoryRoot, ".env"), quiet: true });
  const doctor = defaultDoctorDeps();
  const childEnv = {
    ...process.env,
    DATABASE_URL: process.env.DATABASE_URL ?? LOCAL_DSN,
  };
  const count = async (where: string): Promise<number> => {
    const sql = postgres(childEnv.DATABASE_URL, { max: 1, connect_timeout: 5 });
    try {
      const rows = await sql.unsafe(
        `select count(*)::int as n from public.news_entries ${where}`,
      );
      return (rows[0] as unknown as { n: number }).n;
    } finally {
      await sql.end({ timeout: 1 });
    }
  };
  return {
    doctorTooling: () => runDoctor(doctor, { toolingOnly: true }),
    envReady: async () =>
      Boolean(
        process.env.CLOUDFLARE_ACCOUNT_ID && process.env.CLOUDFLARE_API_TOKEN,
      ),
    envInit: async () => {
      const { close, deps } = defaultEnvInitDeps();
      try {
        await envInit(deps);
      } finally {
        close();
      }
    },
    dbUp: async () => (await doctor.probeSql(LOCAL_DSN)) === null,
    corpusCount: () => count(""),
    embeddedCount: () => count("where embedding is not null"),
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
    log: (message) => console.log(message),
  };
}
