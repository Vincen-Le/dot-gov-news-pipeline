import { EventEmitter } from "node:events";
import { spawn, type ChildProcess } from "node:child_process";
import { createInterface } from "node:readline";
import {
  parseWorkerLifecycleLog,
  type WorkerLifecycleLog,
} from "@dot-gov-news/contracts";

import { repositoryRoot } from "./config";

export type TailState =
  "idle" | "connecting" | "live" | "reconnecting" | "stopped";

export interface TailOptions {
  samplingRate?: number;
  search?: string;
  status?: Array<"ok" | "error" | "canceled">;
  workerName: string;
}

export interface TailEvent {
  receivedAt: string;
  value: unknown;
}

export function sanitizeTailValue(value: unknown, depth = 0): unknown {
  if (depth > 6) {
    return "[truncated]";
  }
  if (typeof value === "string") {
    return value.length > 2_000 ? `${value.slice(0, 2_000)}…` : value;
  }
  if (Array.isArray(value)) {
    return value
      .slice(0, 100)
      .map((item) => sanitizeTailValue(item, depth + 1));
  }
  if (typeof value !== "object" || value === null) {
    return value;
  }

  const output: Record<string, unknown> = {};
  for (const [key, child] of Object.entries(value)) {
    if (/authorization|cookie|secret|token|password/iu.test(key)) {
      output[key] = "[redacted]";
    } else {
      output[key] = sanitizeTailValue(child, depth + 1);
    }
  }
  return output;
}

export function sanitizeDiagnosticLine(line: string): string {
  return line
    .replace(/Bearer\s+\S+/giu, "Bearer [redacted]")
    .replace(
      /((?:authorization|cookie|secret|token|password)\s*[:=]\s*)\S+/giu,
      "$1[redacted]",
    )
    .slice(0, 1_000);
}

function parseLifecycleCandidate(value: unknown): WorkerLifecycleLog | null {
  let candidate = value;
  if (typeof candidate === "string") {
    try {
      candidate = JSON.parse(candidate);
    } catch {
      return null;
    }
  }
  try {
    return parseWorkerLifecycleLog(candidate);
  } catch {
    return null;
  }
}

export function parseWorkerLifecycleTailLine(
  line: string,
): WorkerLifecycleLog[] {
  let trace: unknown;
  try {
    trace = JSON.parse(line);
  } catch {
    return [];
  }
  const direct = parseLifecycleCandidate(trace);
  if (direct !== null) return [direct];
  if (typeof trace !== "object" || trace === null || Array.isArray(trace)) {
    return [];
  }
  const logs = (trace as Record<string, unknown>).logs;
  if (!Array.isArray(logs)) return [];

  const entries: WorkerLifecycleLog[] = [];
  for (const log of logs) {
    if (typeof log !== "object" || log === null || Array.isArray(log)) continue;
    const message = (log as Record<string, unknown>).message;
    for (const candidate of Array.isArray(message) ? message : [message]) {
      const parsed = parseLifecycleCandidate(candidate);
      if (parsed !== null) entries.push(parsed);
    }
  }
  return entries;
}

function signalProcessTree(child: ChildProcess, signal: NodeJS.Signals): void {
  if (process.platform !== "win32" && child.pid !== undefined) {
    try {
      process.kill(-child.pid, signal);
      return;
    } catch {
      // Fall back to the direct child when the process group already exited.
    }
  }
  child.kill(signal);
}

export class WorkerTail extends EventEmitter {
  readonly #options: TailOptions;
  readonly #spawnProcess: typeof spawn;
  #child: ChildProcess | null = null;
  #restartCount = 0;
  #restartTimer: NodeJS.Timeout | null = null;
  #stopping = false;

  constructor(options: TailOptions, spawnProcess: typeof spawn = spawn) {
    super();
    this.#options = options;
    this.#spawnProcess = spawnProcess;
  }

  get running(): boolean {
    return this.#child !== null;
  }

  start(): void {
    if (this.#child !== null) {
      return;
    }
    this.#stopping = false;
    this.#spawn();
  }

