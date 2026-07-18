// @vitest-environment jsdom
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { afterEach, describe, expect, it, vi } from "vitest";

import { StorylinesPage } from "../src/ui/pages/StorylinesPage";

function jsonResponse(payload: unknown): Response {
  return new Response(JSON.stringify(payload), {
    headers: { "content-type": "application/json" },
    status: 200,
  });
}

afterEach(() => {
  vi.restoreAllMocks();
});

function renderPage(): void {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  render(
    <QueryClientProvider client={client}>
      <MemoryRouter initialEntries={["/storylines"]}>
        <StorylinesPage />
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

describe("StorylinesPage", () => {
  it("renders chains from the lab api", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL) => {
        const url = String(input);
        if (url.includes("/api/lab/capability")) {
          return jsonResponse({
            data: { experimentsEnabled: true, status: "available" },
          });
        }
        if (url.includes("/api/lab/metrics")) {
          return jsonResponse({
            data: {
              attachMix: [],
              calibration: {
                pairCount: 0,
                percentiles: {},
                suggestedNearDupThreshold: null,
              },
              capturedAt: "2026-07-18T12:00:00.000Z",
              entriesPerEpisode: [],
              episodesPerStoryline: [],
              similarity: [],
              singletonEpisodeRate: null,
              storylineAttachMix: [],
              syndicationRate: null,
              topChains: [],
              volume: {
                cards: 4,
                entries: 12,
                episodes: 3,
                multiEpisodeStorylines: 1,
                storylines: 2,
              },
            },
          });
        }
        return jsonResponse({
          data: {
            items: [
              {
                agencies: ["fda.gov"],
                distinctFeeds: 2,
                entities: ["valsatrex"],
                entryCount: 5,
                episodeCount: 2,
                eventKeys: ["z-2026-0143"],
                firstEntryAt: "2026-05-14T14:00:00.000Z",
                headline: "Valsatrex recall chain",
                id: "00000000-0000-4000-8000-000000000021",
                newestEntryAt: "2026-05-17T15:00:00.000Z",
              },
            ],
          },
        });
      }),
    );
    renderPage();
    expect(
      await screen.findByText("Valsatrex recall chain"),
    ).toBeInTheDocument();
    expect(await screen.findByText("z-2026-0143")).toBeInTheDocument();
  });

  it("renders the not-enabled state honestly", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL) => {
        if (String(input).includes("/api/lab/capability")) {
          return jsonResponse({
            data: {
              experimentsEnabled: false,
              reason: "Set DATABASE_URL",
              status: "not_enabled",
            },
          });
        }
        return new Response(
          JSON.stringify({
            error: { code: "not_enabled", message: "Set DATABASE_URL" },
          }),
          { status: 503 },
        );
      }),
    );
    renderPage();
    expect(await screen.findByText(/Set DATABASE_URL/)).toBeInTheDocument();
  });
});
