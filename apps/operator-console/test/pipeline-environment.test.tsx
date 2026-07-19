// @vitest-environment jsdom
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { useExperimentRuns } from "../src/ui/experiment-view";
import {
  PipelineEnvironmentProvider,
  usePipelineEnvironment,
} from "../src/ui/pipeline-environment";

function jsonResponse(payload: unknown): Response {
  return new Response(JSON.stringify(payload), {
    headers: { "content-type": "application/json" },
    status: 200,
  });
}

function Probe() {
  const { pipeline, ready } = usePipelineEnvironment();
  const { experiments } = useExperimentRuns(pipeline, ready);
  return <span>{experiments.data?.items[0]?.name ?? "loading"}</span>;
}

afterEach(() => {
  cleanup();
  localStorage.clear();
  vi.restoreAllMocks();
});

describe("pipeline environment", () => {
  it("scopes the experiment catalog to the persisted pipeline", async () => {
    localStorage.setItem("ops-evaluation-pipeline", "simple_v1");
    const requests: string[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL) => {
        const url = String(input);
        requests.push(url);
        if (url === "/api/pipelines") {
          return jsonResponse({
            data: {
              pipelines: [
                { engine: "classic", name: "complex_v1" },
                { engine: "spine", name: "simple_v1" },
              ],
            },
          });
        }
        if (url === "/api/lab/p/simple_v1/experiments") {
          return jsonResponse({
            data: {
              active: null,
              items: [
                {
                  cacheHits: 0,
                  cacheMisses: 0,
                  clusterReport: null,
                  config: { engine: "spine" },
                  createdAt: "2026-07-19T00:00:00.000Z",
                  durationSeconds: 1,
                  finishedAt: "2026-07-19T00:00:01.000Z",
                  id: "00000000-0000-4000-8000-000000000001",
                  name: "spine-run",
                  snapshot: null,
                  startedAt: "2026-07-19T00:00:00.000Z",
                  summary: null,
                },
              ],
            },
          });
        }
        throw new Error(`unexpected request ${url}`);
      }),
    );

    const client = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    });
    render(
      <QueryClientProvider client={client}>
        <PipelineEnvironmentProvider>
          <Probe />
        </PipelineEnvironmentProvider>
      </QueryClientProvider>,
    );

    expect(await screen.findByText("spine-run")).toBeInTheDocument();
    expect(requests).toContain("/api/lab/p/simple_v1/experiments");
    expect(requests).not.toContain("/api/lab/experiments");
  });
});
