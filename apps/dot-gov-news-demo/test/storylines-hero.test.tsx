import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, fireEvent, render, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { MemoryRouter } from "react-router-dom";

import type { Card, StorylineListItem } from "../src/api/contracts";
import { StorylinesPage } from "../src/StorylinesPage";

const firstId = "00000000-0000-4000-8000-000000000021";
const secondId = "00000000-0000-4000-8000-000000000022";

function storyline(
  id: string,
  firstOverviewAt: string,
  rankKey: number,
): StorylineListItem {
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
    headline: `${id} headline`,
    id,
    newestEntryAt: firstOverviewAt,
    rankKey,
    rankHistory: [{ newestEntryAt: firstOverviewAt, rankKey, version: 1 }],
    themeId: null,
    themeName: null,
    unreviewedEntryCount: 0,
  };
}

function overview(id: string, newestEntryAt: string): Card {
  return {
    articleOverview: null,
    generatedAt: newestEntryAt,
    headline: `${id} overview`,
    id,
    interestReason: null,
    kind: "overview",
    newestEntryAt,
    rankKey: 1,
    summary: "Reviewed summary.",
    thumbnail: {
      altText: `${id} illustration`,
      cardUrl: `/images/${id}.webp`,
      focalX: 0.25,
      focalY: 0.75,
    },
    timeline: null,
    version: 1,
  };
}

function heroImage(
  container: HTMLElement,
  modifier: "incoming" | "outgoing" | "preload",
): HTMLImageElement | null {
  return container.querySelector(`.storylines-hero-image--${modifier}`);
}

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe("storylines hero artwork", () => {
  it("crossfades to the top-ranked storyline available on the selected day", async () => {
    const fetch = vi.spyOn(globalThis, "fetch");
    const first = {
      ...storyline(firstId, "2026-07-10T12:00:00.000Z", 5),
      rankKey: 20,
    };
    const second = {
      ...storyline(secondId, "2026-07-12T12:00:00.000Z", 10),
      rankKey: 1,
    };
    const firstCard = overview(
      "00000000-0000-4000-8000-000000000041",
      first.firstOverviewAt!,
    );
    const secondCard = overview(
      "00000000-0000-4000-8000-000000000042",
      second.firstOverviewAt!,
    );
    const client = new QueryClient({
      defaultOptions: { queries: { retry: false, staleTime: Infinity } },
    });
    client.setQueryData(["bootstrap"], {
      agencies: [],
      categories: [],
      previews: [
        { overviewCards: [firstCard], storylineId: firstId },
        { overviewCards: [secondCard], storylineId: secondId },
      ],
      storylines: { hasMore: false, items: [second, first] },
      themes: [],
    });
    const view = render(
      <QueryClientProvider client={client}>
        <MemoryRouter>
          <StorylinesPage asOf="2026-07-10" />
        </MemoryRouter>
      </QueryClientProvider>,
    );

    await waitFor(() =>
      expect(heroImage(view.container, "preload")?.getAttribute("src")).toBe(
        firstCard.thumbnail?.cardUrl,
      ),
    );
    fireEvent.load(heroImage(view.container, "preload")!);

    await waitFor(() =>
      expect(heroImage(view.container, "incoming")?.getAttribute("src")).toBe(
        firstCard.thumbnail?.cardUrl,
      ),
    );
    const storylineGrid = view.getByRole("region", { name: "Storylines" });

    view.rerender(
      <QueryClientProvider client={client}>
        <MemoryRouter>
          <StorylinesPage asOf="2026-07-12" />
        </MemoryRouter>
      </QueryClientProvider>,
    );

    await waitFor(() => {
      expect(heroImage(view.container, "preload")?.getAttribute("src")).toBe(
        secondCard.thumbnail?.cardUrl,
      );
      expect(heroImage(view.container, "incoming")?.getAttribute("src")).toBe(
        firstCard.thumbnail?.cardUrl,
      );
    });

    view.rerender(
      <QueryClientProvider client={client}>
        <MemoryRouter>
          <StorylinesPage asOf="2026-07-10" />
        </MemoryRouter>
      </QueryClientProvider>,
    );
    await waitFor(() =>
      expect(heroImage(view.container, "preload")).toBeNull(),
    );
    expect(heroImage(view.container, "incoming")?.getAttribute("src")).toBe(
      firstCard.thumbnail?.cardUrl,
    );

    view.rerender(
      <QueryClientProvider client={client}>
        <MemoryRouter>
          <StorylinesPage asOf="2026-07-12" />
        </MemoryRouter>
      </QueryClientProvider>,
    );
    await waitFor(() =>
      expect(heroImage(view.container, "preload")?.getAttribute("src")).toBe(
        secondCard.thumbnail?.cardUrl,
      ),
    );
    fireEvent.load(heroImage(view.container, "preload")!);

    await waitFor(() => {
      expect(heroImage(view.container, "incoming")?.getAttribute("src")).toBe(
        secondCard.thumbnail?.cardUrl,
      );
      expect(heroImage(view.container, "outgoing")?.getAttribute("src")).toBe(
        firstCard.thumbnail?.cardUrl,
      );
    });
    expect(view.getByRole("region", { name: "Storylines" })).toBe(
      storylineGrid,
    );
    expect(fetch).not.toHaveBeenCalled();

    const outgoing = heroImage(view.container, "outgoing");
    if (outgoing !== null) fireEvent.animationEnd(outgoing);
    expect(heroImage(view.container, "outgoing")).toBeNull();
  });
});
