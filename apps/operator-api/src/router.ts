import {
  CapabilitiesDataSchema,
  GovernmentSiteListDataSchema,
  HealthDataSchema,
  InventoryRunListDataSchema,
  InventoryRunsQuerySchema,
  InventorySitesQuerySchema,
  InventorySummaryDataSchema,
  OverviewDataSchema,
  PipelineEventListDataSchema,
  PipelineEventsQuerySchema,
  QueueListDataSchema,
  SiteInspectorDataSchema,
} from "@dot-gov-news/contracts";
import { z } from "zod";

import { hasValidOperatorToken } from "./auth";
import { buildMeta, getCapabilities } from "./capabilities";
import type { OperatorEnv } from "./env";
import {
  getSystemHealth,
  readInventoryHealth,
  type HealthResult,
} from "./health";
import { errorResponse, HttpError, jsonResponse, parseQuery } from "./http";
import { getQueueMetrics } from "./queue-metrics";
import {
  createOperatorRepository,
  type OperatorRepository,
} from "./repository";

export interface OperatorServices {
  queueMetrics: typeof getQueueMetrics;
  repository: OperatorRepository;
}

function sourcesFor(
  names: Array<"supabase" | "cloudflare_queue" | "pipeline_worker" | "r2">,
) {
  const observedAt = new Date().toISOString();
  return names.map((name) => ({
    name,
    observedAt,
    state: "fresh" as const,
  }));
}

function sourcesFromHealth(
  health: HealthResult,
  queues: Awaited<ReturnType<typeof getQueueMetrics>>,
) {
  const observedAt = new Date().toISOString();
  const componentState = (name: "pipeline_worker" | "supabase" | "r2") => {
    const status = health.components.find((item) => item.name === name)?.status;
    return status === "healthy"
      ? ("fresh" as const)
      : status === "degraded"
        ? ("stale" as const)
        : ("unavailable" as const);
  };

  return [
    {
      name: "supabase" as const,
      observedAt,
      state: componentState("supabase"),
    },
    {
      name: "cloudflare_queue" as const,
      observedAt,
      state: queues.every((queue) => queue.state === "available")
        ? ("fresh" as const)
        : ("unavailable" as const),
    },
    {
      name: "pipeline_worker" as const,
      observedAt,
      state: componentState("pipeline_worker"),
    },
    { name: "r2" as const, observedAt, state: componentState("r2") },
  ];
}

function parsePathHostname(pathname: string): string | null {
  const match = /^\/ops\/v1\/sites\/([^/]+)$/u.exec(pathname);
  if (match?.[1] === undefined) {
    return null;
  }
  try {
    return decodeURIComponent(match[1]).toLowerCase();
  } catch {
    throw new HttpError(400, "invalid_hostname", "Hostname is invalid");
  }
}

function parseRouteQuery<T>(schema: z.ZodType<T>, url: URL): T {
  try {
    return schema.parse(parseQuery(url));
  } catch (error) {
    if (error instanceof z.ZodError) {
      throw new HttpError(400, "invalid_query", "Query parameters are invalid");
    }
    throw error;
  }
}

