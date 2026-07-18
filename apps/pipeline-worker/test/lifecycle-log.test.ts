import { describe, expect, it, vi } from "vitest";

import {
  createLifecycleLog,
  logLifecycle,
} from "../src/observability/lifecycle-log";

describe("Worker lifecycle logs", () => {
  it("creates a versioned bounded structured record", () => {
    expect(
      createLifecycleLog({
        action: "persist_event",
        correlationId: "8ae940f1-c65c-424c-97bd-c177d88320c3",
        durationMs: 42,
        entityType: "event",
        occurredAt: "2026-07-17T16:00:00.000Z",
        outcome: "succeeded",
        stage: "storage",
      }),
    ).toMatchObject({
      logMarker: "worker_lifecycle",
      outcome: "succeeded",
      schemaVersion: 1,
    });
  });

  it("routes retry records to structured error logging", () => {
    const error = vi
      .spyOn(console, "error")
      .mockImplementation(() => undefined);

    logLifecycle({
      action: "persist_event",
      attempt: 2,
      correlationId: "queue-message",
      detail: "ProviderError",
      entityType: "event",
      outcome: "retried",
      stage: "storage",
    });

    expect(error).toHaveBeenCalledWith(
      expect.objectContaining({
        detail: "ProviderError",
        logMarker: "worker_lifecycle",
      }),
    );
  });
});
