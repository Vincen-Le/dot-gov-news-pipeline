import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter, useLocation } from "react-router-dom";
import { afterEach, describe, expect, it } from "vitest";

import { App } from "../src/App";

afterEach(cleanup);

function CurrentSearch() {
  return <output data-testid="search">{useLocation().search}</output>;
}

describe("application loading", () => {
  it("renders the selected route without waiting for every storyline detail", () => {
    const client = new QueryClient({
      defaultOptions: { queries: { retry: false, staleTime: Infinity } },
    });
    client.setQueryData(["bootstrap"], {
      agencies: [],
      categories: [],
      previews: [],
      storylines: {
        hasMore: false,
        items: [
          {
            agencies: ["fda"],
            categoryName: "Public Health",
            distinctFeeds: 1,
            entities: [],
            entryCount: 1,
            episodeCount: 1,
            eventKeys: [],
            firstEntryAt: "2026-07-20T12:00:00.000Z",
            firstOverviewAt: "2026-07-20T12:00:00.000Z",
            headline: "Reviewed agency update",
            id: "00000000-0000-4000-8000-000000000021",
            newestEntryAt: "2026-07-20T12:00:00.000Z",
            rankKey: 8,
            themeId: null,
            themeName: null,
            unreviewedEntryCount: 0,
          },
        ],
      },
      themes: [],
    });
    client.setQueryData(["rank-overview"], {
      dataset: {
        approvedAt: "2026-07-20T12:00:00.000Z",
        approvedEntries: 1,
        sourceRunName: "canonical-golden",
        storylines: 1,
      },
      filters: { agencies: [], categories: [], themes: [] },
    });
    client.setQueryData(["rank-rows", "2026-07-20", "", "", ""], {
      rows: [],
    });

    render(
      <QueryClientProvider client={client}>
        <MemoryRouter initialEntries={["/ranking"]}>
          <App />
        </MemoryRouter>
      </QueryClientProvider>,
    );

    expect(screen.getByRole("heading", { name: "Ranking" })).toBeTruthy();
    expect(screen.queryByText("Preparing the publication timeline")).toBeNull();
  });

  it("keeps the selected publication date when opening explorer", async () => {
    const client = new QueryClient({
      defaultOptions: { queries: { retry: false, staleTime: Infinity } },
    });
    client.setQueryData(["bootstrap"], {
      agencies: [],
      categories: [],
      previews: [],
      storylines: {
        hasMore: false,
        items: [
          {
            agencies: ["fda"],
            categoryName: "Public Health",
            distinctFeeds: 1,
            entities: [],
            entryCount: 1,
            episodeCount: 1,
            eventKeys: [],
            firstEntryAt: "2026-07-20T12:00:00.000Z",
            firstOverviewAt: "2026-07-20T12:00:00.000Z",
            headline: "Earlier reviewed update",
            id: "00000000-0000-4000-8000-000000000021",
            newestEntryAt: "2026-07-20T12:00:00.000Z",
            rankKey: 8,
            themeId: null,
            themeName: null,
            unreviewedEntryCount: 0,
          },
          {
            agencies: ["epa"],
            categoryName: "Environment",
            distinctFeeds: 1,
            entities: [],
            entryCount: 1,
            episodeCount: 1,
            eventKeys: [],
            firstEntryAt: "2026-07-28T12:00:00.000Z",
            firstOverviewAt: "2026-07-28T12:00:00.000Z",
            headline: "Latest reviewed update",
            id: "00000000-0000-4000-8000-000000000022",
            newestEntryAt: "2026-07-28T12:00:00.000Z",
            rankKey: 9,
            themeId: null,
            themeName: null,
            unreviewedEntryCount: 0,
          },
        ],
      },
      themes: [],
    });
    client.setQueryData(["explorer"], {
      coverage: { mapped: 0, reviewed: 2 },
      generatedAt: null,
      nodes: [],
      version: "empty",
    });

    render(
      <QueryClientProvider client={client}>
        <MemoryRouter initialEntries={["/?view=explorer&asOf=2026-07-20"]}>
          <App />
          <CurrentSearch />
        </MemoryRouter>
      </QueryClientProvider>,
    );

    await waitFor(() =>
      expect(screen.getByTestId("search").textContent).toContain(
        "asOf=2026-07-20",
      ),
    );
  });
});
