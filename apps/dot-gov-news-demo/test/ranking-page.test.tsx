import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { MemoryRouter, useLocation } from "react-router-dom";
import { afterEach, describe, expect, it, vi } from "vitest";

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

function CurrentLocation() {
  const location = useLocation();
  return <output data-testid="location">{location.pathname}</output>;
}

describe("ranking score makeup", () => {
  it("opens a ranked storyline on the ranking view when its row is clicked", () => {
    HTMLDialogElement.prototype.showModal = vi.fn(function (
      this: HTMLDialogElement,
    ) {
      this.setAttribute("open", "");
    });
    HTMLDialogElement.prototype.close = vi.fn();

    const queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false, staleTime: Infinity } },
    });
    const storylineId = "00000000-0000-4000-8000-000000000011";
    queryClient.setQueryData(["rank-overview"], {
      dataset: {
        approvedAt: "2026-07-20T12:00:00.000Z",
        approvedEntries: 1,
        sourceRunName: "canonical-golden",
        storylines: 1,
      },
      filters: { agencies: [], categories: [], themes: [] },
    });
    queryClient.setQueryData(["rank-rows", "2026-07-20", "", "", ""], {
      rows: [
        {
          agencies: 1,
          entryCount: 1,
          feeds: 1,
          headline: "Ranked story opens here",
          interestReason: null,
          newestEntryAt: "2026-07-20T12:00:00.000Z",
          position: 1,
          rankKey: 10,
          sourceKey: "fda",
          sourceName: "Food and Drug Administration",
          storylineId,
          summary: "A reviewed summary.",
          terms: null,
        },
      ],
    });
    queryClient.setQueryData(["bootstrap"], {
      agencies: [
        { displayName: "Food and Drug Administration", key: "fda" },
      ],
      categories: [],
      previews: [],
      storylines: {
        hasMore: false,
        items: [storyline(storylineId, "2026-07-20T12:00:00.000Z")],
      },
      themes: [],
    });

    render(
      <QueryClientProvider client={queryClient}>
        <MemoryRouter initialEntries={["/ranking"]}>
          <RankingPage asOf="2026-07-20" />
          <CurrentLocation />
        </MemoryRouter>
      </QueryClientProvider>,
    );

    fireEvent.click(screen.getByText("Ranked story opens here").closest("tr")!);

    expect(screen.getByRole("button", { name: "Close storyline" })).toBeTruthy();
    expect(screen.getByTestId("location").textContent).toBe("/ranking");
  });

  it("paginates the complete ranked set without dropping later stories", () => {
    const queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false, staleTime: Infinity } },
    });
    const terms = {
      agencyTerm: 0.35,
      feedTerm: 0.35,
      freshnessTerm: 14_068,
      priorUsed: false,
      rubricPoints: 4,
      sourceTerm: -0.2,
    };
    const rankedRows = Array.from({ length: 101 }, (_, index) => {
      const suffix = String(index + 1).padStart(12, "0");
      return {
        agencies: 1,
        entryCount: 1,
        feeds: 1,
        headline: `Ranked story ${index + 1}`,
        interestReason: null,
        newestEntryAt: "2026-07-20T12:00:00.000Z",
        position: index + 1,
        rankKey: 101 - index,
        sourceKey: "fda",
        sourceName: "Food and Drug Administration",
        storylineId: `00000000-0000-4000-8000-${suffix}`,
        summary: "A reviewed summary.",
        terms,
      };
    });
    queryClient.setQueryData(["rank-overview"], {
      dataset: {
        approvedAt: "2026-07-20T12:00:00.000Z",
        approvedEntries: 101,
        sourceRunName: "canonical-golden",
        storylines: 101,
      },
      filters: { agencies: [], categories: [], themes: [] },
    });
    queryClient.setQueryData(["rank-rows", "2026-07-20", "", "", ""], {
      rows: rankedRows,
    });
    queryClient.setQueryData(["bootstrap"], {
      agencies: [],
      categories: [],
      previews: [],
      storylines: {
        hasMore: false,
        items: rankedRows.map((row) =>
          storyline(row.storylineId, row.newestEntryAt),
        ),
      },
      themes: [],
    });

    render(
      <QueryClientProvider client={queryClient}>
        <MemoryRouter>
          <RankingPage asOf="2026-07-20" />
        </MemoryRouter>
      </QueryClientProvider>,
    );

    expect(screen.getByText("Showing 1–100 of 101")).toBeTruthy();
    expect(screen.getByText("Ranked story 100")).toBeTruthy();
    expect(screen.queryByText("Ranked story 101")).toBeNull();

    fireEvent.click(screen.getByRole("button", { name: "Next" }));

    expect(screen.getByText("Showing 101–101 of 101")).toBeTruthy();
    expect(screen.getByText("Ranked story 101")).toBeTruthy();
    expect(screen.queryByText("Ranked story 100")).toBeNull();
  });

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
    queryClient.setQueryData(["rank-rows", "2026-07-20", "", "", ""], {
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
    queryClient.setQueryData(["bootstrap"], {
      agencies: [],
      categories: [],
      previews: [],
      storylines: {
        hasMore: false,
        items: [
          storyline(
            "00000000-0000-4000-8000-000000000021",
            "2026-07-20T12:00:00.000Z",
          ),
        ],
      },
      themes: [],
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
    queryClient.setQueryData(["bootstrap"], {
      agencies: [],
      categories: [],
      previews: [],
      storylines: {
        hasMore: false,
        items: [
          storyline(earlierId, "2026-07-19T12:00:00.000Z"),
          storyline(
            futureId,
            "2026-07-19T12:00:00.000Z",
            "2026-07-21T12:00:00.000Z",
          ),
        ],
      },
      themes: [],
    });
    const terms = {
      agencyTerm: 0.35,
      feedTerm: 0.35,
      freshnessTerm: 14_068,
      priorUsed: false,
      rubricPoints: 4,
      sourceTerm: -0.2,
    };
    queryClient.setQueryData(["rank-rows", "2026-07-20", "", "", ""], {
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
