import { describe, expect, it } from "vitest";

import {
  InventorySitesQuerySchema,
  InventorySummarySchema,
  OperatorErrorResponseSchema,
  operatorResponseSchema,
} from "../src/operator-api";

const capabilities = {
  artifacts: { status: "available" },
  discovery: {
    reason: "Migration 00400 is not installed",
    status: "not_enabled",
  },
  entries: {
    reason: "Entry ingestion is not implemented",
    status: "not_enabled",
  },
  events: { status: "available" },
  feeds: { reason: "Feed storage is not installed", status: "not_enabled" },
  inventory: { status: "available" },
  polling: { reason: "Polling is not implemented", status: "not_enabled" },
  queues: { status: "available" },
  ranking: { reason: "Ranking is not implemented", status: "not_enabled" },
  workerHealth: { status: "available" },
} as const;

describe("operator API contracts", () => {
  it("validates a typed response envelope", () => {
    const schema = operatorResponseSchema(InventorySummarySchema);

    expect(
      schema.parse({
        data: {
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
        },
        meta: {
          capabilities,
          environment: "development",
          generatedAt: "2026-07-17T16:00:01.000Z",
          sources: [
            {
              name: "supabase",
              observedAt: "2026-07-17T16:00:01.000Z",
              state: "fresh",
            },
          ],
          warnings: [],
        },
      }).data.totalCount,
    ).toBe(11);
  });

  it("rejects unknown fields and oversized limits", () => {
    expect(() =>
      InventorySitesQuerySchema.parse({ limit: "251", surprise: "value" }),
    ).toThrow();
  });

  it("coerces safe list query values", () => {
    expect(
      InventorySitesQuerySchema.parse({ active: "true", limit: "25" }),
    ).toMatchObject({ active: "true", all: "false", limit: 25 });
  });

  it("does not allow provider details in error responses", () => {
    expect(() =>
      OperatorErrorResponseSchema.parse({
        error: {
          code: "provider_failed",
          message: "Provider request failed",
          rawError: "secret response body",
          retryable: true,
        },
        meta: { generatedAt: "2026-07-17T16:00:01.000Z" },
      }),
    ).toThrow();
  });
});
