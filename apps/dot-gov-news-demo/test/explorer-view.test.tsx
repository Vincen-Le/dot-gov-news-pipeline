import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type {
  Explorer,
  StorylineListItem,
  StorylinePreview,
} from "../src/api/contracts";
import { ExplorerView, nodeDimensions } from "../src/ExplorerView";

const storylineId = "00000000-0000-4000-8000-000000000021";

const item: StorylineListItem = {
  agencies: ["fda"],
  categoryName: "Public Health",
  distinctFeeds: 1,
  entities: [],
  entryCount: 3,
  episodeCount: 2,
  eventKeys: [],
  firstEntryAt: "2026-07-20T12:00:00.000Z",
  firstOverviewAt: "2026-07-20T12:00:00.000Z",
  headline: "FDA publishes a ranked public-health update",
  id: storylineId,
  newestEntryAt: "2026-07-28T12:00:00.000Z",
  rankKey: 42,
  themeId: null,
  themeName: null,
  unreviewedEntryCount: 0,
};

const preview: StorylinePreview = {
  overviewCards: [
    {
      headline: item.headline!,
      id: "00000000-0000-4000-8000-000000000041",
      newestEntryAt: item.newestEntryAt,
      rankKey: item.rankKey!,
      summary: "A reviewed summary for the focused explorer storyline.",
      thumbnail: null,
      version: 1,
    },
  ],
  storylineId,
};

const projection: Explorer = {
  coverage: { mapped: 1, reviewed: 1 },
  generatedAt: "2026-07-28T13:00:00.000Z",
  nodes: [
    {
      neighbors: [],
      rankPercentile: 1,
      storylineId,
      x: 0,
      y: 0,
    },
  ],
  version: "projection-1",
};

class ResizeObserverStub {
  disconnect() {}
  observe() {}
  unobserve() {}
}

beforeEach(() => {
  vi.stubGlobal("ResizeObserver", ResizeObserverStub);
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

function renderExplorer(
  focusedId: string | null,
  onFocus = vi.fn(),
  onOpen = vi.fn(),
) {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false, staleTime: Infinity } },
  });
  client.setQueryData(["explorer"], projection);
  return {
    onFocus,
    onOpen,
    ...render(
      <QueryClientProvider client={client}>
        <ExplorerView
          asOf="2026-07-28"
          focusedId={focusedId}
          items={[item]}
          onFocus={onFocus}
          onOpen={onOpen}
          previewByStoryline={new Map([[storylineId, preview]])}
        />
      </QueryClientProvider>,
    ),
  };
}

describe("semantic storyline explorer", () => {
  it("uses a bounded nonlinear size scale for rank prominence", () => {
    expect(nodeDimensions(0)).toEqual({ height: 64, width: 120 });
    expect(nodeDimensions(1)).toEqual({ height: 112, width: 220 });
    expect(nodeDimensions(0.25)).toEqual({ height: 88, width: 170 });
  });

  it("focuses the highest-ranked mapped storyline by default", async () => {
    const { onFocus } = renderExplorer(null);

    await waitFor(() => expect(onFocus).toHaveBeenCalledWith(storylineId));
  });

  it("shows the focused summary and opens the existing detail experience", () => {
    const { onOpen } = renderExplorer(storylineId);

    expect(
      screen.getByText(
        "A reviewed summary for the focused explorer storyline.",
      ),
    ).toBeTruthy();
    fireEvent.click(
      screen.getByRole("button", { name: "Open full storyline" }),
    );
    expect(onOpen).toHaveBeenCalledWith(item);
  });
});
