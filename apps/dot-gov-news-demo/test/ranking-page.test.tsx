import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, render, screen } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { afterEach, describe, expect, it } from "vitest";

import { RankingPage } from "../src/RankingPage";

afterEach(cleanup);

function storyline(
  id: string,
  firstOverviewAt: string,
  newestEntryAt = firstOverviewAt,
) {
  return {
    agencies: ["fda"],
    categoryName: "Public Health",
    distinctFeeds: 1,
    entities: [],
    entryCount: 1,
    episodeCount: 1,
    eventKeys: [],
    firstEntryAt: firstOverviewAt,
    firstOverviewAt,
    headline: "Reviewed agency update",
    id,
    newestEntryAt,
    rankKey: 8,
    themeId: null,
    themeName: null,
    unreviewedEntryCount: 0,
  };
}

describe("ranking score makeup", () => {
  it("normalizes editorial terms separately from the epoch-scale freshness term", () => {
    const queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false, staleTime: Infinity } },
    });
    queryClient.setQueryData(["rank-overview"], {
      dataset: {
        approvedAt: "2026-07-20T12:00:00.000Z",
        approvedEntries: 1,
        sourceRunName: "canonical-golden",
        storylines: 1,
      },
      filters: { agencies: [], categories: [], themes: [] },
    });
    queryClient.setQueryData(["rank-rows", "", "", ""], {
      rows: [
        {
          agencies: 1,
          entryCount: 1,
          feeds: 1,
          headline: "Reviewed agency update",
          interestReason: null,
          newestEntryAt: "2026-07-20T12:00:00.000Z",
          position: 1,
          rankKey: 14_072.5,
          sourceKey: "fda",
          sourceName: "Food and Drug Administration",
          storylineId: "00000000-0000-4000-8000-000000000021",
          summary: "A reviewed summary.",
          terms: {
            agencyTerm: 0.35,
            feedTerm: 0.35,
            freshnessTerm: 14_068,
            priorUsed: false,
            rubricPoints: 4,
            sourceTerm: -0.2,
          },
        },
      ],
    });
    queryClient.setQueryData(["storylines"], {
      hasMore: false,
      items: [
        storyline(
          "00000000-0000-4000-8000-000000000021",
          "2026-07-20T12:00:00.000Z",
        ),
      ],
    });

    render(
      <QueryClientProvider client={queryClient}>
        <MemoryRouter>
          <RankingPage asOf="2026-07-20" />
        </MemoryRouter>
      </QueryClientProvider>,
    );

    const composition = screen.getByRole("img", {
      name: "rubric 4.00 · agency 0.35 · feed 0.35 · source -0.20 · freshness 14068.0",
    });
    expect(
      Number.parseFloat(composition.style.getPropertyValue("--rubric-width")),
    ).toBeCloseTo(85.11, 2);
    expect(
      Number.parseFloat(composition.style.getPropertyValue("--agency-width")),
    ).toBeCloseTo(7.45, 2);
    expect(
      Number.parseFloat(composition.style.getPropertyValue("--feed-width")),
    ).toBeCloseTo(7.45, 2);
    expect(composition.style.getPropertyValue("--source-width")).toBe("0%");
    expect(
      ["--rubric-width", "--agency-width", "--feed-width"].reduce(
        (total, property) =>
          total +
          Number.parseFloat(composition.style.getPropertyValue(property)),
        0,
      ),
    ).toBeCloseTo(100, 5);
    expect(composition.querySelector(".term-freshness")).toBeNull();
    expect(screen.getByText("+14068.0t")).toBeTruthy();
  });

  it("only ranks stories published by the selected date", () => {
    const queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false, staleTime: Infinity } },
    });
    const earlierId = "00000000-0000-4000-8000-000000000031";
    const futureId = "00000000-0000-4000-8000-000000000032";
    queryClient.setQueryData(["rank-overview"], {
      dataset: {
        approvedAt: "2026-07-22T12:00:00.000Z",
        approvedEntries: 2,
        sourceRunName: "canonical-golden",
        storylines: 2,
      },
      filters: { agencies: [], categories: [], themes: [] },
    });
    queryClient.setQueryData(["storylines"], {
      hasMore: false,
      items: [
        storyline(earlierId, "2026-07-19T12:00:00.000Z"),
        storyline(
          futureId,
          "2026-07-19T12:00:00.000Z",
          "2026-07-21T12:00:00.000Z",
        ),
      ],
    });
    const terms = {
      agencyTerm: 0.35,
      feedTerm: 0.35,
      freshnessTerm: 14_068,
      priorUsed: false,
      rubricPoints: 4,
      sourceTerm: -0.2,
    };
    queryClient.setQueryData(["rank-rows", "", "", ""], {
      rows: [
        {
          agencies: 1,
          entryCount: 1,
          feeds: 1,
          headline: "Future ranked story",
          interestReason: null,
          newestEntryAt: "2026-07-21T12:00:00.000Z",
          position: 1,
          rankKey: 10,
          sourceKey: "fda",
          sourceName: "Food and Drug Administration",
          storylineId: futureId,
          summary: "This should remain hidden.",
          terms,
        },
        {
          agencies: 1,
          entryCount: 1,
          feeds: 1,
          headline: "Published ranked story",
          interestReason: null,
          newestEntryAt: "2026-07-19T12:00:00.000Z",
          position: 2,
          rankKey: 9,
          sourceKey: "fda",
          sourceName: "Food and Drug Administration",
          storylineId: earlierId,
          summary: "This was already available.",
          terms,
        },
      ],
    });

    render(
      <QueryClientProvider client={queryClient}>
        <MemoryRouter>
          <RankingPage asOf="2026-07-20" />
        </MemoryRouter>
      </QueryClientProvider>,
    );

    expect(screen.getByText("Published ranked story")).toBeTruthy();
    expect(screen.queryByText("Future ranked story")).toBeNull();
    expect(screen.getByText("Published through Jul 20, 2026")).toBeTruthy();
    expect(screen.getByText("01")).toBeTruthy();
    expect(screen.queryByText("02")).toBeNull();
  });
});
