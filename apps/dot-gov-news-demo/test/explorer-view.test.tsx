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
import {
  compactExplorerLayout,
  ExplorerView,
  nodeDimensions,
  rankPercentiles,
} from "../src/ExplorerView";

const storylineId = "00000000-0000-4000-8000-000000000021";
const neighborId = "00000000-0000-4000-8000-000000000022";

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

const neighbor: StorylineListItem = {
  ...item,
  headline: "FDA publishes a related public-health update",
  id: neighborId,
  rankKey: 21,
};

const projection: Explorer = {
  coverage: { mapped: 2, reviewed: 2 },
  generatedAt: "2026-07-28T13:00:00.000Z",
  nodes: [
    {
      neighbors: [{ similarity: 0.92, storylineId: neighborId }],
      rankPercentile: 1,
      storylineId,
      x: 0,
      y: 0,
    },
    {
      neighbors: [{ similarity: 0.92, storylineId }],
      rankPercentile: 0,
      storylineId: neighborId,
      x: 300,
      y: 120,
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
          items={[item, neighbor]}
          onFocus={onFocus}
          onOpen={onOpen}
          previewByStoryline={new Map([[storylineId, preview]])}
          rankItems={[item, neighbor]}
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

  it("derives node prominence from the selected date's rank keys", () => {
    const low = { ...item, id: "low", rankKey: 10 };
    const middle = { ...item, id: "middle", rankKey: 20 };
    const high = { ...item, id: "high", rankKey: 30 };

    expect([...rankPercentiles([middle, high, low])]).toEqual([
      ["low", 0],
      ["middle", 0.5],
      ["high", 1],
    ]);
  });

  it("compacts sparse snapshots without overlapping storyline nodes", () => {
    const source = Array.from({ length: 36 }, (_, index) => ({
      height: 80,
      id: String(index),
      width: 140,
      x: (index % 6) * 1_000,
      y: Math.floor(index / 6) * 1_000,
    }));
    const compacted = compactExplorerLayout(source);
    const positions = [...compacted.values()];
    const width =
      Math.max(...positions.map(({ x }) => x)) -
      Math.min(...positions.map(({ x }) => x));
    const height =
      Math.max(...positions.map(({ y }) => y)) -
      Math.min(...positions.map(({ y }) => y));

    expect(width).toBeLessThanOrEqual(1_000);
    expect(height).toBeLessThanOrEqual(1_000);
    for (const [index, left] of source.entries()) {
      const leftPosition = compacted.get(left.id)!;
      for (const right of source.slice(index + 1)) {
        const rightPosition = compacted.get(right.id)!;
        const overlaps =
          Math.abs(leftPosition.x - rightPosition.x) <
            (left.width + right.width) / 2 + 20 &&
          Math.abs(leftPosition.y - rightPosition.y) <
            (left.height + right.height) / 2 + 20;
        expect(overlaps).toBe(false);
      }
    }
  });

  it("focuses the highest-ranked mapped storyline by default", async () => {
    const { onFocus } = renderExplorer(null);

    await waitFor(() => expect(onFocus).toHaveBeenCalledWith(storylineId));
  });

  it("uses spatial proximity without drawing neighbor connection lines", () => {
    const { container } = renderExplorer(storylineId);

    expect(container.querySelectorAll(".react-flow__edge")).toHaveLength(0);
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
