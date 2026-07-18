import {
  ComponentHealthSchema,
  type ComponentHealth,
  type QueueMetric,
} from "@dot-gov-news/contracts";

import type { OperatorEnv } from "./env";
import type { OperatorRepository } from "./repository";

export interface HealthResult {
  components: ComponentHealth[];
  status: "healthy" | "degraded" | "failed";
}

function elapsed(startedAt: number): number {
  return Math.max(0, Math.round(performance.now() - startedAt));
}

function component(input: Omit<ComponentHealth, "checkedAt">): ComponentHealth {
  return ComponentHealthSchema.parse({
    ...input,
    checkedAt: new Date().toISOString(),
  });
}

export async function readInventoryHealth(
  repository: OperatorRepository,
): Promise<{
  component: ComponentHealth;
  inventory: Awaited<
    ReturnType<OperatorRepository["getInventorySummary"]>
  > | null;
}> {
  const startedAt = performance.now();
  try {
    const inventory = await repository.getInventorySummary();
    return {
      component: component({
        latencyMs: elapsed(startedAt),
        message: null,
        name: "supabase",
        status: "healthy",
      }),
      inventory,
    };
  } catch {
    return {
      component: component({
        latencyMs: elapsed(startedAt),
        message: "Inventory summary read failed",
        name: "supabase",
        status: "failed",
      }),
      inventory: null,
    };
  }
}

async function checkPipelineWorker(env: OperatorEnv): Promise<ComponentHealth> {
  const startedAt = performance.now();
  if (env.PIPELINE_WORKER === undefined) {
    return component({
      latencyMs: null,
      message: "Service Binding is unavailable",
      name: "pipeline_worker",
      status: "failed",
    });
  }

  try {
    const response = await env.PIPELINE_WORKER.fetch(
      new Request("https://pipeline.internal/health"),
    );
    let healthy = false;
    if (response.ok) {
      const payload = (await response.json()) as {
        bindings?: Record<string, unknown>;
        discovery?: Record<string, unknown>;
        status?: unknown;
      };
      const bindings = payload.bindings;
      const discovery = payload.discovery;
      healthy =
        payload.status === "ok" &&
        bindings?.artifacts === true &&
        bindings.discoveryQueue === true &&
        bindings.eventQueue === true &&
        bindings.supabase === true &&
        discovery?.configValid === true &&
        (discovery.enabled !== true || discovery.contactConfigured === true);
    }
    return component({
      latencyMs: elapsed(startedAt),
      message: healthy ? null : "Pipeline Worker health check failed",
      name: "pipeline_worker",
      status: healthy ? "healthy" : "failed",
    });
  } catch {
    return component({
      latencyMs: elapsed(startedAt),
      message: "Pipeline Worker is unreachable",
      name: "pipeline_worker",
      status: "failed",
    });
  }
}

function queueComponent(
  name: "main_queue" | "main_dlq",
  metric: QueueMetric | undefined,
): ComponentHealth {
  return component({
    latencyMs: null,
    message:
      metric?.state === "available" ? null : "Queue metrics are unavailable",
    name,
    status: metric?.state === "available" ? "healthy" : "failed",
  });
}

async function checkR2(
  env: OperatorEnv,
  repository: OperatorRepository,
  depth: "shallow" | "deep",
): Promise<ComponentHealth> {
  if (env.ARTIFACTS === undefined) {
    return component({
      latencyMs: null,
      message: "R2 binding is unavailable",
      name: "r2",
      status: "failed",
    });
  }
  if (depth === "shallow") {
    return component({
      latencyMs: null,
      message: "Binding configured; object verification requires deep health",
      name: "r2",
      status: "healthy",
    });
  }

  const startedAt = performance.now();
  try {
    const latest = await repository.getLatestSuccessfulInventoryRun();
    if (latest?.rawArtifactKey === null || latest === null) {
      return component({
        latencyMs: elapsed(startedAt),
        message: "Latest inventory run has no artifact",
        name: "r2",
        status: "degraded",
      });
    }
    const object = await env.ARTIFACTS.head(latest.rawArtifactKey);
    return component({
      latencyMs: elapsed(startedAt),
      message: object === null ? "Latest inventory artifact is missing" : null,
      name: "r2",
      status: object === null ? "failed" : "healthy",
    });
  } catch {
    return component({
      latencyMs: elapsed(startedAt),
      message: "R2 artifact verification failed",
      name: "r2",
      status: "failed",
    });
  }
}

export async function getSystemHealth(
  env: OperatorEnv,
  repository: OperatorRepository,
  queueMetrics: QueueMetric[],
  depth: "shallow" | "deep",
  observedSupabase?: ComponentHealth,
): Promise<HealthResult> {
  const [supabase, pipelineWorker, r2] = await Promise.all([
    observedSupabase ??
      readInventoryHealth(repository).then((result) => result.component),
    checkPipelineWorker(env),
    checkR2(env, repository, depth),
  ]);
  const components = [
    component({
      latencyMs: 0,
      message: null,
      name: "operator_api",
      status: "healthy",
    }),
    pipelineWorker,
    supabase,
    r2,
    queueComponent("main_queue", queueMetrics[0]),
    queueComponent("main_dlq", queueMetrics[1]),
  ];
  const failed = components.filter((item) => item.status === "failed").length;
  const degraded = components.some((item) => item.status === "degraded");

  return {
    components,
    status:
      failed === 0 && !degraded
        ? "healthy"
        : failed >= 3
          ? "failed"
          : "degraded",
  };
}