async function routeRequest(
  request: Request,
  env: OperatorEnv,
  services: OperatorServices,
): Promise<Response> {
  const url = new URL(request.url);
  const { pathname } = url;

  if (pathname === "/ops/v1/capabilities") {
    const data = CapabilitiesDataSchema.parse({
      capabilities: getCapabilities(env),
    });
    return jsonResponse({ data, meta: buildMeta(env, []) });
  }

  if (pathname === "/ops/v1/queues") {
    const queues = await services.queueMetrics(env);
    const data = QueueListDataSchema.parse({ queues });
    const unavailable = queues.some((queue) => queue.state === "unavailable");
    return jsonResponse({
      data,
      meta: buildMeta(
        env,
        [
          {
            name: "cloudflare_queue",
            observedAt: new Date().toISOString(),
            state: unavailable ? "unavailable" : "fresh",
          },
        ],
        unavailable
          ? [
              {
                code: "queue_metrics_unavailable",
                message: "One or more Queue metrics could not be read",
                source: "cloudflare_queue",
              },
            ]
          : [],
      ),
    });
  }

  if (pathname === "/ops/v1/inventory/summary") {
    const [summary, latestRun] = await Promise.all([
      services.repository.getInventorySummary(),
      services.repository.getLatestInventoryRun(),
    ]);
    const data = InventorySummaryDataSchema.parse({ latestRun, summary });
    return jsonResponse({
      data,
      meta: buildMeta(env, sourcesFor(["supabase"])),
    });
  }

  if (pathname === "/ops/v1/inventory/runs") {
    const query = parseRouteQuery(InventoryRunsQuerySchema, url);
    const data = InventoryRunListDataSchema.parse(
      await services.repository.listInventoryRuns(query),
    );
    return jsonResponse({
      data,
      meta: buildMeta(env, sourcesFor(["supabase"])),
    });
  }

  if (pathname === "/ops/v1/inventory/sites") {
    const query = parseRouteQuery(InventorySitesQuerySchema, url);
    const page = await services.repository.listGovernmentSites({
      active: query.active === undefined ? undefined : query.active === "true",
      agency: query.agency,
      all: query.all === "true",
      cursor: query.cursor,
      hostname: query.hostname,
      limit: query.limit,
    });
    const validated = GovernmentSiteListDataSchema.parse(page);
    return jsonResponse({
      data: validated,
      meta: buildMeta(env, sourcesFor(["supabase"])),
    });
  }

  if (pathname === "/ops/v1/events") {
    const query = parseRouteQuery(PipelineEventsQuerySchema, url);
    const data = PipelineEventListDataSchema.parse(
      await services.repository.listPipelineEvents(query),
    );
    return jsonResponse({
      data,
      meta: buildMeta(env, sourcesFor(["supabase"])),
    });
  }

  const hostname = parsePathHostname(pathname);
  if (hostname !== null) {
    const sites = await services.repository.listGovernmentSites({
      all: true,
      hostname,
      limit: 1,
    });
    const site = sites.items[0];
    if (site === undefined) {
      throw new HttpError(404, "site_not_found", "Site was not found");
    }
    const events = await services.repository.listPipelineEvents({
      entity: site.id,
      limit: 25,
    });
    const data = SiteInspectorDataSchema.parse({ events: events.items, site });
    return jsonResponse({
      data,
      meta: buildMeta(env, sourcesFor(["supabase"])),
    });
  }

  if (pathname === "/ops/v1/system/health") {
    const query = parseRouteQuery(
      z
        .object({ depth: z.enum(["shallow", "deep"]).default("shallow") })
        .strict(),
      url,
    );
    const queues = await services.queueMetrics(env);
    const health = await getSystemHealth(
      env,
      services.repository,
      queues,
      query.depth,
    );
    const data = HealthDataSchema.parse({ ...health, depth: query.depth });
    return jsonResponse({
      data,
      meta: buildMeta(env, sourcesFromHealth(health, queues)),
    });
  }

  if (pathname === "/ops/v1/overview") {
    const [inventoryResult, queues] = await Promise.all([
      readInventoryHealth(services.repository),
      services.queueMetrics(env),
    ]);
    const health = await getSystemHealth(
      env,
      services.repository,
      queues,
      "shallow",
      inventoryResult.component,
    );
    const data = OverviewDataSchema.parse({
      components: health.components,
      inventory: inventoryResult.inventory,
      queues,
    });
    return jsonResponse({
      data,
      meta: buildMeta(env, sourcesFromHealth(health, queues)),
    });
  }

  if (
    pathname.startsWith("/ops/v1/discovery") ||
    pathname.startsWith("/ops/v1/feeds") ||
    pathname.startsWith("/ops/v1/polling")
  ) {
    throw new HttpError(
      501,
      "not_enabled",
      "This pipeline capability is not enabled",
    );
  }

  throw new HttpError(404, "not_found", "Route was not found");
}

export async function handleOperatorRequest(
  request: Request,
  env: OperatorEnv,
  services?: OperatorServices,
): Promise<Response> {
  try {
    if (!(await hasValidOperatorToken(request, env))) {
      throw new HttpError(401, "unauthorized", "Authentication is required");
    }
    if (env.OPS_API_ENABLED !== "true") {
      throw new HttpError(
        503,
        "operator_api_disabled",
        "Operator API is disabled",
      );
    }
    if (request.method !== "GET") {
      throw new HttpError(405, "method_not_allowed", "Only GET is allowed");
    }

    return await routeRequest(
      request,
      env,
      services ?? {
        queueMetrics: getQueueMetrics,
        repository: createOperatorRepository(env),
      },
    );
  } catch (error) {
    if (error instanceof Error && error.message === "invalid_cursor") {
      return errorResponse(
        new HttpError(400, "invalid_cursor", "Cursor is invalid"),
      );
    }
    return errorResponse(error);
  }
}
