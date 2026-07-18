import type {
  GovernmentSite,
  InventoryRun,
  InventorySummary,
  PipelineEventRecord,
  QueueMetric,
} from "@dot-gov-news/contracts";
import { describe, expect, it, vi } from "vitest";

import type { OperatorEnv } from "../src/env";
import { handleOperatorRequest, type OperatorServices } from "../src/router";
import type { OperatorRepository } from "../src/repository";

const token = "test-operator-token-that-is-long-enough";

const summary: InventorySummary = {
  activeCount: 10,
  discoveryBackoffCount: 1,
  discoveryLeasedCount: 2,
  discoveryPendingCount: 7,
  gsaFilteredCount: 0,
  inactiveCount: 1,
  ingestionExcludedCount: 1,
  latestSourceSha256: "a".repeat(64),
  latestSuccessAt: "2026-07-17T16:00:00.000Z",
  totalCount: 11,
  usableCount: 9,
};

const latestRun: InventoryRun = {
  completedAt: "2026-07-17T16:00:00.000Z",
  counts: {
    deactivated: 1,
    eligible: 9,
    inserted: 2,
    reactivated: 0,
    sourceRows: 11,
    staged: 11,
    updated: 3,
  },
  errorCode: null,
  id: "8ae940f1-c65c-424c-97bd-c177d88320c3",
  rawArtifactKey: "inventory/gsa/latest.csv",
  source: "gsa_federal_website_index",
  sourceEtag: "etag",
  sourceSha256: "a".repeat(64),
  startedAt: "2026-07-17T15:59:00.000Z",
  status: "succeeded",
};

function makeEnv(overrides: Partial<OperatorEnv> = {}): OperatorEnv {
  return {
    ARTIFACTS: { head: vi.fn().mockResolvedValue({ key: "artifact" }) },
    BUILD_VERSION: "test-build",
    ENVIRONMENT: "test",
    MAIN_DLQ: {},
    MAIN_QUEUE: {},
    OPS_API_ENABLED: "true",
    OPS_API_TOKEN: token,
    PIPELINE_WORKER: {
      fetch: vi.fn().mockResolvedValue(
        Response.json({
          bindings: {
            artifacts: true,
            discoveryQueue: true,
            eventQueue: true,
            supabase: true,
          },
          buildVersion: "test-build",
          discovery: {
            configValid: true,
            contactConfigured: false,
            enabled: false,
          },
          status: "ok",
        }),
      ),
    },
    SUPABASE_SECRET_KEY: "supabase-secret-must-not-leak",
    SUPABASE_URL: "https://project.supabase.co",
    ...overrides,
  } as unknown as OperatorEnv;
}

function makeRepository(): OperatorRepository {
  return {
    getInventorySummary: vi.fn().mockResolvedValue(summary),
    getLatestInventoryRun: vi.fn().mockResolvedValue(latestRun),
    getLatestSuccessfulInventoryRun: vi.fn().mockResolvedValue(latestRun),
    listGovernmentSites: vi.fn().mockResolvedValue({
      items: [] satisfies GovernmentSite[],
      nextCursor: null,
    }),
    listInventoryRuns: vi.fn().mockResolvedValue({
      items: [latestRun],
      nextCursor: null,
    }),
    listPipelineEvents: vi.fn().mockResolvedValue({
      items: [] satisfies PipelineEventRecord[],
      nextCursor: null,
    }),
  };
}

function makeServices(
  overrides: Partial<OperatorServices> = {},
): OperatorServices {
  const queues: QueueMetric[] = [
    {
      backlogBytes: 256,
      backlogCount: 2,
      name: "pipeline-events",
      observedAt: "2026-07-17T16:00:00.000Z",
      oldestMessageAt: "2026-07-17T15:59:58.000Z",
      state: "available",
    },
    {
      backlogBytes: 0,
      backlogCount: 0,
      name: "pipeline-events-dlq",
      observedAt: "2026-07-17T16:00:00.000Z",
      oldestMessageAt: null,
      state: "available",
    },
  ];
  return {
    queueMetrics: vi.fn().mockResolvedValue(queues),
    repository: makeRepository(),
    ...overrides,
  };
}

function request(path: string, options: RequestInit = {}): Request {
  return new Request(`https://operator.example${path}`, {
    ...options,
    headers: { authorization: `Bearer ${token}`, ...options.headers },
  });
}

