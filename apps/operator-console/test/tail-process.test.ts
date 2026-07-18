import { describe, expect, it } from "vitest";

import {
  parseWorkerLifecycleTailLine,
  sanitizeTailValue,
} from "../src/tail-process";

describe("Wrangler tail adapter", () => {
  it("redacts credential-like fields recursively", () => {
    expect(
      sanitizeTailValue({
        authorization: "Bearer secret",
        nested: { apiToken: "secret", outcome: "succeeded" },
      }),
    ).toEqual({
      authorization: "[redacted]",
      nested: { apiToken: "[redacted]", outcome: "succeeded" },
    });
  });

  it("bounds oversized log strings", () => {
    expect(String(sanitizeTailValue("x".repeat(3_000)))).toHaveLength(2_001);
  });

  it("extracts normalized lifecycle records from Wrangler trace JSON", () => {
    const lifecycle = {
      action: "consume_event",
      correlationId: "event-1",
      entityId: "event-1",
      entityType: "event",
      logMarker: "worker_lifecycle",
      occurredAt: "2026-07-17T16:00:00.000Z",
      outcome: "succeeded",
      schemaVersion: 1,
      stage: "queue",
    };
    const trace = JSON.stringify({
      logs: [{ level: "log", message: [JSON.stringify(lifecycle)] }],
      outcome: "ok",
      scriptName: "dot-gov-news-pipeline-dev",
    });

    expect(parseWorkerLifecycleTailLine(trace)).toEqual([lifecycle]);
  });
});
