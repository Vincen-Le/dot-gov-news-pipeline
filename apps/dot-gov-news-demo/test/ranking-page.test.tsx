import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, render, screen } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { afterEach, describe, expect, it } from "vitest";

import { RankingPage } from "../src/RankingPage";

afterEach(cleanup);

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
});
