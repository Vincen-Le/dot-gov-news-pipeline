// apps/operator-console/src/lab/routes.ts
import express, { type Request, type Response, Router } from "express";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { z } from "zod";

import type { LabCapability } from "./contracts";
import {
  LabRunActiveError,
  LabValidationError,
  type ExperimentHarness,
} from "./harness";
import type { LabelStore, RankLabelStore } from "./labels";
import type { LabQueries } from "./queries";
import type { RankQueries } from "./rank-queries";

export interface LabRouteDeps {
  capability: () => Promise<LabCapability>;
  harness: ExperimentHarness | null;
  labels: LabelStore;
  queries: LabQueries | null;
  rankLabels?: RankLabelStore;
  rankQueries?: RankQueries | null;
  repoRoot: string;
}

const UUID = z.uuid();
const REPORT_NAME = /^[a-z0-9][a-z0-9._-]{0,63}$/i;

const LabelBodySchema = z.object({
  entryA: z.uuid(),
  entryB: z.uuid(),
  sameEvent: z.boolean(),
});

const RankLabelBodySchema = z.object({
  preferred: z.enum(["a", "b"]),
  runId: z.uuid(),
  storylineA: z.uuid(),
  storylineB: z.uuid(),
});

const RunBodySchema = z.object({
  clearFeatures: z.boolean().optional(),
  env: z.record(z.string(), z.string()).optional(),
  limit: z.number().int().min(1).max(1_000_000).nullable().optional(),
  name: z.string().trim().min(1).max(64),
  noCache: z.boolean().optional(),
  prepare: z.boolean().optional(),
  stub: z.boolean().optional(),
  until: z.string().max(64).nullable().optional(),
});

function sendError(
  response: Response,
  status: number,
  code: string,
  message: string,
): void {
  response.status(status).json({ error: { code, message } });
}

