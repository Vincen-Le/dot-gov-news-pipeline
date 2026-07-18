import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import type { ChildProcess, spawn } from "node:child_process";
import { afterEach, describe, expect, it, vi } from "vitest";

import { WorkerTail } from "../src/tail-process";

function fakeChild(): ChildProcess {
  const child = new EventEmitter() as ChildProcess;
  Object.assign(child, {
    kill: vi.fn(() => {
      queueMicrotask(() => child.emit("close", 0, null));
      return true;
    }),
    stderr: new PassThrough(),
    stdout: new PassThrough(),
  });
  return child;
}

afterEach(() => vi.useRealTimers());

describe("Wrangler tail process lifecycle", () => {
  it("clears failed spawn state and reconnects", async () => {
    vi.useFakeTimers();
    const children = [fakeChild(), fakeChild()];
    const spawnProcess = vi.fn(() => children.shift() ?? fakeChild());
    const tail = new WorkerTail(
      { workerName: "pipeline-worker" },
      spawnProcess as unknown as typeof spawn,
    );
    const errors: Error[] = [];
    tail.on("error", (error: Error) => errors.push(error));

    tail.start();
    expect(tail.running).toBe(true);
    spawnProcess.mock.results[0]?.value.emit("error", new Error("ENOENT"));
    expect(tail.running).toBe(false);
    expect(errors[0]?.message).toBe("ENOENT");

    await vi.advanceTimersByTimeAsync(2_000);
    expect(spawnProcess).toHaveBeenCalledTimes(2);
    expect(tail.running).toBe(true);
    await tail.stop();
    expect(tail.running).toBe(false);
  });
});
