// apps/operator-console/src/lab/harness.ts
import { spawn } from "node:child_process";

export const LAB_ENV_WHITELIST = [
  "ADJUDICATOR_MODEL",
  "AMBIENT_EMA_CEILING",
  "CLUSTER_JOIN_THRESHOLD",
  "DEDUPE_WINDOW_HOURS",
  "EMBEDDING_MODEL",
  "ENRICHER_MODEL",
  "ENRICHER_VERSION",
  "ENRICHMENT_ENABLED",
  "EPISODE_DORMANCY_HOURS",
  "JUDGE_MODEL",
  "NEAR_DUP_THRESHOLD",
  "PROMPT_VERSION",
  "RUBRIC_VERSION",
  "STORYLINE_SIM_FLOOR",
  "TAU_SECONDS",
] as const;

const NAME_PATTERN = /^[a-z0-9][a-z0-9._-]{0,63}$/i;

export type StageName = "reset-features" | "prepare" | "experiment";

export interface RunStage {
  detail?: string;
  name: StageName;
  status: "pending" | "running" | "succeeded" | "failed" | "skipped";
}

export interface ActiveRun {
  name: string;
  stages: RunStage[];
  startedAt: string;
  stub: boolean;
}

export interface RunRequest {
  clearFeatures?: boolean;
  env?: Record<string, string>;
  limit?: number | null;
  name: string;
  noCache?: boolean;
  prepare?: boolean;
  stub?: boolean;
  until?: string | null;
}

export type RunEvent =
  | { line: string; type: "log" }
  | { stage: RunStage; type: "stage" }
  | {
      reportPath: string | null;
      runId: string | null;
      status: "failed" | "succeeded";
      type: "done";
    };

export type StageSpawner = (
  command: string,
  args: string[],
  env: Record<string, string>,
  onLine: (line: string) => void,
) => Promise<number>;

export class LabRunActiveError extends Error {
  constructor(readonly activeName: string) {
    super(`experiment "${activeName}" is already running`);
    this.name = "LabRunActiveError";
  }
}

export class LabValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "LabValidationError";
  }
}

export class ExperimentHarness {
  active: ActiveRun | null = null;
  private readonly listeners = new Set<(event: RunEvent) => void>();

  constructor(
    private readonly deps: {
      needsPrepare: () => Promise<number>;
      spawnStage: StageSpawner;
    },
  ) {}

  onEvent(listener: (event: RunEvent) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  private emit(event: RunEvent): void {
    for (const listener of this.listeners) listener(event);
  }

  async start(
    request: RunRequest,
    now: () => Date = () => new Date(),
  ): Promise<ActiveRun> {
    if (!NAME_PATTERN.test(request.name)) {
      throw new LabValidationError(
        "experiment name must be alphanumeric with . _ - (it becomes the report directory)",
      );
    }
    const env = request.env ?? {};
    const whitelist = new Set<string>(LAB_ENV_WHITELIST);
    for (const key of Object.keys(env)) {
      if (!whitelist.has(key)) {
        throw new LabValidationError(
          `unknown pipeline env override: ${key} (allowed: ${LAB_ENV_WHITELIST.join(", ")})`,
        );
      }
    }
    if (this.active !== null) throw new LabRunActiveError(this.active.name);

    // Reserve the single run slot synchronously, before any await, so a
    // second start() issued while needsPrepare() resolves cannot also pass
    // the guard above. Stages are backfilled once the plan is known.
    const active: ActiveRun = {
      name: request.name,
      stages: [],
      startedAt: now().toISOString(),
      stub: request.stub ?? false,
    };
    this.active = active;

    let includePrepare: boolean;
    try {
      includePrepare =
        request.clearFeatures === true ||
        (request.prepare ?? (await this.deps.needsPrepare()) > 0);
    } catch (error) {
      this.active = null;
      throw error;
    }
    const stageNames: StageName[] = [
      ...(request.clearFeatures ? (["reset-features"] as const) : []),
      ...(includePrepare ? (["prepare"] as const) : []),
      "experiment",
    ];
    active.stages = stageNames.map((name) => ({ name, status: "pending" }));
    void this.execute(active, request, env).finally(() => {
      this.active = null;
    });
    return active;
  }

  private stageArgs(
    stage: StageName,
    request: RunRequest,
  ): { args: string[]; env: boolean } {
    const base = ["run", "python", "-m", "pipeline.cli"];
    if (stage === "reset-features") {
      return { args: [...base, "reset", "--features"], env: false };
    }
    if (stage === "prepare") {
      return {
        args: [...base, "prepare", ...(request.stub ? ["--stub"] : [])],
        env: true,
      };
    }
    return {
      args: [
        ...base,
        "experiment",
        request.name,
        ...(request.stub ? ["--stub"] : []),
        ...(request.limit != null ? ["--limit", String(request.limit)] : []),
        ...(request.until != null ? ["--until", request.until] : []),
        ...(request.noCache ? ["--no-cache"] : []),
      ],
      env: true,
    };
  }

  private async execute(
    active: ActiveRun,
    request: RunRequest,
    env: Record<string, string>,
  ): Promise<void> {
    let failed = false;
    let runId: string | null = null;
    let reportPath: string | null = null;

    for (const stage of active.stages) {
      if (failed) {
        stage.status = "skipped";
        this.emit({ stage: { ...stage }, type: "stage" });
        continue;
      }
      stage.status = "running";
      this.emit({ stage: { ...stage }, type: "stage" });

      const { args, env: passEnv } = this.stageArgs(stage.name, request);
      let lastJson: { report?: string; run_id?: string } | null = null;
      try {
        const exitCode = await this.deps.spawnStage(
          "uv",
          args,
          passEnv ? env : {},
          (line) => {
            this.emit({ line, type: "log" });
            if (stage.name === "experiment") {
              try {
                const parsed = JSON.parse(line) as {
                  report?: string;
                  run_id?: string;
                };
                if (parsed.run_id !== undefined) lastJson = parsed;
              } catch {
                // not a JSON line; ignore
              }
            }
          },
        );
        if (exitCode !== 0) {
          throw new Error(`${stage.name} exited with code ${exitCode}`);
        }
        stage.status = "succeeded";
        if (stage.name === "experiment" && lastJson !== null) {
          runId = (lastJson as { run_id?: string }).run_id ?? null;
          reportPath = (lastJson as { report?: string }).report ?? null;
        }
      } catch (error) {
        failed = true;
        stage.status = "failed";
        stage.detail =
          error instanceof Error ? error.message : "stage failed";
      }
      this.emit({ stage: { ...stage }, type: "stage" });
    }

    this.emit({
      reportPath,
      runId,
      status: failed ? "failed" : "succeeded",
      type: "done",
    });
  }
}

export function defaultSpawner(cwd: string): StageSpawner {
  return (command, args, env, onLine) =>
    new Promise((resolve, reject) => {
      const child = spawn(command, args, {
        cwd,
        env: { ...process.env, ...env },
        stdio: ["ignore", "pipe", "pipe"],
      });
      const forward = (chunk: Buffer): void => {
        for (const line of chunk.toString().split("\n")) {
          if (line.trim().length > 0) onLine(line);
        }
      };
      child.stdout.on("data", forward);
      child.stderr.on("data", forward);
      child.once("error", reject);
      child.once("close", (code) => resolve(code ?? 1));
    });
}
