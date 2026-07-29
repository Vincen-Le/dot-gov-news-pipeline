import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { MemoryRouter, useLocation } from "react-router-dom";

import type {
  Card,
  StorylineDetail,
  StorylineListItem,
  StorylinePreview,
} from "../src/api/contracts";
import { dotGovApi } from "../src/api/client";
import { StorylinesPage } from "../src/StorylinesPage";

vi.mock("../src/ExplorerView", () => ({
  ExplorerView: ({ items }: { items: StorylineListItem[] }) => (
    <div data-testid="explorer-fixture">
      {items.map((item) => (
        <span key={item.id}>{item.headline}</span>
      ))}
    </div>
  ),
}));

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

function CurrentSearch() {
  return <output data-testid="search">{useLocation().search}</output>;
}

function renderFilterFixture() {
  const items = [
    {
      ...storyline(1),
      agencies: ["bls"],
      categoryName: "Economy & Labor",
      headline: "Labor storyline",
    },
    {
      ...storyline(2),
      agencies: ["dod"],
      categoryName: "Defense & Military",
      headline: "Defense storyline",
    },
    {
      ...storyline(3),
      agencies: ["epa"],
      categoryName: "Energy & Environment",
      headline: "Environment storyline",
    },
  ];
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false, staleTime: Infinity } },
  });
  client.setQueryData(["bootstrap"], {
    agencies: [
      { displayName: "Bureau of Labor Statistics", key: "bls" },
      { displayName: "Department of Defense", key: "dod" },
      { displayName: "Environmental Protection Agency", key: "epa" },
    ],
    categories: [],
    previews: items.map(preview),
    storylines: { hasMore: false, items },
    themes: [],
  });
  for (const item of items) {
    client.setQueryData(["storyline", item.id], detail(item));
  }

  render(
    <QueryClientProvider client={client}>
      <MemoryRouter>
        <StorylinesPage asOf="2026-07-20" />
        <CurrentSearch />
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("storyline rendering window", () => {
  it("filters storylines by a single selected facet", () => {
    renderFilterFixture();

    fireEvent.click(
      screen.getByRole("button", { name: "Bureau of Labor Statistics" }),
    );

    expect(screen.getAllByRole("article")).toHaveLength(1);
    expect(screen.getByText("Labor storyline")).toBeTruthy();
    expect(screen.getByTestId("search").textContent).toBe("?agency=bls");
  });

  it("shows storylines matching any selected facet across filter groups", () => {
    renderFilterFixture();

    fireEvent.click(
      screen.getByRole("button", { name: "Bureau of Labor Statistics" }),
    );
    fireEvent.click(screen.getByRole("button", { name: "Defense & Military" }));

    expect(screen.getAllByRole("article")).toHaveLength(2);
    expect(screen.getByText("Labor storyline")).toBeTruthy();
    expect(screen.getByText("Defense storyline")).toBeTruthy();
    expect(screen.queryByText("Environment storyline")).toBeNull();
  });

  it("filters the Explorer map to the selected facet", async () => {
    renderFilterFixture();

    fireEvent.click(screen.getByRole("button", { name: "Explorer" }));
    const explorer = await screen.findByTestId("explorer-fixture");
    fireEvent.click(
      screen.getByRole("button", {
        name: "Environmental Protection Agency",
      }),
    );

    await waitFor(() =>
      expect(explorer.querySelectorAll("span")).toHaveLength(1),
    );
    expect(screen.queryByText("Labor storyline")).toBeNull();
    expect(screen.queryByText("Defense storyline")).toBeNull();
    expect(screen.getByText("Environment storyline")).toBeTruthy();
    expect(screen.getByText(/Showing/).textContent).toContain("1 of 3");
  });

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

    fireEvent.animationEnd(themeFilter);

    expect(screen.queryByText("Food safety")).toBeNull();
  });

  it("finishes an outgoing theme before introducing its replacement", () => {
    vi.useFakeTimers();
    const oldItems = [1, 2, 3, 4].map((index) => ({
      ...storyline(index),
      firstEntryAt: "2026-07-20T12:00:00.000Z",
      firstOverviewAt: "2026-07-20T12:00:00.000Z",
      newestEntryAt: "2026-07-22T12:00:00.000Z",
      themeId: "theme-old",
      themeName: "Outgoing theme",
    }));
    const newItems = [5, 6, 7, 8].map((index, offset) => ({
      ...storyline(index),
      firstEntryAt: `2026-07-${23 + offset}T12:00:00.000Z`,
      firstOverviewAt: `2026-07-${23 + offset}T12:00:00.000Z`,
      newestEntryAt: `2026-07-${23 + offset}T12:00:00.000Z`,
      themeId: "theme-new",
      themeName: "Incoming theme",
    }));
    const items = [...oldItems, ...newItems];
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
          displayName: "Outgoing theme",
          firstStorylineAt: "2026-07-20T12:00:00.000Z",
          id: "theme-old",
          manuallySet: false,
          newestStorylineAt: "2026-07-22T12:00:00.000Z",
          storylineCount: 4,
        },
        {
          categoryId: null,
          categoryName: null,
          displayName: "Incoming theme",
          firstStorylineAt: "2026-07-23T12:00:00.000Z",
          id: "theme-new",
          manuallySet: false,
          newestStorylineAt: "2026-07-26T12:00:00.000Z",
          storylineCount: 4,
        },
      ],
    });

    const page = (asOf: string) => (
      <QueryClientProvider client={client}>
        <MemoryRouter>
          <StorylinesPage asOf={asOf} />
        </MemoryRouter>
      </QueryClientProvider>
    );
    const view = render(page("2026-07-22"));

    view.rerender(page("2026-07-26"));

    const outgoingTheme = screen.getByRole("button", {
      name: "Outgoing theme",
    });
    expect(outgoingTheme.classList.contains("is-exiting")).toBe(true);
    expect(screen.queryByRole("button", { name: "Incoming theme" })).toBeNull();

    fireEvent.animationEnd(outgoingTheme);

    expect(screen.queryByRole("button", { name: "Outgoing theme" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Incoming theme" })).toBeNull();

    act(() => vi.advanceTimersByTime(140));

    expect(
      screen
        .getByRole("button", { name: "Incoming theme" })
        .classList.contains("filter-option-transition"),
    ).toBe(true);
  });

  it("settles on the latest filters when date changes cancel exit animations", () => {
    vi.useFakeTimers();
    const themedItems = [
      ...[1, 2, 3, 4].map((index) => ({
        ...storyline(index),
        firstEntryAt: "2026-07-20T12:00:00.000Z",
        firstOverviewAt: "2026-07-20T12:00:00.000Z",
        newestEntryAt: "2026-07-22T12:00:00.000Z",
        themeId: "theme-old",
        themeName: "Outgoing theme",
      })),
      ...[5, 6, 7, 8].map((index) => ({
        ...storyline(index),
        firstEntryAt: "2026-07-24T12:00:00.000Z",
        firstOverviewAt: "2026-07-24T12:00:00.000Z",
        newestEntryAt: "2026-07-26T12:00:00.000Z",
        themeId: "theme-middle",
        themeName: "Skipped theme",
      })),
      ...[9, 10, 11, 12].map((index) => ({
        ...storyline(index),
        firstEntryAt: "2026-07-28T12:00:00.000Z",
        firstOverviewAt: "2026-07-28T12:00:00.000Z",
        newestEntryAt: "2026-07-30T12:00:00.000Z",
        themeId: "theme-latest",
        themeName: "Latest theme",
      })),
    ];
    const client = new QueryClient({
      defaultOptions: { queries: { retry: false, staleTime: Infinity } },
    });
    client.setQueryData(["bootstrap"], {
      agencies: [],
      categories: [],
      previews: themedItems.map(preview),
      storylines: { hasMore: false, items: themedItems },
      themes: [
        {
          categoryId: null,
          categoryName: null,
          displayName: "Outgoing theme",
          firstStorylineAt: "2026-07-20T12:00:00.000Z",
          id: "theme-old",
          manuallySet: false,
          newestStorylineAt: "2026-07-22T12:00:00.000Z",
          storylineCount: 4,
        },
        {
          categoryId: null,
          categoryName: null,
          displayName: "Skipped theme",
          firstStorylineAt: "2026-07-24T12:00:00.000Z",
          id: "theme-middle",
          manuallySet: false,
          newestStorylineAt: "2026-07-26T12:00:00.000Z",
          storylineCount: 4,
        },
        {
          categoryId: null,
          categoryName: null,
          displayName: "Latest theme",
          firstStorylineAt: "2026-07-28T12:00:00.000Z",
          id: "theme-latest",
          manuallySet: false,
          newestStorylineAt: "2026-07-30T12:00:00.000Z",
          storylineCount: 4,
        },
      ],
    });

    const page = (asOf: string) => (
      <QueryClientProvider client={client}>
        <MemoryRouter>
          <StorylinesPage asOf={asOf} />
        </MemoryRouter>
      </QueryClientProvider>
    );
    const view = render(page("2026-07-22"));

    view.rerender(page("2026-07-26"));
    view.rerender(page("2026-07-30"));

    expect(
      screen.getByRole("button", { name: "Outgoing theme" }).classList,
    ).toContain("is-exiting");
    expect(screen.queryByRole("button", { name: "Latest theme" })).toBeNull();

    act(() => vi.advanceTimersByTime(600));

    expect(screen.queryByRole("button", { name: "Outgoing theme" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Skipped theme" })).toBeNull();
    expect(screen.getByRole("button", { name: "Latest theme" })).toBeTruthy();
  });

  it("prefetches detail for each rendered preview-backed storyline", async () => {
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

    fireEvent.click(
      screen.getByRole("button", { name: "Load next storylines" }),
    );

    await waitFor(() => expect(fetchDetail).toHaveBeenCalledTimes(20));
    await waitFor(() =>
      expect(client.getQueryState(["storyline", items[0]!.id])?.status).toBe(
        "success",
      ),
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
