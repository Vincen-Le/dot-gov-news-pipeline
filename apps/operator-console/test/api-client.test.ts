import { afterEach, describe, expect, it, vi } from "vitest";

import { OperatorApiClient, type OperatorApiError } from "../src/api-client";

const token = "test-operator-token-that-is-long-enough";

const capabilities = {
  artifacts: { status: "available" },
  discovery: { reason: "Migration required", status: "not_enabled" },
  entries: { reason: "Not implemented", status: "not_enabled" },
  events: { status: "available" },
  feeds: { reason: "Not implemented", status: "not_enabled" },
  inventory: { status: "available" },
  polling: { reason: "Not implemented", status: "not_enabled" },
  queues: { status: "available" },
  ranking: { reason: "Not implemented", status: "not_enabled" },
  workerHealth: { status: "available" },
} as const;

function makeClient() {
  return new OperatorApiClient({
    apiToken: token,
    apiUrl: "https://operator.example",
    environment: "test",
    workerName: "pipeline-worker",
  });
}

afterEach(() => vi.unstubAllGlobals());

describe("typed Operator API client", () => {
  it("authenticates server-side and validates response contracts", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      Response.json({
        data: { capabilities },
        meta: {
          capabilities,
          environment: "test",
          generatedAt: "2026-07-17T16:00:00.000Z",
          sources: [],
          warnings: [],
        },
      }),
    );
    vi.stubGlobal("fetch", fetchMock);

    const result = await makeClient().capabilities();

    expect(result.data.capabilities.discovery.status).toBe("not_enabled");
    expect(fetchMock).toHaveBeenCalledWith(
      new URL("https://operator.example/ops/v1/capabilities"),
      expect.objectContaining({
        headers: expect.objectContaining({ authorization: `Bearer ${token}` }),
      }),
    );
  });

  it("maps sanitized API failures to stable errors", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        Response.json(
          {
            error: {
              code: "operator_api_disabled",
              message: "Operator API is disabled",
              retryable: false,
            },
            meta: { generatedAt: "2026-07-17T16:00:00.000Z" },
          },
          { status: 503 },
        ),
      ),
    );

    await expect(makeClient().capabilities()).rejects.toEqual(
      expect.objectContaining<Partial<OperatorApiError>>({
        code: "operator_api_disabled",
        status: 503,
      }),
    );
  });
});