describe("operator API", () => {
  it("requires authentication before returning route information", async () => {
    const response = await handleOperatorRequest(
      new Request("https://operator.example/ops/v1/capabilities"),
      makeEnv(),
      makeServices(),
    );

    expect(response.status).toBe(401);
    expect(await response.json()).toMatchObject({
      error: { code: "unauthorized" },
    });
  });

  it("can be disabled without affecting the pipeline worker", async () => {
    const response = await handleOperatorRequest(
      request("/ops/v1/capabilities"),
      makeEnv({ OPS_API_ENABLED: "false" }),
      makeServices(),
    );

    expect(response.status).toBe(503);
    expect(await response.json()).toMatchObject({
      error: { code: "operator_api_disabled" },
    });
  });

  it("returns capability gates instead of fabricated zeroes", async () => {
    const response = await handleOperatorRequest(
      request("/ops/v1/capabilities"),
      makeEnv(),
      makeServices(),
    );
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body).toMatchObject({
      data: {
        capabilities: {
          discovery: { status: "not_enabled" },
          inventory: { status: "available" },
          polling: { status: "not_enabled" },
        },
      },
    });
  });

  it("returns validated inventory state without secrets", async () => {
    const env = makeEnv();
    const response = await handleOperatorRequest(
      request("/ops/v1/inventory/summary"),
      env,
      makeServices(),
    );
    const body = await response.text();

    expect(response.status).toBe(200);
    expect(body).toContain('"totalCount":11');
    expect(body).not.toContain(env.SUPABASE_SECRET_KEY);
    expect(body).not.toContain(env.OPS_API_TOKEN);
    expect(response.headers.get("cache-control")).toBe("no-store");
  });

  it("rejects unknown and oversized query values", async () => {
    const response = await handleOperatorRequest(
      request("/ops/v1/inventory/runs?limit=251&surprise=true"),
      makeEnv(),
      makeServices(),
    );

    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({
      error: { code: "invalid_query" },
    });
  });

  it("rejects malformed inventory-site cursors before querying Supabase", async () => {
    const repository = makeRepository();
    const response = await handleOperatorRequest(
      request("/ops/v1/inventory/sites?cursor=not-a-uuid"),
      makeEnv(),
      makeServices({ repository }),
    );

    expect(response.status).toBe(400);
    expect(repository.listGovernmentSites).not.toHaveBeenCalled();
  });

  it("rejects mutation methods", async () => {
    const response = await handleOperatorRequest(
      request("/ops/v1/queues", { method: "POST" }),
      makeEnv(),
      makeServices(),
    );

    expect(response.status).toBe(405);
  });

  it("keeps Queue and Worker health visible when inventory is unavailable", async () => {
    const repository = makeRepository();
    vi.mocked(repository.getInventorySummary).mockRejectedValue(
      new Error("Supabase unavailable"),
    );
    const response = await handleOperatorRequest(
      request("/ops/v1/overview"),
      makeEnv(),
      makeServices({ repository }),
    );
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body).toMatchObject({
      data: {
        inventory: null,
        queues: expect.any(Array),
      },
    });
  });

  it("fails the Worker component when its HTTP 200 health payload is unhealthy", async () => {
    const env = makeEnv({
      PIPELINE_WORKER: {
        fetch: vi.fn().mockResolvedValue(
          Response.json({
            bindings: {
              artifacts: true,
              discoveryQueue: true,
              eventQueue: false,
              supabase: true,
            },
            discovery: {
              configValid: true,
              contactConfigured: false,
              enabled: false,
            },
            status: "ok",
          }),
        ),
      } as unknown as Fetcher,
    });
    const response = await handleOperatorRequest(
      request("/ops/v1/system/health?depth=deep"),
      env,
      makeServices(),
    );
    const body = await response.json();

    expect(body).toMatchObject({
      data: {
        components: expect.arrayContaining([
          expect.objectContaining({
            name: "pipeline_worker",
            status: "failed",
          }),
        ]),
      },
    });
  });

  it("classifies provider response validation failures as retryable 503s", async () => {
    const repository = makeRepository();
    vi.mocked(repository.listInventoryRuns).mockResolvedValue({
      items: [{ status: "corrupt" } as unknown as InventoryRun],
      nextCursor: null,
    });
    const response = await handleOperatorRequest(
      request("/ops/v1/inventory/runs"),
      makeEnv(),
      makeServices({ repository }),
    );

    expect(response.status).toBe(503);
    expect(await response.json()).toMatchObject({
      error: { code: "provider_unavailable", retryable: true },
    });
  });
});
