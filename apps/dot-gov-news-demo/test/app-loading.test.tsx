import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, render, screen } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { afterEach, describe, expect, it } from "vitest";

import { App } from "../src/App";

afterEach(cleanup);

describe("application loading", () => {
  it("renders the selected route without waiting for every storyline detail", () => {
    const client = new QueryClient({
      defaultOptions: { queries: { retry: false, staleTime: Infinity } },
    });
    client.setQueryData(["storylines"], {
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
    client.setQueryData(["rank-rows", "", "", ""], { rows: [] });

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
});
