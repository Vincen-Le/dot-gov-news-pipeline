import { describe, expect, it } from "vitest";

import {
  parseWorkerLifecycleLog,
  WorkerLifecycleLogSchema,
} from "../src/operator-log";

describe("worker lifecycle log contract", () => {
  it("accepts bounded structured lifecycle data", () => {
    expect(
      parseWorkerLifecycleLog({
        action: "persist_event",
        attempt: 1,
        correlationId: "8ae940f1-c65c-424c-97bd-c177d88320c3",
        durationMs: 42,
        entityId: "nasa.gov",
        entityType: "event",
        logMarker: "worker_lifecycle",
        occurredAt: "2026-07-17T16:00:00.000Z",
        outcome: "succeeded",
        schemaVersion: 1,
        stage: "storage",
      }).outcome,
    ).toBe("succeeded");
  });

  it("rejects unknown fields that could leak secrets", () => {
    expect(
      WorkerLifecycleLogSchema.safeParse({
        action: "health",
        apiToken: "must-not-be-logged",
        correlationId: "health-check",
        logMarker: "worker_lifecycle",
        occurredAt: "2026-07-17T16:00:00.000Z",
        outcome: "succeeded",
        schemaVersion: 1,
        stage: "health",
      }).success,
    ).toBe(false);
  });

  it("rejects unbounded details", () => {
    expect(
      WorkerLifecycleLogSchema.safeParse({
        action: "fetch",
        correlationId: "correlation",
        detail: "x".repeat(513),
        logMarker: "worker_lifecycle",
        occurredAt: "2026-07-17T16:00:00.000Z",
        outcome: "failed",
        schemaVersion: 1,
        stage: "discovery",
      }).success,
    ).toBe(false);
  });
});
