import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, cleanup, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { MemoryRouter } from "react-router-dom";

import type {
  Card,
  StorylineDetail,
  StorylineListItem,
  StorylinePreview,
} from "../src/api/contracts";
import { dotGovApi } from "../src/api/client";
import { StorylinesPage } from "../src/StorylinesPage";

function storyline(index: number): StorylineListItem {
  const id = `00000000-0000-4000-8000-${String(index).padStart(12, "0")}`;
  return {
    agencies: ["fda"],
    categoryName: "Public Health",
    distinctFeeds: 1,
    entities: [],
    entryCount: 1,
    episodeCount: 1,
    eventKeys: [],
    firstEntryAt: "2026-07-01T12:00:00.000Z",
    firstOverviewAt: "2026-07-01T12:00:00.000Z",
    headline: `Storyline ${index}`,
    id,
    newestEntryAt: "2026-07-01T12:00:00.000Z",
    rankKey: 100 - index,
    themeId: null,
    themeName: null,
    unreviewedEntryCount: 0,
  };
}

function overview(item: StorylineListItem): Card {
  return {
    articleOverview: null,
    generatedAt: item.newestEntryAt,
    headline: item.headline!,
    id: `${item.id}-card`,
    interestReason: null,
    kind: "overview",
    newestEntryAt: item.newestEntryAt,
    rankKey: item.rankKey!,
    summary: "Reviewed summary.",
    thumbnail: null,
    timeline: null,
    version: 1,
  };
}

function preview(item: StorylineListItem): StorylinePreview {
  return {
    overviewCards: [overview(item)],
    storylineId: item.id,
  };
}

function detail(item: StorylineListItem): StorylineDetail {
  return {
    ...item,
    categoryId: null,
    episodes: [],
    overviewCards: [overview(item)],
  };
}

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("storyline rendering window", () => {
  it("prefetches detail for only the storylines rendered into the DOM", async () => {
    const items = Array.from({ length: 20 }, (_, index) =>
      storyline(index + 1),
    );
    const client = new QueryClient({
      defaultOptions: { queries: { retry: false, staleTime: Infinity } },
    });
    client.setQueryData(["bootstrap"], {
      agencies: [],
      categories: [],
      previews: items.map(preview),
      storylines: { hasMore: false, items },
      themes: [],
    });
    const fetchDetail = vi
      .spyOn(dotGovApi, "storyline")
      .mockImplementation(async (id) =>
        detail(items.find((item) => item.id === id)!),
      );

    render(
      <QueryClientProvider client={client}>
        <MemoryRouter>
          <StorylinesPage asOf="2026-07-20" />
        </MemoryRouter>
      </QueryClientProvider>,
    );

    await waitFor(() => expect(fetchDetail).toHaveBeenCalledTimes(18));
    expect(fetchDetail).not.toHaveBeenCalledWith(
      items[18]!.id,
      expect.anything(),
    );
    expect(fetchDetail).not.toHaveBeenCalledWith(
      items[19]!.id,
      expect.anything(),
    );
  });

  it("renders the next 18 storylines before the current window is exhausted", async () => {
    let intersectionCallback: IntersectionObserverCallback | null = null;
    const observe = vi.fn();
    const disconnect = vi.fn();
    const observerOptions: IntersectionObserverInit[] = [];
    const observers: IntersectionObserver[] = [];
    class IntersectionObserverMock implements IntersectionObserver {
      readonly root = null;
      readonly rootMargin: string;
      readonly thresholds = [0];

      constructor(
        callback: IntersectionObserverCallback,
        options: IntersectionObserverInit = {},
      ) {
        intersectionCallback = callback;
        observerOptions.push(options);
        this.rootMargin = options.rootMargin ?? "0px";
        observers.push(this);
      }

      disconnect = disconnect;
      observe = observe;
      takeRecords = () => [];
      unobserve = vi.fn();
    }
    vi.stubGlobal("IntersectionObserver", IntersectionObserverMock);

    const items = Array.from({ length: 40 }, (_, index) =>
      storyline(index + 1),
    );
    const client = new QueryClient({
      defaultOptions: { queries: { retry: false, staleTime: Infinity } },
    });
    const storylines = { hasMore: false, items };
    client.setQueryData(["bootstrap"], {
      agencies: [],
      categories: [],
      previews: items.map(preview),
      storylines,
      themes: [],
    });
    client.setQueryData(["storylines"], storylines);
    client.setQueryData(["agencies"], { agencies: [] });
    client.setQueryData(["categories"], { categories: [] });
    client.setQueryData(["themes"], { themes: [] });
    for (const item of items) {
      client.setQueryData(["storyline", item.id], detail(item));
    }

    render(
      <QueryClientProvider client={client}>
        <MemoryRouter>
          <StorylinesPage asOf="2026-07-20" />
        </MemoryRouter>
      </QueryClientProvider>,
    );

    expect(screen.getAllByRole("article")).toHaveLength(18);
    expect(observe).toHaveBeenCalledOnce();
    expect(observerOptions).toEqual([{ rootMargin: "1200px 0px" }]);

    act(() => {
      intersectionCallback?.(
        [{ isIntersecting: true } as IntersectionObserverEntry],
        observers.at(-1)!,
      );
    });

    await waitFor(() =>
      expect(screen.getAllByRole("article")).toHaveLength(36),
    );
    expect(screen.getByText("36 of 40")).toBeTruthy();
  });
});
