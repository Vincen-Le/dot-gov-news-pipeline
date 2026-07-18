// apps/operator-console/test/lab-page.test.tsx
// @vitest-environment jsdom
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { afterEach, describe, expect, it, vi } from "vitest";

import { LabPage } from "../src/ui/pages/LabPage";

function jsonResponse(payload: unknown): Response {
  return new Response(JSON.stringify(payload), {
    headers: { "content-type": "application/json" },
    status: 200,
  });
}

const RUNS = [
  {
    cacheHits: 2,
    cacheMisses: 0,
    clusterReport: { episodes_closed: 3, processed: 4 },
    config: { enrichment_enabled: true, near_dup_threshold: 0.87 },
    createdAt: "2026-07-18T11:00:22.000Z",
    durationSeconds: 21,
    finishedAt: "2026-07-18T11:00:21.000Z",
    id: "00000000-0000-4000-8000-0000000000a2",
    name: "near-dup-0.87",
    startedAt: "2026-07-18T11:00:00.000Z",
    summary: {
      cards: 4,
      entries_clustered: 4,
      entry_attach_mix: { near_dup: 1, new_cluster: 3 },
      episode_attach_mix: { new_storyline: 2 },
      episodes: 3,
      multi_episode_storylines: 1,
      singleton_episode_rate: 0.667,
      storylines: 2,
      top_chains: [{ episodes: 2, headline: "Valsatrex recall chain" }],
    },
  },
  {
    cacheHits: 0,
    cacheMisses: 2,
    clusterReport: { episodes_closed: 3, processed: 4 },
    config: { enrichment_enabled: true, near_dup_threshold: 0.9 },
    createdAt: "2026-07-18T10:00:43.000Z",
    durationSeconds: 42,
    finishedAt: "2026-07-18T10:00:42.000Z",
    id: "00000000-0000-4000-8000-0000000000a1",
    name: "baseline",
    startedAt: "2026-07-18T10:00:00.000Z",
    summary: {
      cards: 4,
      entries_clustered: 4,
      entry_attach_mix: { near_dup: 1, new_cluster: 3 },
      episode_attach_mix: { new_storyline: 2 },
      episodes: 4,
      multi_episode_storylines: 1,
      singleton_episode_rate: 0.75,
      storylines: 2,
      top_chains: [{ episodes: 2, headline: "Valsatrex recall chain" }],
    },
  },
];

afterEach(() => {
  vi.restoreAllMocks();
});

describe("LabPage", () => {
  it("renders corpus receipt, run history, and label queue", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL) => {
        const url = String(input);
        if (url.includes("/capability"))
          return jsonResponse({
            data: { experimentsEnabled: true, status: "available" },
          });
        if (url.includes("/corpus"))
          return jsonResponse({
            data: {
              agencies: [{ agency: "fda", entries: 8 }],
              clustered: 10,
              embedded: 11,
              enriched: 11,
              entries: 13,
              extracted: 13,
              firstPublishedAt: "2026-05-14T14:00:00.000Z",
              lastPublishedAt: "2026-06-20T14:00:00.000Z",
              needsPrepare: 2,
              sources: 3,
            },
          });
        if (url.includes("/experiments"))
          return jsonResponse({ data: { active: null, items: RUNS } });
        if (url.includes("/borderline"))
          return jsonResponse({
            data: {
              items: [
                {
                  attachMethod: "near_dup",
                  entryId: "00000000-0000-4000-8000-000000000013",
                  entryTitle: "FDA expands Valsatrex recall",
                  matchedEntryId: "00000000-0000-4000-8000-000000000011",
                  matchedTitle: "FDA recalls Valsatrex",
                  similarity: 0.915,
                  thresholdUsed: 0.9,
                },
              ],
            },
          });
        if (url.includes("/labels"))
          return jsonResponse({ data: { count: 2, labels: [] } });
        if (url.includes("/metrics"))
          return jsonResponse({
            data: {
              attachMix: [
                { avgSimilarity: 0.91, count: 3, method: "near_dup" },
              ],
              calibration: {
                pairCount: 5,
                percentiles: { p5: 0.942 },
                suggestedNearDupThreshold: 0.922,
              },
              capturedAt: "2026-07-18T12:00:00.000Z",
              entriesPerEpisode: [{ bucket: 1, count: 2 }],
              episodesPerStoryline: [{ bucket: 2, count: 1 }],
              similarity: [],
              singletonEpisodeRate: 0.4,
              storylineAttachMix: [],
              syndicationRate: 0.25,
              topChains: [],
              volume: {
                cards: 4,
                entries: 13,
                episodes: 3,
                multiEpisodeStorylines: 1,
                storylines: 2,
              },
            },
          });
        return jsonResponse({ data: {} });
      }),
    );
    const client = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    });
    render(
      <QueryClientProvider client={client}>
        <MemoryRouter>
          <LabPage />
        </MemoryRouter>
      </QueryClientProvider>,
    );
    expect((await screen.findAllByText("13")).length).toBeGreaterThan(0);
    expect((await screen.findAllByText(/needs prepare/i)).length).toBeGreaterThan(0);
    expect(await screen.findByText("near-dup-0.87")).toBeInTheDocument();
    expect(await screen.findByText("baseline")).toBeInTheDocument();
    expect(
      await screen.findByText("FDA expands Valsatrex recall"),
    ).toBeInTheDocument();
    expect(await screen.findByText(/0\.922/)).toBeInTheDocument();
    // every override parameter explains what it tunes
    expect(
      screen.getByText(/syndicated near-duplicate/),
    ).toBeInTheDocument();
    expect(screen.getByText(/hours without a new entry/)).toBeInTheDocument();
    expect(screen.getByText(/never justify a join/)).toBeInTheDocument();
  });
});
