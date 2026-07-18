import {
  WORKER_LIFECYCLE_LOG_SCHEMA_VERSION,
  WorkerLifecycleLogSchema,
  type WorkerLifecycleLog,
} from "@dot-gov-news/contracts";

type LifecycleLogInput = Omit<
  WorkerLifecycleLog,
  "logMarker" | "occurredAt" | "schemaVersion"
> & {
  occurredAt?: string;
};

export function createLifecycleLog(
  input: LifecycleLogInput,
): WorkerLifecycleLog {
  return WorkerLifecycleLogSchema.parse({
    ...input,
    logMarker: "worker_lifecycle",
    occurredAt: input.occurredAt ?? new Date().toISOString(),
    schemaVersion: WORKER_LIFECYCLE_LOG_SCHEMA_VERSION,
  });
}

export function logLifecycle(input: LifecycleLogInput): void {
  const entry = createLifecycleLog(input);
  if (entry.outcome === "failed" || entry.outcome === "retried") {
    console.error(entry);
  } else {
    console.log(entry);
  }
}
