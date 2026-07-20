# Ops CLI UX Consolidation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** One idempotent `pnpm ops setup` that prepares every registry pipeline's database, an `onboard` that delegates to it, a registry-aware doctor, and a CLI regrouped by audience with the dead remote surface capability-gated.

**Architecture:** New `setup-local.ts` orchestrator module owns local preparation (stack → migrations → corpus sync → per-pipeline provisioning via the existing `setupPipeline`); `onboard` and the `ops setup` command both consume it. cli.ts regroups commands with commander 15 `helpGroup` headings, moves remote observability under a gated `remote` subcommand, and keeps old names as hidden exit-2 shims.

**Tech Stack:** TypeScript, commander 15 (`helpGroup`, `addCommand(cmd, {hidden})`), vitest, existing `lab/setup.ts` + `onboarding/*` modules.

**Spec:** `docs/archive/design-specs/2026-07-19-ops-cli-ux-consolidation-design.md`

## Global Constraints

- Never run `supabase db reset` except behind `--fresh` plus explicit confirmation (stdin "yes" or `--yes`). Normal path is `pnpm supabase migration up --local`.
- The primary `postgres` database is never provisioned, dropped, or reset by registry fan-out — `setupPipeline` already enforces this; do not bypass it.
- Exit codes follow the existing convention: generic failure 2, not-enabled/not-configured 3, auth 4 (see `runAction` in cli.ts).
- All new/moved cli.ts actions wrap in the existing `runAction` helper.
- Local DSN single source: `LOCAL_DATABASE_URL` from `src/config.ts` (`postgresql://postgres:postgres@127.0.0.1:57422/postgres`).
- Run console tests with `pnpm --filter @dot-gov-news/operator-console test`, typecheck with `... typecheck`. Suites must stay green under the pinned node 24 and host node 25 (test/setup.ts localStorage guard handles this — don't remove it).
- Prettier formats all touched files (`pnpm prettier --write <files>`).
- Commit messages end with `Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>`.

## File Structure

- `apps/operator-console/src/onboarding/setup-local.ts` — NEW: local-prep orchestrator (`setupLocal`, `defaultSetupLocalDeps`)
- `apps/operator-console/src/onboarding/setup-local.test.ts` — NEW
- `apps/operator-console/src/onboarding/onboard.ts` — MODIFY: delegate to setupLocal
- `apps/operator-console/src/onboarding/checks.ts` — MODIFY: pipeline + remote-API rows; LOCAL_DSN re-export
- `apps/operator-console/src/cli.ts` — MODIFY: setup/deploy commands, remote group, shims, help groups
- `apps/operator-console/src/config.ts` — MODIFY: `remoteConfigured()`
- `apps/operator-console/src/lab/db.ts` — MODIFY: stale-port message
- `apps/operator-console/src/recipes.ts`, `package.json` (root + console), docs — MODIFY

---

### Task 1: `setupLocal` orchestrator + `ops setup` command

**Files:**
- Create: `apps/operator-console/src/onboarding/setup-local.ts`
- Test: `apps/operator-console/src/onboarding/setup-local.test.ts`
- Modify: `apps/operator-console/src/cli.ts` (add `setup` command; convert `lab setup` to shim)

**Interfaces:**
- Consumes: `setupPipeline(entry, deps)`, `defaultProvisioner(root)`, `PipelineSetupResult` from `../lab/setup`; `loadPipelineRegistry(path?)`, `LOCAL_DATABASE_URL`, `repositoryRoot`, `PipelineEntry` from `../config`; `createLabDb` from `../lab/db`.
- Produces (Tasks 2 and 4 rely on these exact names):

```ts
export interface SetupLocalOpts {
  dryRun?: boolean;
  fresh?: boolean;
  yes?: boolean;
}
export interface SetupLocalReport {
  pipelines: PipelineSetupResult[]; // empty when no registry
  steps: string[];                  // labels of executed (or would-run) steps
  ok: boolean;
}
export interface SetupLocalDeps {
  dbUp(): Promise<boolean>;
  run(command: string, args: string[]): Promise<void>;
  confirm(question: string): Promise<boolean>; // fresh-reset gate
  registry(): PipelineRegistry | null;
  setupPipeline(entry: PipelineEntry): Promise<PipelineSetupResult>;
  log(message: string): void;
}
export async function setupLocal(deps: SetupLocalDeps, opts: SetupLocalOpts): Promise<SetupLocalReport>
export function defaultSetupLocalDeps(): SetupLocalDeps
```

- [ ] **Step 1: Write the failing tests**

Create `apps/operator-console/src/onboarding/setup-local.test.ts`:

```ts
import { describe, expect, it } from "vitest";

import type { PipelineEntry } from "../config";
import { setupLocal, type SetupLocalDeps } from "./setup-local";

const ENTRIES: PipelineEntry[] = [
  {
    databaseUrl: "postgresql://postgres:postgres@127.0.0.1:57422/postgres",
    engine: "classic",
    name: "complex_v1",
  },
  {
    databaseUrl: "postgresql://postgres:postgres@127.0.0.1:57422/simple_v1_db",
    engine: "spine",
    name: "simple_v1",
  },
];

function fakeDeps(overrides: Partial<SetupLocalDeps> = {}) {
  const commands: string[] = [];
  const provisioned: string[] = [];
  const deps: SetupLocalDeps = {
    confirm: async () => true,
    dbUp: async () => true,
    log: () => undefined,
    registry: () => ({ pipelines: ENTRIES }),
    run: async (command, args) => {
      commands.push([command, ...args].join(" "));
    },
    setupPipeline: async (entry) => {
      provisioned.push(entry.name);
      return {
        database: entry.name === "complex_v1" ? "postgres" : "simple_v1_db",
        engine: entry.engine,
        entries: 10,
        name: entry.name,
        status: "ready",
      };
    },
    ...overrides,
  };
  return { commands, deps, provisioned };
}

describe("setupLocal", () => {
  it("runs migrations, syncs, and fans out to every registry pipeline", async () => {
    const { commands, deps, provisioned } = fakeDeps();
    const report = await setupLocal(deps, {});
    const joined = commands.join("\n");
    expect(joined).toContain("pnpm supabase migration up --local");
    expect(joined).not.toContain("db reset");
    expect(joined).toContain("uv sync");
    expect(joined).toContain("pipeline.cli sync");
    expect(provisioned).toEqual(["complex_v1", "simple_v1"]);
    expect(report.ok).toBe(true);
    expect(report.pipelines).toHaveLength(2);
  });

  it("starts supabase only when the database is down", async () => {
    const up = fakeDeps();
    await setupLocal(up.deps, {});
    expect(up.commands.join("\n")).not.toContain("supabase start");

    const down = fakeDeps({ dbUp: async () => false });
    await setupLocal(down.deps, {});
    expect(down.commands.join("\n")).toContain("pnpm supabase start");
  });

  it("fresh requires confirmation and then resets instead of migrating", async () => {
    const refused = fakeDeps({ confirm: async () => false });
    await expect(setupLocal(refused.deps, { fresh: true })).rejects.toThrow(
      /confirm/i,
    );
    expect(refused.commands.join("\n")).not.toContain("db reset");

    const confirmed = fakeDeps();
    await setupLocal(confirmed.deps, { fresh: true });
    const joined = confirmed.commands.join("\n");
    expect(joined).toContain("pnpm supabase db reset");
    expect(joined).not.toContain("migration up");
  });

  it("--yes skips the confirmation prompt", async () => {
    let asked = false;
    const { deps, commands } = fakeDeps({
      confirm: async () => {
        asked = true;
        return true;
      },
    });
    await setupLocal(deps, { fresh: true, yes: true });
    expect(asked).toBe(false);
    expect(commands.join("\n")).toContain("db reset");
  });

  it("dry run executes nothing but reports the step plan", async () => {
    const { commands, deps, provisioned } = fakeDeps({
      dbUp: async () => false,
    });
    const report = await setupLocal(deps, { dryRun: true });
    expect(commands).toHaveLength(0);
    expect(provisioned).toHaveLength(0);
    expect(report.steps.length).toBeGreaterThan(0);
  });

  it("works without a registry and reports no pipelines", async () => {
    const { deps } = fakeDeps({ registry: () => null });
    const report = await setupLocal(deps, {});
    expect(report.pipelines).toEqual([]);
    expect(report.ok).toBe(true);
  });

  it("a broken pipeline does not block the others and flips ok to false", async () => {
    const { deps, provisioned } = fakeDeps({
      setupPipeline: async (entry) => ({
        database: "x",
        engine: entry.engine,
        entries: null,
        name: entry.name,
        status: entry.name === "complex_v1" ? "broken: missing tables" : "ready",
      }),
    });
    const report = await setupLocal(deps, {});
    expect(provisioned).toEqual(["complex_v1", "simple_v1"]);
    expect(report.ok).toBe(false);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `pnpm --filter @dot-gov-news/operator-console test src/onboarding/setup-local.test.ts`
Expected: FAIL — `./setup-local` not found.

- [ ] **Step 3: Implement setup-local.ts**

```ts
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
        throw new Error("fresh reset not confirmed — aborting before any change");
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
```

Note: Task 6 changes `LOCAL_DSN`/`LOCAL_DATABASE_URL` sourcing; this file already imports from `../config`, which is the final state. `defaultDoctorDeps` is used only for its `probeSql`.

- [ ] **Step 4: Run tests to verify they pass**

Run: `pnpm --filter @dot-gov-news/operator-console test src/onboarding/setup-local.test.ts`
Expected: 7 PASS

- [ ] **Step 5: Register `ops setup`; convert `lab setup` to shim**

In `apps/operator-console/src/cli.ts`, after the `onboard` command block add:

```ts
program
  .command("setup")
  .description(
    "Prepare local databases for every pipeline: stack, migrations, corpus, registry",
  )
  .option("--fresh", "wipe and rebuild the local database (asks for confirmation)")
  .option("--yes", "skip the --fresh confirmation prompt")
  .option("--dry-run", "print the step plan without changing anything")
  .option("--json", "print the pipeline report as JSON")
  .action(
    (options: JsonOption & { dryRun?: boolean; fresh?: boolean; yes?: boolean }) =>
      runAction(async () => {
        const report = await setupLocal(defaultSetupLocalDeps(), {
          dryRun: options.dryRun,
          fresh: options.fresh,
          yes: options.yes,
        });
        if (options.json) {
          printJson(report);
        } else if (report.pipelines.length > 0) {
          printRows(
            report.pipelines.map((result) => ({
              database: result.database,
              engine: result.engine,
              entries: result.entries ?? "—",
              name: result.name,
              status: result.status,
            })),
          );
        }
        if (!report.ok) process.exitCode = 1;
      }),
  );
```

Add the import (static, top of file, alphabetical):

```ts
import {
  defaultSetupLocalDeps,
  setupLocal,
} from "./onboarding/setup-local";
```

Replace the whole `lab setup` action body (keep registration) with a shim:

```ts
lab
  .command("setup")
  .description("(moved) use: pnpm ops setup")
  .action(() => {
    process.stderr.write("moved: pnpm ops setup\n");
    process.exitCode = 2;
  });
```

Remove now-unused imports that the old `lab setup` body held IF nothing else uses them (`setupPipeline`, `defaultProvisioner` are still used by nothing else in cli.ts — remove; `loadPipelineRegistry` is used by Task 3's doctor via checks.ts, not cli.ts — remove from cli.ts if unused).

- [ ] **Step 6: Typecheck + full console suite + smoke**

Run: `pnpm --filter @dot-gov-news/operator-console typecheck && pnpm --filter @dot-gov-news/operator-console test && pnpm ops setup --dry-run`
Expected: green; dry run prints `[dry-run] would …` lines including both pipelines, changes nothing. `pnpm ops lab setup` prints `moved: pnpm ops setup`, exit 2.

- [ ] **Step 7: Commit**

```bash
git add apps/operator-console/src/onboarding/setup-local.ts apps/operator-console/src/onboarding/setup-local.test.ts apps/operator-console/src/cli.ts
git commit -m "feat: add idempotent ops setup preparing every registry pipeline database"
```

---

### Task 2: `onboard` delegates to setupLocal

**Files:**
- Modify: `apps/operator-console/src/onboarding/onboard.ts`
- Test: `apps/operator-console/src/onboarding/onboard.test.ts`

**Interfaces:**
- Consumes: `setupLocal`, `defaultSetupLocalDeps`, `SetupLocalOpts`, `SetupLocalReport` from `./setup-local` (Task 1).
- Produces: `OnboardDeps` gains `setupLocal(opts: SetupLocalOpts): Promise<SetupLocalReport>` and DROPS `dbUp`, `corpusCount`. (`embeddedCount` and `run` stay — the embed proof and smoke experiment remain onboard's own steps.)

- [ ] **Step 1: Update the tests to the new contract**

Rewrite `onboard.test.ts`'s fake deps and assertions:

```ts
import { describe, expect, it } from "vitest";

import { onboard, type OnboardDeps } from "./onboard";

function fakeDeps(overrides: Partial<OnboardDeps> = {}) {
  const commands: string[] = [];
  const setupCalls: object[] = [];
  const deps: OnboardDeps = {
    doctorTooling: async () => [{ name: "mise", ok: true, detail: "2026.7.1" }],
    envReady: async () => true,
    envInit: async () => {
      commands.push("envInit");
    },
    setupLocal: async (opts) => {
      setupCalls.push(opts);
      commands.push("setupLocal");
      return { ok: true, pipelines: [], steps: [] };
    },
    embeddedCount: async () => 50,
    run: async (command, args) => {
      commands.push([command, ...args].join(" "));
    },
    log: () => undefined,
    ...overrides,
  };
  return { commands, deps, setupCalls };
}

describe("onboard", () => {
  it("delegates local preparation to setupLocal exactly once", async () => {
    const { commands, deps, setupCalls } = fakeDeps();
    await onboard(deps, {});
    expect(setupCalls).toHaveLength(1);
    const joined = commands.join("\n");
    expect(joined).not.toContain("supabase");
    expect(joined).not.toContain("db reset");
    expect(joined).toContain("experiment onboarding-smoke");
  });

  it("forwards fresh and dryRun to setupLocal", async () => {
    const { deps, setupCalls } = fakeDeps();
    await onboard(deps, { dryRun: true, fresh: true });
    expect(setupCalls[0]).toMatchObject({ dryRun: true, fresh: true });
  });

  it("skips env init when credentials exist and runs it when missing", async () => {
    const ready = fakeDeps();
    await onboard(ready.deps, {});
    expect(ready.commands).not.toContain("envInit");

    const missing = fakeDeps({ envReady: async () => false });
    await onboard(missing.deps, {});
    expect(missing.commands[0]).toBe("envInit");
  });

  it("stops with fix guidance when tooling checks fail", async () => {
    const { commands, deps } = fakeDeps({
      doctorTooling: async () => [
        { name: "docker", ok: false, detail: "not found", fix: "Install Docker" },
      ],
    });
    await expect(onboard(deps, {})).rejects.toThrow("Install Docker");
    expect(commands).toHaveLength(0);
  });

  it("stops when setupLocal reports a broken pipeline", async () => {
    const { deps } = fakeDeps({
      setupLocal: async () => ({
        ok: false,
        pipelines: [
          {
            database: "simple_v1_db",
            engine: "spine",
            entries: null,
            name: "simple_v1",
            status: "broken: provisioning failed",
          },
        ],
        steps: [],
      }),
    });
    await expect(onboard(deps, {})).rejects.toThrow(/simple_v1/);
  });

  it("embeds the sample only when nothing is embedded yet", async () => {
    const embedded = fakeDeps();
    await onboard(embedded.deps, {});
    expect(embedded.commands.join("\n")).not.toContain("prepare --limit 25");

    const empty = fakeDeps({ embeddedCount: async () => 0 });
    await onboard(empty.deps, {});
    expect(empty.commands.join("\n")).toContain("prepare --limit 25");
  });

  it("dry run executes no commands", async () => {
    const { commands, deps } = fakeDeps({ embeddedCount: async () => 0 });
    await onboard(deps, { dryRun: true });
    // setupLocal is still invoked (it handles dryRun itself); nothing else runs.
    expect(commands).toEqual(["setupLocal"]);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `pnpm --filter @dot-gov-news/operator-console test src/onboarding/onboard.test.ts`
Expected: FAIL — `setupLocal` not in `OnboardDeps`; old deps referenced.

- [ ] **Step 3: Rewrite onboard.ts**

Replace the interface and body (keep the toolchain gate and env init sections verbatim; replace the supabase-start/reset/uv-sync/pipeline-sync block with the delegation; keep embed + experiment steps):

```ts
export interface OnboardDeps {
  doctorTooling: () => Promise<CheckResult[]>;
  envReady: () => Promise<boolean>;
  envInit: () => Promise<void>;
  setupLocal: (opts: SetupLocalOpts) => Promise<SetupLocalReport>;
  embeddedCount: () => Promise<number>;
  run: (command: string, args: string[]) => Promise<void>;
  log: (message: string) => void;
}
```

Body after the env init section:

```ts
  const report = await deps.setupLocal({
    dryRun: opts.dryRun,
    fresh: opts.fresh,
  });
  const brokenPipelines = report.pipelines.filter((p) =>
    p.status.startsWith("broken"),
  );
  if (brokenPipelines.length > 0) {
    throw new Error(
      `pipeline databases not ready:\n${brokenPipelines
        .map((p) => `${p.name} (${p.database}): ${p.status}`)
        .join("\n")}`,
    );
  }

  const embedded = opts.dryRun ? 1 : await deps.embeddedCount();
  if (embedded === 0) {
    await act("embed a 25-entry sample with your Cloudflare models", () =>
      deps.run("uv", [
        "run", "python", "-m", "pipeline.cli", "prepare", "--limit", "25",
      ]),
    );
  } else {
    deps.log(`✓ embeddings present (${String(embedded)} entries)`);
  }
```

(The `act` helper, experiment step, and closing summary stay as they are. Note the dry-run embed guard simplifies back to `opts.dryRun ? 1 : …` because database state now belongs to setupLocal; the smoke-experiment step stays behind `act`, which no-ops on dry run.)

`defaultOnboardDeps()`: delete `dbUp`, `corpusCount`, and the supabase spawn usage; add:

```ts
    setupLocal: (opts) => setupLocal(defaultSetupLocalDeps(), opts),
```

with imports `{ setupLocal, defaultSetupLocalDeps, type SetupLocalOpts, type SetupLocalReport } from "./setup-local"`. Keep the `count(...)` helper only for `embeddedCount`.

cli.ts `onboard` registration: update `--fresh` help text to "wipe and rebuild the local database (asks for confirmation)" — reset semantics now live in setup.

- [ ] **Step 4: Run tests, typecheck, full suite**

Run: `pnpm --filter @dot-gov-news/operator-console test src/onboarding/onboard.test.ts && pnpm --filter @dot-gov-news/operator-console typecheck && pnpm --filter @dot-gov-news/operator-console test`
Expected: all green.

- [ ] **Step 5: Smoke**

Run: `pnpm ops onboard --dry-run`
Expected: toolchain gate output, then `[dry-run]` lines from setupLocal (including pipeline verification lines), then dry-run embed/experiment lines. Exit 0 on a machine whose tooling passes; on this machine the node-25 gate failure is environmental and acceptable — verify via the unit tests instead and note it.

- [ ] **Step 6: Commit**

```bash
git add apps/operator-console/src/onboarding/onboard.ts apps/operator-console/src/onboarding/onboard.test.ts apps/operator-console/src/cli.ts
git commit -m "refactor: onboard delegates local preparation to ops setup core"
```

---

### Task 3: Registry-aware doctor + remote-API row

**Files:**
- Modify: `apps/operator-console/src/onboarding/checks.ts`
- Test: `apps/operator-console/src/onboarding/checks.test.ts`

**Interfaces:**
- Consumes: `loadPipelineRegistry`, `PipelineRegistry` from `../config`; `probePipelineDatabase`, `pipelineDbName` from `../lab/setup`; `createLabDb` from `../lab/db`.
- Produces: `DoctorDeps` gains two members (existing members unchanged):

```ts
  registry: () => PipelineRegistry | null;
  probePipeline: (entry: PipelineEntry) => Promise<string | null>; // null = ready, string = problem detail
```

- [ ] **Step 1: Add failing tests**

Append to `checks.test.ts` (and extend `fakeDeps` with `registry: () => null, probePipeline: async () => null` defaults so existing tests stay valid):

```ts
  it("reports one row per registry pipeline", async () => {
    const deps = fakeDeps({
      registry: () => ({
        pipelines: [
          { databaseUrl: "postgresql://x@127.0.0.1:57422/postgres", engine: "classic", name: "complex_v1" },
          { databaseUrl: "postgresql://x@127.0.0.1:57422/simple_v1_db", engine: "spine", name: "simple_v1" },
        ],
      }),
      probePipeline: async (entry) =>
        entry.name === "simple_v1" ? "missing experiment tables" : null,
    });
    const results = await runDoctor(deps);
    const complex = results.find((r) => r.name === "pipeline complex_v1");
    const simple = results.find((r) => r.name === "pipeline simple_v1");
    expect(complex?.ok).toBe(true);
    expect(simple?.ok).toBe(false);
    expect(simple?.fix).toContain("pnpm ops setup");
  });

  it("omits pipeline rows without a registry", async () => {
    const results = await runDoctor(fakeDeps());
    expect(results.some((r) => r.name.startsWith("pipeline "))).toBe(false);
  });

  it("reports the remote API as optional when unconfigured", async () => {
    const results = await runDoctor(fakeDeps());
    const remote = results.find((r) => r.name === "remote API");
    expect(remote?.ok).toBe(true);
    expect(remote?.detail).toContain("not deployed");
  });
```

- [ ] **Step 2: Run to verify failure**

Run: `pnpm --filter @dot-gov-news/operator-console test src/onboarding/checks.test.ts`
Expected: FAIL — unknown deps members / missing rows.

- [ ] **Step 3: Implement**

In `checks.ts`: add the two `DoctorDeps` members; in `credentialChecks` (after the local-database row) insert:

```ts
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

  results.push(
    deps.env.OPS_API_URL
      ? { name: "remote API", ok: true, detail: `configured (${deps.env.OPS_API_URL})` }
      : { name: "remote API", ok: true, detail: "not deployed (optional) — pnpm ops deploy enables remote commands" },
  );
```

In `defaultDoctorDeps()` add:

```ts
    registry: () => loadPipelineRegistry(),
    probePipeline: async (entry) => {
      const db = createLabDb(entry.databaseUrl);
      try {
        const probe = await probePipelineDatabase(db, entry);
        return probe.ok ? null : probe.problem;
      } finally {
        await db.close();
      }
    },
```

IMPORTANT: before wiring, read `probePipelineDatabase`'s actual signature and return shape in `src/lab/setup.ts:82` and adapt this closure to it (the shape above is indicative; the function exists — use its real fields). Do not modify lab/setup.ts.

- [ ] **Step 4: Run tests, typecheck, full suite**

Run: `pnpm --filter @dot-gov-news/operator-console test && pnpm --filter @dot-gov-news/operator-console typecheck`
Expected: green (existing checks tests updated defaults keep passing).

- [ ] **Step 5: Commit**

```bash
git add apps/operator-console/src/onboarding/checks.ts apps/operator-console/src/onboarding/checks.test.ts
git commit -m "feat: doctor verifies every registry pipeline database and remote API state"
```

---

### Task 4: Remote group, capability gate, shims, help groups

**Files:**
- Modify: `apps/operator-console/src/config.ts` (add `remoteConfigured`)
- Modify: `apps/operator-console/src/cli.ts` (restructure)
- Test: `apps/operator-console/src/config.test.ts` (append), new `apps/operator-console/test/cli-surface.test.ts`

**Interfaces:**
- Produces: `remoteConfigured(): boolean` in config.ts — true when `OPS_API_URL` is set after the module's dotenv load.
- cli.ts final structure: `remote` subcommand owning `health`, `queues`, `events`, `inventory`, `discovery`, `site`, `worker`; hidden exit-2 shims at the old top-level names; helpGroup headings `Local:`, `Lab:`, `Remote:`, `Meta:`.

- [ ] **Step 1: Failing test for remoteConfigured**

Append to `src/config.test.ts`:

```ts
describe("remoteConfigured", () => {
  it("reflects OPS_API_URL presence", () => {
    const original = process.env.OPS_API_URL;
    try {
      delete process.env.OPS_API_URL;
      expect(remoteConfigured()).toBe(false);
      process.env.OPS_API_URL = "https://ops.example.workers.dev";
      expect(remoteConfigured()).toBe(true);
    } finally {
      if (original === undefined) delete process.env.OPS_API_URL;
      else process.env.OPS_API_URL = original;
    }
  });
});
```

(Import `remoteConfigured` alongside the file's existing imports.)

- [ ] **Step 2: Verify fail, implement in config.ts**

```ts
/** True when the deployed operator API is configured — gates the remote
 * command group. ensureEnvironment() has already merged .env by the time
 * any caller runs. */
export function remoteConfigured(): boolean {
  ensureEnvironment();
  return Boolean(process.env.OPS_API_URL);
}
```

(Match how `loadOperatorConfig` triggers `ensureEnvironment` — read config.ts first; if `ensureEnvironment` is named differently, use the file's actual lazy-env helper.)

Run: `pnpm --filter @dot-gov-news/operator-console test src/config.test.ts` → PASS.

- [ ] **Step 3: Restructure cli.ts**

This is a mechanical move — command implementations change zero lines inside their action bodies.

1. Create the group parent after the `program` definition:

```ts
const remote = new Command("remote").description(
  "Observe the deployed pipeline (read-only)",
);
```

(`Command` is already imported.)

2. Move these registrations from `program.` / standalone to `remote.`, unchanged inside: `health`, `queues`, the whole `inventory` group, the `discovery` group, the `events` group, `site`, `worker`. E.g. `program.command("health")` → `remote.command("health")`; `const inventory = program.command("inventory")` → `const inventory = remote.command("inventory")`.

3. Register the group + gate + footer:

```ts
if (remoteConfigured()) {
  program.addCommand(remote.helpGroup("Remote:"));
} else {
  program.addCommand(remote, { hidden: true });
  remote.hook("preSubcommand", () => {
    process.stderr.write(
      "remote: not configured — deploy the operator API first (pnpm ops deploy)\n",
    );
    process.exit(3);
  });
  program.addHelpText(
    "after",
    "\nremote: not configured — deploy the operator API first (pnpm ops deploy)\n",
  );
}
```

4. Hidden shims for the seven old top-level names:

```ts
for (const moved of [
  "health", "queues", "events", "inventory", "discovery", "site", "worker",
] as const) {
  const shim = new Command(moved)
    .allowUnknownOption()
    .helpOption(false)
    .action(() => {
      process.stderr.write(`moved: pnpm ops remote ${moved}\n`);
      process.exitCode = 2;
    });
  shim.command("*", { hidden: true });
  program.addCommand(shim, { hidden: true });
}
```

NOTE: verify shim behavior for subcommand forms (`ops inventory summary`) — commander may route to the shim's action only for the bare name. If `shim.command("*")` misbehaves under commander 15, instead give each shim `.argument("[args...]")` with `.allowExcessArguments()` so any invocation reaches the action. Test drives this (Step 4).

5. Help groups on the locals:

```ts
// after each registration:
// onboard/setup/doctor/env/dashboard commands: .helpGroup("Local:")
// lab: .helpGroup("Lab:")
// deploy (Task 5) and docs:generate: .helpGroup("Meta:")
```

Commander 15's `.helpGroup(heading)` exists on `Command` (verified in typings). Also add the start-here banner:

```ts
program.addHelpText("beforeAll", "start here: pnpm ops onboard\n");
```

6. Delete the `examples` command; its recipe listing moves to the cheatsheet only (Task 7 updates docs references).

- [ ] **Step 4: Surface tests (subprocess)**

Create `apps/operator-console/test/cli-surface.test.ts`:

```ts
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { describe, expect, it } from "vitest";

const run = promisify(execFile);
const CLI = ["tsx", "src/cli.ts"];

async function ops(args: string[], env: Record<string, string | undefined> = {}) {
  try {
    const { stdout, stderr } = await run("npx", [...CLI, ...args], {
      cwd: new URL("..", import.meta.url).pathname,
      env: { ...process.env, ...env },
    });
    return { code: 0, stderr, stdout };
  } catch (error) {
    const e = error as { code?: number; stdout?: string; stderr?: string };
    return { code: e.code ?? 1, stderr: e.stderr ?? "", stdout: e.stdout ?? "" };
  }
}

describe("cli surface", () => {
  it("hides remote and prints the footer when unconfigured", async () => {
    const { stdout } = await ops(["--help"], { OPS_API_URL: undefined });
    expect(stdout).toContain("start here: pnpm ops onboard");
    expect(stdout).toContain("remote: not configured");
    expect(stdout).not.toMatch(/^\s+remote\s/m);
  });

  it("shows remote when configured", async () => {
    const { stdout } = await ops(["--help"], {
      OPS_API_URL: "https://ops.example.workers.dev",
    });
    expect(stdout).toMatch(/Remote:/);
  });

  it("old top-level names point to remote and exit 2", async () => {
    const { code, stderr } = await ops(["health"], {
      OPS_API_URL: "https://ops.example.workers.dev",
    });
    expect(stderr).toContain("moved: pnpm ops remote health");
    expect(code).toBe(2);
  });

  it("remote subcommand exits 3 when unconfigured", async () => {
    const { code, stderr } = await ops(["remote", "queues"], {
      OPS_API_URL: undefined,
    });
    expect(stderr).toContain("not configured");
    expect(code).toBe(3);
  });
});
```

Caveat for the implementer: `env: { OPS_API_URL: undefined }` does not unset an inherited variable on all platforms when spreading `process.env` — build the env object by destructuring it out instead: `const { OPS_API_URL: _drop, ...rest } = process.env;`. Also, if `.env` in the repo root contains `OPS_API_URL`, the CLI merges it lazily — run the subprocess with cwd inside `apps/operator-console` and, if the footer test still sees a configured remote, set `OPS_API_URL=""` (empty string is falsy for `Boolean()` gate) instead of unsetting.

- [ ] **Step 5: Run everything**

Run: `pnpm --filter @dot-gov-news/operator-console test && pnpm --filter @dot-gov-news/operator-console typecheck`
Expected: green, including the 4 new subprocess tests (they are slower — ~2s each is fine).

- [ ] **Step 6: Commit**

```bash
git add apps/operator-console/src/cli.ts apps/operator-console/src/config.ts apps/operator-console/src/config.test.ts apps/operator-console/test/cli-surface.test.ts
git commit -m "feat: group ops CLI by audience and capability-gate the remote surface"
```

---

### Task 5: `deploy` rename

**Files:**
- Modify: `package.json` (root), `apps/operator-console/package.json`, `apps/operator-console/src/cli.ts`, `apps/operator-console/src/setup.ts:` (program name string only)

**Interfaces:**
- Consumes: nothing new. Produces: `pnpm ops deploy` and root script `ops:deploy`.

- [ ] **Step 1: Rename scripts**

Root `package.json`: `"ops:setup": "pnpm --filter @dot-gov-news/operator-console run setup"` → `"ops:deploy": "pnpm --filter @dot-gov-news/operator-console run deploy"`.
Console `package.json`: `"setup": "tsx src/setup.ts"` → `"deploy": "tsx src/setup.ts"`.
`src/setup.ts`: `.name("ops:setup")` → `.name("ops:deploy")`.

- [ ] **Step 2: Add the `ops deploy` passthrough command**

In cli.ts (Meta group):

```ts
program
  .command("deploy")
  .description("Deploy the read-only Operator API to Cloudflare and configure .env")
  .helpGroup("Meta:")
  .allowUnknownOption()
  .argument("[args...]", "flags forwarded to the deploy script (--dry-run, --rotate-token, --yes)")
  .action((args: string[]) =>
    runAction(
      () =>
        new Promise<void>((resolveRun, rejectRun) => {
          const child = spawn("npx", ["tsx", "src/setup.ts", ...args], {
            cwd: resolve(repositoryRoot, "apps/operator-console"),
            env: process.env,
            stdio: "inherit",
          });
          child.once("error", rejectRun);
          child.once("close", (code) => {
            if (code === 0) resolveRun();
            else rejectRun(new Error(`deploy exited with code ${String(code)}`));
          });
        }),
    ),
  );
```

Add `import { spawn } from "node:child_process";` and `import { resolve } from "node:path";` if not present in cli.ts.

- [ ] **Step 3: Verify**

Run: `pnpm ops deploy -- --dry-run` (or `pnpm ops deploy --dry-run` given allowUnknownOption)
Expected: setup.ts's dry-run validation output (it validates the wrangler bundle without deploying — currently may fail at Cloudflare auth since infra is torn down; the command reaching setup.ts's own output is the pass criterion). Also `pnpm ops:deploy --dry-run` from root behaves identically. Grep for leftovers: `grep -rn "ops:setup" --include="*.json" --include="*.ts" .` (docs handled in Task 7).

- [ ] **Step 4: Commit**

```bash
git add package.json apps/operator-console/package.json apps/operator-console/src/cli.ts apps/operator-console/src/setup.ts
git commit -m "feat: rename operator API deployment to ops deploy"
```

---

### Task 6: Hygiene — DSN single-source + stale message

**Files:**
- Modify: `apps/operator-console/src/onboarding/checks.ts`, `apps/operator-console/src/lab/db.ts`
- Test: existing suites

- [ ] **Step 1: Re-export instead of duplicating**

In `checks.ts` replace:

```ts
export const LOCAL_DSN =
  "postgresql://postgres:postgres@127.0.0.1:57422/postgres";
```

with:

```ts
import { LOCAL_DATABASE_URL } from "../config";
export const LOCAL_DSN = LOCAL_DATABASE_URL;
```

(Keep the `LOCAL_DSN` name — onboard.ts/setup-local.ts consumers unchanged. Merge into the existing `../config` import statement.)

- [ ] **Step 2: Fix the stale message**

In `src/lab/db.ts` `labCapability`, change the not-enabled reason string `...127.0.0.1:54322/postgres...` to `...127.0.0.1:57422/postgres...`.

- [ ] **Step 3: Verify + commit**

Run: `pnpm --filter @dot-gov-news/operator-console test && pnpm --filter @dot-gov-news/operator-console typecheck`
Expected: green (fix any test asserting the old message text — search `54322` under apps/operator-console; the only remaining 54322 in the repo should be `pipeline/config.py` + its pinned test, which are out of scope).

```bash
git add apps/operator-console/src/onboarding/checks.ts apps/operator-console/src/lab/db.ts
git commit -m "fix: single-source the local DSN and correct the stale lab port hint"
```

---

### Task 7: Recipes, cheatsheet, docs

**Files:**
- Modify: `apps/operator-console/src/recipes.ts`, `docs/operations/cli-cheatsheet.md` (regenerated), `ONBOARDING.md`, `docs/operations/clustering-lab.md`, `docs/infrastructure/access.md`, `README.md`

- [ ] **Step 1: Update recipes**

In `recipes.ts`, prefix the moved commands' `cli:` strings: `pnpm ops health --deep` → `pnpm ops remote health --deep`; same for `queues`, `inventory summary`, `inventory runs`, `site lookup` (`ops remote site inspect` per actual command), `recent-events` → `pnpm ops remote events list`, `worker-tail` → `pnpm ops remote worker tail`. Lab recipe strings (`lab-*`) unchanged except any `lab setup` reference → `pnpm ops setup`. Read each recipe's current `cli:` string and change only the command path, never flags.

- [ ] **Step 2: Regenerate the cheatsheet**

Run: `pnpm ops docs:generate`
Expected: `docs/operations/cli-cheatsheet.md` regenerated with remote-prefixed commands. Update the cheatsheet's hand-written header sections (One-time setup / Everyday startup) to name `pnpm ops deploy` (was ops:setup) and `pnpm ops setup`.
NOTE: check whether the header is inside `generate-cheatsheet.ts` as a template string — if so, edit it there and regenerate rather than editing the output file.

- [ ] **Step 3: Update the four docs**

- `ONBOARDING.md`: everyday-commands table gains `pnpm ops setup` ("prepare/refresh all pipeline databases"); troubleshooting rows for `pipeline <name>` doctor checks (fix: `pnpm ops setup`) and `remote API` ("optional — only after pnpm ops deploy").
- `docs/operations/clustering-lab.md`: replace `pnpm ops lab setup` references with `pnpm ops setup`; replace any manual `supabase migration up` + sync instructions with "run `pnpm ops setup`".
- `docs/infrastructure/access.md`: replace `pnpm ops:setup` mentions with `pnpm ops deploy`.
- `README.md`: replace `pnpm ops:setup`/`ops:start` mentions if present (grep) and ensure the smoke-path section doesn't reference moved command names (`pnpm ops health` → `pnpm ops remote health`).

Grep to catch stragglers: `grep -rn "ops:setup\|ops lab setup\|pnpm ops health\|pnpm ops queues\|pnpm ops events\|pnpm ops inventory\|pnpm ops worker\|pnpm ops site\|pnpm ops examples" --include="*.md" . | grep -v node_modules | grep -v superpowers`

- [ ] **Step 4: Format + verify + commit**

Run: `pnpm format && pnpm format:check && pnpm --filter @dot-gov-news/operator-console test`
Expected: clean.

```bash
git add apps/operator-console/src/recipes.ts apps/operator-console/src/generate-cheatsheet.ts docs/operations/cli-cheatsheet.md ONBOARDING.md docs/operations/clustering-lab.md docs/infrastructure/access.md README.md
git commit -m "docs: regenerate CLI reference for the regrouped ops surface"
```

---

## Post-plan notes

- Live-fire `pnpm ops setup` against the real local stack (both pipelines) is the acceptance test after Task 7 — run it once and include the report table in the final summary. Requires Docker running; safe (non-destructive path).
- `pipeline/config.py` 54322 default: untouched, pinned by `tests/test_cache.py` — out of scope per spec.