  async stop(): Promise<void> {
    this.#stopping = true;
    if (this.#restartTimer !== null) {
      clearTimeout(this.#restartTimer);
      this.#restartTimer = null;
    }
    const child = this.#child;
    if (child !== null) {
      let completed = false;
      const completion = new Promise<void>((resolveCompletion) => {
        const finish = () => {
          completed = true;
          resolveCompletion();
        };
        child.once("close", finish);
        child.once("error", finish);
      });
      signalProcessTree(child, "SIGTERM");
      await Promise.race([
        completion,
        new Promise<void>((resolveTimeout) =>
          setTimeout(resolveTimeout, 3_000).unref(),
        ),
      ]);
      if (!completed) {
        signalProcessTree(child, "SIGKILL");
        await Promise.race([
          completion,
          new Promise<void>((resolveTimeout) =>
            setTimeout(resolveTimeout, 1_000).unref(),
          ),
        ]);
      }
      if (this.#child === child) this.#child = null;
    }
    this.emit("state", "stopped" satisfies TailState);
  }

  #spawn(): void {
    this.emit(
      "state",
      (this.#restartCount === 0
        ? "connecting"
        : "reconnecting") satisfies TailState,
    );
    const args = [
      "--filter",
      "@dot-gov-news/pipeline-worker",
      "exec",
      "wrangler",
      "tail",
      this.#options.workerName,
      "--format",
      "json",
      "--sampling-rate",
      String(this.#options.samplingRate ?? 0.1),
    ];
    if (this.#options.search !== undefined) {
      args.push("--search", this.#options.search);
    }
    for (const status of this.#options.status ?? []) {
      args.push("--status", status);
    }

    let child: ChildProcess;
    try {
      child = this.#spawnProcess("pnpm", args, {
        cwd: repositoryRoot,
        detached: process.platform !== "win32",
        env: process.env,
        stdio: ["ignore", "pipe", "pipe"],
      });
    } catch (error) {
      this.#scheduleRestart(error);
      return;
    }
    this.#child = child;
    if (child.stdout === null || child.stderr === null) {
      this.#finalizeChild(
        child,
        new Error("Wrangler tail streams are unavailable"),
      );
      return;
    }
    const lines = createInterface({ input: child.stdout });
    lines.on("line", (line) => {
      if (line.trim().length === 0) return;
      const entries = parseWorkerLifecycleTailLine(line);
      if (entries.length > 0) {
        for (const entry of entries) {
          const event: TailEvent = {
            receivedAt: new Date().toISOString(),
            value: sanitizeTailValue(entry),
          };
          this.emit("event", event);
        }
        this.emit("state", "live" satisfies TailState);
      } else {
        this.emit("diagnostic", sanitizeDiagnosticLine(line));
      }
    });
    const errors = createInterface({ input: child.stderr });
    errors.on("line", (line) => {
      this.emit("diagnostic", sanitizeDiagnosticLine(line));
    });
    let finalized = false;
    const finalize = (error?: Error) => {
      if (finalized) return;
      finalized = true;
      lines.close();
      errors.close();
      this.#finalizeChild(child, error);
    };
    child.once("error", (error) => finalize(error));
    child.once("close", () => finalize());
  }

  #finalizeChild(child: ChildProcess, error?: Error): void {
    if (this.#child === child) this.#child = null;
    if (error !== undefined) this.emit("error", error);
    if (!this.#stopping) this.#scheduleRestart();
  }

  #scheduleRestart(error?: unknown): void {
    if (error instanceof Error) this.emit("error", error);
    if (this.#stopping || this.#restartTimer !== null) return;
    this.#restartCount += 1;
    const delay = Math.min(
      30_000,
      1_000 * 2 ** Math.min(5, this.#restartCount),
    );
    this.#restartTimer = setTimeout(() => {
      this.#restartTimer = null;
      if (!this.#stopping && this.#child === null) this.#spawn();
    }, delay);
    this.#restartTimer.unref();
  }
}