export function createLabRouter(deps: LabRouteDeps): Router {
  const router = Router();
  router.use(express.json({ limit: "64kb" }));

  const requireQueries = async (
    response: Response,
  ): Promise<LabQueries | null> => {
    const capability = await deps.capability();
    if (deps.queries !== null && capability.status === "available") {
      return deps.queries;
    }
    sendError(
      response,
      503,
      "not_enabled",
      capability.reason ?? "Clustering lab is not enabled",
    );
    return null;
  };

  const viewQueries = async (
    request: Request,
    response: Response,
  ): Promise<LabQueries | null> => {
    const queries = await requireQueries(response);
    if (queries === null) return null;
    if (request.query.experiment === undefined) return queries;
    const experiment = UUID.safeParse(request.query.experiment);
    if (!experiment.success) {
      sendError(response, 400, "bad_request", "experiment must be a uuid");
      return null;
    }
    const run = await queries.experimentRun(experiment.data);
    if (run?.snapshot === null || run === null) {
      sendError(
        response,
        404,
        "not_found",
        "Unknown or uncaptured experiment run",
      );
      return null;
    }
    return queries.forExperiment(experiment.data);
  };

  const handle =
    (run: (request: Request, response: Response) => Promise<void>) =>
    (request: Request, response: Response): void => {
      void run(request, response).catch((error: unknown) => {
        if (!response.headersSent) {
          sendError(
            response,
            500,
            "lab_error",
            error instanceof Error ? error.message : "Unexpected lab failure",
          );
        }
      });
    };

  router.get(
    "/capability",
    handle(async (_request, response) => {
      response.json({ data: await deps.capability() });
    }),
  );

  router.get(
    "/corpus",
    handle(async (_request, response) => {
      const queries = await requireQueries(response);
      if (queries === null) return;
      response.json({ data: await queries.corpusSummary() });
    }),
  );

  router.get(
    "/metrics",
    handle(async (request, response) => {
      const queries = await viewQueries(request, response);
      if (queries === null) return;
      const { snapshotLabMetrics } = await import("./metrics");
      response.json({ data: await snapshotLabMetrics(queries) });
    }),
  );

  router.get(
    "/storylines",
    handle(async (request, response) => {
      const queries = await viewQueries(request, response);
      if (queries === null) return;
      const asString = (value: unknown): string | undefined =>
        typeof value === "string" && value.length > 0 ? value : undefined;
      const asNumber = (value: unknown): number | undefined => {
        const parsed = Number(asString(value));
        return Number.isFinite(parsed) ? parsed : undefined;
      };
      // fetch one row past the page so hasMore is exact without a count query
      const requested = Math.min(asNumber(request.query.limit) ?? 50, 500);
      const rows = await queries.storylines({
        agency: asString(request.query.agency),
        category: asString(request.query.category),
        entity: asString(request.query.entity),
        groupBy:
          request.query.groupBy === "category" ||
          request.query.groupBy === "theme"
            ? request.query.groupBy
            : undefined,
        limit: requested + 1,
        minEpisodes: asNumber(request.query.minEpisodes),
        offset: Math.max(asNumber(request.query.offset) ?? 0, 0),
        sort: request.query.sort === "episodes" ? "episodes" : undefined,
        theme: asString(request.query.theme),
      });
      response.json({
        data: {
          hasMore: rows.length > requested,
          items: rows.slice(0, requested),
        },
      });
    }),
  );

  const requireRankQueries = async (
    response: Response,
  ): Promise<RankQueries | null> => {
    const capability = await deps.capability();
    if (
      deps.rankQueries !== null &&
      deps.rankQueries !== undefined &&
      capability.status === "available"
    ) {
      return deps.rankQueries;
    }
    sendError(
      response,
      503,
      "not_enabled",
      capability.reason ?? "Rank observability is not enabled",
    );
    return null;
  };

  const rankFacetParams = (
    request: Request,
  ): { facetKey: string; facetType: string; run: string } | null => {
    const run = UUID.safeParse(request.query.run);
    if (!run.success) return null;
    const facetType =
      typeof request.query.facetType === "string" &&
      request.query.facetType.length > 0
        ? request.query.facetType
        : "global";
    const facetKey =
      typeof request.query.facetKey === "string" ? request.query.facetKey : "";
    return { facetKey, facetType, run: run.data };
  };

  router.get(
    "/rank/facets",
    handle(async (request, response) => {
      const rank = await requireRankQueries(response);
      if (rank === null) return;
      const run = UUID.safeParse(request.query.run);
      if (!run.success) {
        sendError(response, 400, "bad_request", "run must be a uuid");
        return;
      }
      response.json({ data: { facets: await rank.rankFacets(run.data) } });
    }),
  );

  router.get(
    "/rank/snapshot",
    handle(async (request, response) => {
      const rank = await requireRankQueries(response);
      if (rank === null) return;
      const params = rankFacetParams(request);
      if (params === null) {
        sendError(response, 400, "bad_request", "run must be a uuid");
        return;
      }
      const limitRaw = Number(request.query.limit);
      const limit = Number.isFinite(limitRaw)
        ? Math.min(Math.max(Math.trunc(limitRaw), 1), 200)
        : 50;
      response.json({
        data: {
          rows: await rank.rankSnapshot(
            params.run,
            params.facetType,
            params.facetKey,
            limit,
          ),
        },
      });
    }),
  );

  router.get(
    "/rank/audit",
    handle(async (request, response) => {
      const rank = await requireRankQueries(response);
      if (rank === null) return;
      const params = rankFacetParams(request);
      if (params === null) {
        sendError(response, 400, "bad_request", "run must be a uuid");
        return;
      }
      response.json({
        data: {
          pairs: await rank.rankAuditPairs(
            params.run,
            params.facetType,
            params.facetKey,
          ),
        },
      });
    }),
  );

  router.get(
    "/rank/audit-runs",
    handle(async (request, response) => {
      const rank = await requireRankQueries(response);
      if (rank === null) return;
      const run = UUID.safeParse(request.query.run);
      if (!run.success) {
        sendError(response, 400, "bad_request", "run must be a uuid");
        return;
      }
      response.json({
        data: { auditRuns: await rank.rankAuditRuns(run.data) },
      });
    }),
  );

  router.post(
    "/rank/labels",
    handle(async (request, response) => {
      if (deps.rankLabels === undefined) {
        sendError(response, 503, "not_enabled", "Rank labels are not enabled");
        return;
      }
      const body = RankLabelBodySchema.safeParse(request.body);
      if (!body.success) {
        sendError(response, 400, "bad_request", "Invalid rank label body");
        return;
      }
      await deps.rankLabels.appendLabel(body.data);
      response.json({ data: { ok: true } });
    }),
  );

  router.get(
    "/agencies",
    handle(async (request, response) => {
      const queries = await viewQueries(request, response);
      if (queries === null) return;
      response.json({ data: { agencies: await queries.storylineAgencies() } });
    }),
  );

  router.get(
    "/topics/themes",
    handle(async (request, response) => {
      const queries = await viewQueries(request, response);
      if (queries === null) return;
      const category =
        typeof request.query.category === "string" &&
        request.query.category.length > 0
          ? request.query.category
          : undefined;
      response.json({
        data: { themes: await queries.topicThemes({ category }) },
      });
    }),
  );

  router.get(
    "/topics/categories",
    handle(async (request, response) => {
      const queries = await viewQueries(request, response);
      if (queries === null) return;
      response.json({
        data: { categories: await queries.topicCategories() },
      });
    }),
  );

  router.get(
    "/storylines/:id",
    handle(async (request, response) => {
      const queries = await viewQueries(request, response);
      if (queries === null) return;
      const id = UUID.safeParse(request.params.id);
      const detail = id.success ? await queries.storylineDetail(id.data) : null;
      if (detail === null) {
        sendError(response, 404, "not_found", "Unknown storyline");
        return;
      }
      response.json({ data: detail });
    }),
  );

  router.get(
    "/borderline",
    handle(async (request, response) => {
      const queries = await viewQueries(request, response);
      if (queries === null) return;
      const window = Number(request.query.window ?? 0.03);
      const limit = Number(request.query.limit ?? 100);
      response.json({
        data: {
          items: await queries.borderlinePairs(
            Number.isFinite(window) ? window : 0.03,
            Number.isFinite(limit) ? limit : 100,
          ),
        },
      });
    }),
  );

  router.get(
    "/labels",
    handle(async (_request, response) => {
      const labels = await deps.labels.readLabels();
      response.json({ data: { count: labels.length, labels } });
    }),
  );

  router.post(
    "/labels",
    handle(async (request, response) => {
      const body = LabelBodySchema.safeParse(request.body);
      if (!body.success) {
        sendError(
          response,
          400,
          "invalid_request",
          "entryA/entryB must be entry UUIDs and sameEvent a boolean",
        );
        return;
      }
      await deps.labels.appendLabel(body.data);
      response.status(201).json({ data: { saved: true } });
    }),
  );

  router.get(
    "/experiments",
    handle(async (_request, response) => {
      const queries = await requireQueries(response);
      if (queries === null) return;
      response.json({
        data: {
          active: deps.harness?.active ?? null,
          items: await queries.experimentRuns(),
        },
      });
    }),
  );

  router.post(
    "/experiments",
    handle(async (request, response) => {
      const capability = await deps.capability();
      if (deps.harness === null || !capability.experimentsEnabled) {
        sendError(
          response,
          503,
          "not_enabled",
          capability.experimentsReason ??
            capability.reason ??
            "Experiments are not enabled",
        );
        return;
      }
      const body = RunBodySchema.safeParse(request.body);
      if (!body.success) {
        sendError(
          response,
          400,
          "invalid_request",
          z.prettifyError(body.error),
        );
        return;
      }
      try {
        const active = await deps.harness.start(body.data);
        response.status(202).json({ data: active });
      } catch (error) {
        if (error instanceof LabRunActiveError) {
          sendError(response, 409, "run_active", error.message);
        } else if (error instanceof LabValidationError) {
          sendError(response, 400, "invalid_request", error.message);
        } else {
          throw error;
        }
      }
    }),
  );

  router.get(
    "/experiments/stream",
    handle(async (request, response) => {
      response.status(200);
      response.setHeader("content-type", "text/event-stream");
      response.setHeader("connection", "keep-alive");
      response.flushHeaders();
      response.write(
        `event: snapshot\ndata: ${JSON.stringify(deps.harness?.active ?? null)}\n\n`,
      );
      const unsubscribe =
        deps.harness?.onEvent((event) => {
          response.write(
            `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`,
          );
        }) ?? (() => undefined);
      request.on("close", unsubscribe);
    }),
  );

  router.get(
    "/experiments/:id",
    handle(async (request, response) => {
      const queries = await requireQueries(response);
      if (queries === null) return;
      const id = UUID.safeParse(request.params.id);
      const run = id.success ? await queries.experimentRun(id.data) : null;
      if (run === null) {
        sendError(response, 404, "not_found", "Unknown experiment run");
        return;
      }
      const reportAvailable =
        REPORT_NAME.test(run.name) &&
        existsSync(join(deps.repoRoot, "docs/eval", run.name, "report.md"));
      response.json({ data: { reportAvailable, run } });
    }),
  );

  router.get(
    "/experiments/:id/report",
    handle(async (request, response) => {
      const queries = await requireQueries(response);
      if (queries === null) return;
      const id = UUID.safeParse(request.params.id);
      const run = id.success ? await queries.experimentRun(id.data) : null;
      const path =
        run !== null && REPORT_NAME.test(run.name)
          ? join(deps.repoRoot, "docs/eval", run.name, "report.md")
          : null;
      if (path === null || !existsSync(path)) {
        sendError(response, 404, "not_found", "Report not found");
        return;
      }
      response.setHeader("content-type", "text/markdown; charset=utf-8");
      response.send(readFileSync(path, "utf8"));
    }),
  );

  return router;
}
