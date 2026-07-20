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
  vi.useRealTimers();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("storyline rendering window", () => {
  it("fades a theme in when it reaches its storyline threshold", () => {
    vi.useFakeTimers();
    const items = [20, 21, 22, 23].map((day, index) => ({
      ...storyline(index + 1),
      firstEntryAt: `2026-07-${day}T12:00:00.000Z`,
      firstOverviewAt: `2026-07-${day}T12:00:00.000Z`,
      newestEntryAt: `2026-07-${day}T12:00:00.000Z`,
      themeId: "theme-food-safety",
      themeName: "Food safety",
    }));
    const client = new QueryClient({
      defaultOptions: { queries: { retry: false, staleTime: Infinity } },
    });
    client.setQueryData(["bootstrap"], {
      agencies: [],
      categories: [],
      previews: items.map(preview),
      storylines: { hasMore: false, items },
      themes: [
        {
          categoryId: null,
          categoryName: null,
          displayName: "Food safety",
          firstStorylineAt: "2026-07-20T12:00:00.000Z",
          id: "theme-food-safety",
          manuallySet: false,
          newestStorylineAt: "2026-07-23T12:00:00.000Z",
          storylineCount: 4,
        },
      ],
    });
    for (const item of items) {
      client.setQueryData(["storyline", item.id], detail(item));
    }

    const page = (asOf: string) => (
      <QueryClientProvider client={client}>
        <MemoryRouter>
          <StorylinesPage asOf={asOf} />
        </MemoryRouter>
      </QueryClientProvider>
    );
    const view = render(page("2026-07-22"));

    expect(screen.queryByText("Food safety")).toBeNull();

    view.rerender(page("2026-07-23"));

    const themeFilter = screen.getByRole("button", { name: "Food safety" });
    expect(themeFilter.classList.contains("filter-option-transition")).toBe(
      true,
    );
    expect(
      screen
        .getByRole("button", { name: "fda" })
        .classList.contains("filter-option-transition"),
    ).toBe(true);
    expect(
      screen
        .getByRole("button", { name: "Public Health" })
        .classList.contains("filter-option-transition"),
    ).toBe(true);
    expect(
      view.container.querySelectorAll(".taxonomy .theme-emergence"),
    ).toHaveLength(4);

    view.rerender(page("2026-07-26"));

    expect(themeFilter.classList.contains("is-exiting")).toBe(true);
    expect((themeFilter as HTMLButtonElement).disabled).toBe(true);
    expect(
      view.container.querySelectorAll(".taxonomy .theme-emergence.is-exiting"),
    ).toHaveLength(4);

    act(() => vi.advanceTimersByTime(320));

    expect(screen.queryByText("Food safety")).toBeNull();
  });

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
