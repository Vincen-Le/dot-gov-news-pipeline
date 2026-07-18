// apps/operator-console/test/lab-harness.test.ts
import { describe, expect, it } from "vitest";

import {
  createLineSplitter,
  ExperimentHarness,
  LabRunActiveError,
  LabValidationError,
  type RunEvent,
} from "../src/lab/harness";

interface SpawnCall {
  args: string[];
  command: string;
  env: Record<string, string>;
}

function build(options: { exitCodes?: number[]; needsPrepare?: number } = {}) {
  const calls: SpawnCall[] = [];
  const harness = new ExperimentHarness({
    needsPrepare: async () => options.needsPrepare ?? 0,
    spawnStage: async (command, args, env, onLine) => {
      calls.push({ args, command, env });
      // small delay so "run already active" checks race deterministically
      await new Promise((resolve) => setTimeout(resolve, 5));
      if (args.includes("experiment")) {
        onLine("stage log line");
        onLine('{"report": "docs/eval/baseline/report.md", "run_id": "run-123"}');
      } else {
        onLine(`${args.join(" ")}`);
      }
      return options.exitCodes?.[calls.length - 1] ?? 0;
    },
  });
  return { calls, harness };
}

async function waitForDone(
  harness: ExperimentHarness,
): Promise<{ events: RunEvent[]; done: Extract<RunEvent, { type: "done" }> }> {
  return new Promise((resolve) => {
    const events: RunEvent[] = [];
    harness.onEvent((event) => {
      events.push(event);
      if (event.type === "done") resolve({ done: event, events });
    });
  });
}

describe("createLineSplitter", () => {
  it("reassembles a line split across chunk boundaries", () => {
    const lines: string[] = [];
    const splitter = createLineSplitter((line) => lines.push(line));
    splitter.push('{"report": "docs/eval/baseline/report.md",');
    splitter.push(' "run_id": "run-123"}\n');
    expect(lines).toEqual([
      '{"report": "docs/eval/baseline/report.md", "run_id": "run-123"}',
    ]);
  });

  it("flushes a trailing partial line with no newline on stream end", () => {
    const lines: string[] = [];
    const splitter = createLineSplitter((line) => lines.push(line));
    splitter.push("stage log line\nfinal unterminated line");
    expect(lines).toEqual(["stage log line"]);
    splitter.flush();
    expect(lines).toEqual(["stage log line", "final unterminated line"]);
  });

  it("does not emit an empty remainder on flush", () => {
    const lines: string[] = [];
    const splitter = createLineSplitter((line) => lines.push(line));
    splitter.push("complete line\n");
    splitter.flush();
    expect(lines).toEqual(["complete line"]);
  });
});

describe("ExperimentHarness", () => {
  it("runs experiment-only when features are prepared, parsing the run id", async () => {
    const { calls, harness } = build({ needsPrepare: 0 });
    const finished = waitForDone(harness);
    const active = await harness.start({
      env: { NEAR_DUP_THRESHOLD: "0.87" },
      limit: 1000,
      name: "baseline",
      stub: true,
    });
    expect(active.stages.map((stage) => stage.name)).toEqual(["experiment"]);
    const { done } = await finished;
    expect(done.status).toBe("succeeded");
    expect(done.runId).toBe("run-123");
    expect(done.reportPath).toBe("docs/eval/baseline/report.md");
    expect(calls).toHaveLength(1);
    expect(calls[0]!.command).toBe("uv");
    expect(calls[0]!.args).toEqual([
      "run",
      "python",
      "-m",
      "pipeline.cli",
      "experiment",
      "baseline",
      "--stub",
      "--limit",
      "1000",
    ]);
    expect(calls[0]!.env.NEAR_DUP_THRESHOLD).toBe("0.87");
    expect(harness.active).toBeNull();
  });

  it("auto-includes prepare when features are missing, and reset-features when asked", async () => {
    const withPrepare = build({ needsPrepare: 5 });
    let finished = waitForDone(withPrepare.harness);
    const active = await withPrepare.harness.start({ name: "auto", stub: true });
    expect(active.stages.map((stage) => stage.name)).toEqual([
      "prepare",
      "experiment",
    ]);
    await finished;
    expect(withPrepare.calls[0]!.args).toEqual([
      "run",
      "python",
      "-m",
      "pipeline.cli",
      "prepare",
      "--stub",
    ]);

    const withReset = build({ needsPrepare: 0 });
    finished = waitForDone(withReset.harness);
    const cleared = await withReset.harness.start({
      clearFeatures: true,
      env: { ENRICHMENT_ENABLED: "false" },
      name: "no-enrich",
      stub: true,
    });
    expect(cleared.stages.map((stage) => stage.name)).toEqual([
      "reset-features",
      "prepare",
      "experiment",
    ]);
    await finished;
    expect(withReset.calls[0]!.args).toEqual([
      "run",
      "python",
      "-m",
      "pipeline.cli",
      "reset",
      "--features",
    ]);
    expect(withReset.calls[0]!.env).toEqual({});
    expect(withReset.calls[1]!.env.ENRICHMENT_ENABLED).toBe("false");
  });

  it("marks failure, skips downstream stages, and reports no run id", async () => {
    const { harness } = build({ exitCodes: [1], needsPrepare: 5 });
    const finished = waitForDone(harness);
    await harness.start({ name: "boom", stub: true });
    const { done, events } = await finished;
    expect(done.status).toBe("failed");
    expect(done.runId).toBeNull();
    const stageEvents = events
      .filter(
        (event): event is Extract<RunEvent, { type: "stage" }> =>
          event.type === "stage",
      )
      .map((event) => `${event.stage.name}:${event.stage.status}`);
    expect(stageEvents).toContain("prepare:failed");
    expect(stageEvents).toContain("experiment:skipped");
  });

  it("rejects a second start issued while the first is still resolving needsPrepare", async () => {
    const calls: SpawnCall[] = [];
    const resolvers: Array<(count: number) => void> = [];
    const harness = new ExperimentHarness({
      needsPrepare: () =>
        new Promise<number>((resolve) => {
          resolvers.push(resolve);
        }),
      spawnStage: async (command, args, env, onLine) => {
        calls.push({ args, command, env });
        onLine('{"report": "docs/eval/first/report.md", "run_id": "run-1"}');
        return 0;
      },
    });
    const finished = waitForDone(harness);
    const first = harness.start({ name: "first", stub: true });
    const second = harness.start({ name: "second", stub: true });
    for (const resolve of resolvers) resolve(0);
    await expect(second).rejects.toBeInstanceOf(LabRunActiveError);
    const active = await first;
    expect(active.name).toBe("first");
    expect(active.stages.map((stage) => stage.name)).toEqual(["experiment"]);
    const { done } = await finished;
    expect(done.status).toBe("succeeded");
    expect(calls).toHaveLength(1);
    expect(calls[0]!.args).toContain("first");
    expect(harness.active).toBeNull();
  });

  it("rejects bad names, unknown env keys, and concurrent runs", async () => {
    const { harness } = build();
    await expect(
      harness.start({ name: "../escape" }),
    ).rejects.toBeInstanceOf(LabValidationError);
    await expect(
      harness.start({ env: { NOT_A_KEY: "1" }, name: "bad" }),
    ).rejects.toBeInstanceOf(LabValidationError);
    const finished = waitForDone(harness);
    await harness.start({ name: "first", stub: true });
    await expect(harness.start({ name: "second" })).rejects.toBeInstanceOf(
      LabRunActiveError,
    );
    await finished;
  });
});
