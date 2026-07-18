import type {
  OperatorCapabilities,
  OperatorMeta,
  OperatorSourceObservation,
} from "@dot-gov-news/contracts";

import type { OperatorEnv } from "./env";

const notEnabled = (reason: string) =>
  ({ reason, status: "not_enabled" }) as const;

export function getCapabilities(env: OperatorEnv): OperatorCapabilities {
  return {
    artifacts:
      env.ARTIFACTS === undefined
        ? { reason: "R2 binding is unavailable", status: "unavailable" }
        : { status: "available" },
    discovery: notEnabled(
      "Discovery processing exists; operator summary and active-lease read models require migration 00500",
    ),
    entries: notEnabled("Entry ingestion is not implemented"),
    events: { status: "available" },
    feeds: notEnabled(
      "Canonical feed storage exists; bounded Operator API feed reads are not implemented",
    ),
    inventory: { status: "available" },
    polling: notEnabled("Feed polling is not implemented"),
    queues:
      env.MAIN_QUEUE === undefined || env.MAIN_DLQ === undefined
        ? {
            reason: "One or more Queue bindings are unavailable",
            status: "unavailable",
          }
        : { status: "available" },
    ranking: notEnabled("Ranking is not implemented"),
    workerHealth:
      env.PIPELINE_WORKER === undefined
        ? {
            reason: "Pipeline Worker binding is unavailable",
            status: "unavailable",
          }
        : { status: "available" },
  };
}

export function buildMeta(
  env: OperatorEnv,
  sources: OperatorSourceObservation[],
  warnings: OperatorMeta["warnings"] = [],
): OperatorMeta {
  return {
    capabilities: getCapabilities(env),
    environment: env.ENVIRONMENT ?? "development",
    generatedAt: new Date().toISOString(),
    sources,
    warnings,
  };
}
