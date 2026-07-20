import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type {
  Card,
  StorylineDetail,
  StorylineListItem,
} from "../src/api/contracts";
import {
  FilterGroup,
  StorylineCard,
  StorylineDialog,
  StorylineTableRow,
} from "../src/components";
import { filterMotion } from "../src/motion";

const storylineId = "00000000-0000-4000-8000-000000000021";
const sourceEntryId = "00000000-0000-4000-8000-000000000011";

const item: StorylineListItem = {
  agencies: ["fda"],
  categoryName: "Public Health",
  distinctFeeds: 1,
  entities: [],
  entryCount: 1,
  episodeCount: 1,
  eventKeys: [],
  firstEntryAt: "2026-07-10T12:00:00.000Z",
  firstOverviewAt: "2026-07-10T18:00:00.000Z",
  headline: "FDA issues a reviewed update",
  id: storylineId,
  newestEntryAt: "2026-07-12T12:00:00.000Z",
  rankKey: 8,
  themeId: null,
  themeName: null,
  unreviewedEntryCount: 0,
};
const placement = {
  agencyKey: "fda",
  agencyPosition: 2,
  categoryPosition: 3,
};

function overviewCard(
  id: string,
  generatedAt: string,
  version: number,
  altText: string,
): Card {
  return {
    articleOverview: {
      keyPoints: [
        {
          sourceEntryIds: [sourceEntryId],
          text: "First source-backed detail.",
        },
        {
          sourceEntryIds: [sourceEntryId],
          text: "Second source-backed detail.",
        },
        {
          sourceEntryIds: [sourceEntryId],
          text: "Third source-backed detail.",
        },
      ],
      summary: {
        sourceEntryIds: [sourceEntryId],
        text: "The reviewed source establishes the agency action.",
      },
    },
    generatedAt,
    headline: `Card version ${version}`,
    id,
    interestReason: null,
    kind: "overview",
    newestEntryAt: generatedAt,
    rankKey: version,
    summary: `Summary version ${version}`,
    thumbnail: {
      altText,
      cardUrl: `/api/lab/assets/images/${id}/card`,
      focalX: 0.25,
      focalY: 0.75,
    },
    timeline: null,
    version,
  };
}

const firstCard = overviewCard(
  "00000000-0000-4000-8000-000000000041",
  "2026-07-10T18:00:00.000Z",
  1,
  "First card illustration",
);
const secondCard = overviewCard(
  "00000000-0000-4000-8000-000000000042",
  "2026-07-12T18:00:00.000Z",
  2,
  "Second card illustration",
);

const detail: StorylineDetail = {
  ...item,
  categoryId: null,
  episodes: [
    {
      attachMethod: "golden_review",
      attachReason: null,
      card: null,
      entries: [
        {
          agency: "fda",
          attachMethod: "golden_review",
          entitySet: [],
          eventKeys: [],
          id: sourceEntryId,
          matchedEntryId: null,
          publishedAt: "2026-07-10T12:00:00.000Z",
          similarity: null,
          thresholdUsed: null,
          title: "Original agency announcement",
          url: "https://www.fda.gov/example",
        },
      ],
      entryCount: 1,
      firstEntryAt: "2026-07-10T12:00:00.000Z",
      id: "00000000-0000-4000-8000-000000000031",
      newestEntryAt: "2026-07-10T12:00:00.000Z",
      status: "dormant",
    },
  ],
  overviewCards: [secondCard, firstCard],
};

function queryClient(): QueryClient {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false, staleTime: Infinity } },
  });
  client.setQueryData(["storyline", storylineId], detail);
  return client;
}

describe("generated event-card content", () => {
  beforeEach(() => {
    HTMLDialogElement.prototype.showModal = vi.fn(function (
      this: HTMLDialogElement,
    ) {
      this.setAttribute("open", "");
    });
    HTMLDialogElement.prototype.close = vi.fn();
  });
  afterEach(cleanup);

  it("renders the thumbnail selected by the as-of card version and its focal point", () => {
    const client = queryClient();
    const view = render(
      <QueryClientProvider client={client}>
        <StorylineCard
          agencyMap={new Map([["fda", "Food and Drug Administration"]])}
          asOf="2026-07-11"
          item={item}
          onOpen={vi.fn()}
          placement={placement}
          revealIndex={0}
        />
      </QueryClientProvider>,
    );

    const firstImage = screen.getByAltText("First card illustration");
    expect(firstImage.getAttribute("src")).toBe(firstCard.thumbnail?.cardUrl);
    expect(firstImage.getAttribute("loading")).toBe("eager");
    expect(firstImage.getAttribute("fetchpriority")).toBe("high");
    expect((firstImage as HTMLImageElement).style.objectPosition).toBe(
      "25% 75%",
    );
    expect(screen.getByText("Jul 10, 2026")).toBeTruthy();
    expect(
      screen.getByText(
        "#2 in Food and Drug Administration · #3 in Public Health",
      ),
    ).toBeTruthy();
    expect(screen.queryByText("Jul 12, 2026")).toBeNull();

    view.rerender(
      <QueryClientProvider client={client}>
        <StorylineCard
          agencyMap={new Map([["fda", "Food and Drug Administration"]])}
          asOf="2026-07-12"
          item={item}
          onOpen={vi.fn()}
          placement={placement}
        />
      </QueryClientProvider>,
    );
    expect(
      screen.getByAltText("Second card illustration").getAttribute("src"),
    ).toBe(secondCard.thumbnail?.cardUrl);
  });

  it("renders a numbered article synthesis before the available source links", () => {
    const client = queryClient();
    render(
      <QueryClientProvider client={client}>
        <StorylineDialog
          agencyMap={new Map([["fda", "Food and Drug Administration"]])}
          asOf="2026-07-12"
          close={vi.fn()}
          item={item}
        />
      </QueryClientProvider>,
    );

    const synthesis = screen.getByText(
      "The reviewed source establishes the agency action.",
    );
    const sourceLink = screen.getByRole("link", {
      name: /Original agency announcement/u,
    });
    expect(
      synthesis.compareDocumentPosition(sourceLink) &
        Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();
    expect(screen.getByText("Article synthesis")).toBeTruthy();
    expect(screen.getByText("What the available articles say")).toBeTruthy();
    expect(screen.getByText("01")).toBeTruthy();
    expect(screen.getByText("03")).toBeTruthy();
    expect(screen.getByText("Available source articles")).toBeTruthy();
    expect(
      screen.getByText(
        "1 source article available as of Jul 12, 2026. Synthesis reflects source material through Jul 12, 2026.",
      ),
    ).toBeTruthy();
  });

  it("uses the concise overview timeline instead of dense episode summaries", () => {
    const client = queryClient();
    const denseEpisodeSummary =
      "A very long source-derived episode summary that should stay out of the compact timeline.";
    client.setQueryData(["storyline", storylineId], {
      ...detail,
      episodes: detail.episodes.map((episode) => ({
        ...episode,
        card: {
          ...firstCard,
          articleOverview: null,
          headline: "Fallback episode headline",
          id: "00000000-0000-4000-8000-000000000051",
          kind: "episode" as const,
          summary: denseEpisodeSummary,
          thumbnail: null,
        },
      })),
      overviewCards: [
        {
          ...secondCard,
          timeline: [
            {
              date: "2026-07-10",
              episodeId: detail.episodes[0]?.id ?? null,
              text: "FDA published a concise timeline development.",
            },
          ],
        },
      ],
    });

    render(
      <QueryClientProvider client={client}>
        <StorylineDialog
          agencyMap={new Map([["fda", "Food and Drug Administration"]])}
          asOf="2026-07-12"
          close={vi.fn()}
          item={item}
        />
      </QueryClientProvider>,
    );

    expect(screen.getByText("Latest overview")).toBeTruthy();
    expect(screen.getByText("V2")).toBeTruthy();
    expect(screen.getByText("2026-07-10")).toBeTruthy();
    expect(
      screen.getByText("FDA published a concise timeline development."),
    ).toBeTruthy();
    expect(screen.queryByText(denseEpisodeSummary)).toBeNull();
    expect(screen.queryByText("Episode 01")).toBeNull();
  });

  it("animates the dialog closed before removing it", () => {
    const client = queryClient();
    const close = vi.fn();
    const view = render(
      <QueryClientProvider client={client}>
        <StorylineDialog
          agencyMap={new Map([["fda", "Food and Drug Administration"]])}
          asOf="2026-07-12"
          close={close}
          item={item}
        />
      </QueryClientProvider>,
    );
    const dialog = view.container.querySelector("dialog");

    fireEvent.click(screen.getByRole("button", { name: "Close storyline" }));

    expect(dialog?.classList.contains("is-closing")).toBe(true);
    expect(close).not.toHaveBeenCalled();

    if (dialog !== null) fireEvent.animationEnd(dialog);
    expect(close).toHaveBeenCalledOnce();
  });

  it("renders table rows from the selected historical snapshot", () => {
    const client = queryClient();
    render(
      <QueryClientProvider client={client}>
        <table>
          <tbody>
            <StorylineTableRow
              agencyMap={new Map([["fda", "Food and Drug Administration"]])}
              asOf="2026-07-11"
              item={item}
              onOpen={vi.fn()}
            />
          </tbody>
        </table>
      </QueryClientProvider>,
    );

    expect(screen.getByText("Card version 1")).toBeTruthy();
    expect(screen.getByText("2026-07-10")).toBeTruthy();
    expect(screen.queryByText("FDA issues a reviewed update")).toBeNull();
    expect(screen.queryByText("2026-07-12")).toBeNull();
  });

  it("renders explicit placeholders while image and synthesis enrichment are pending", () => {
    const client = queryClient();
    const pendingCard: Card = {
      ...firstCard,
      articleOverview: null,
      thumbnail: null,
    };
    client.setQueryData(["storyline", storylineId], {
      ...detail,
      overviewCards: [pendingCard],
    });

    render(
      <QueryClientProvider client={client}>
        <StorylineCard
          agencyMap={new Map([["fda", "Food and Drug Administration"]])}
          asOf="2026-07-10"
          item={item}
          onOpen={vi.fn()}
          placement={placement}
        />
        <StorylineDialog
          agencyMap={new Map([["fda", "Food and Drug Administration"]])}
          asOf="2026-07-10"
          close={vi.fn()}
          item={item}
        />
      </QueryClientProvider>,
    );

    expect(screen.getByText("Event image pending")).toBeTruthy();
    expect(screen.getByText("Editorial enrichment queued")).toBeTruthy();
    expect(screen.getByText("Article synthesis pending")).toBeTruthy();
    expect(
      screen.getByText(
        "Source records remain available below while the aggregate analysis is prepared.",
      ),
    ).toBeTruthy();
  });

  it("does not render a storyline before an event-card version exists", () => {
    const client = queryClient();
    client.setQueryData(["storyline", storylineId], {
      ...detail,
      overviewCards: [],
    });

    const view = render(
      <QueryClientProvider client={client}>
        <StorylineCard
          agencyMap={new Map([["fda", "Food and Drug Administration"]])}
          asOf="2026-07-10"
          item={item}
          onOpen={vi.fn()}
          placement={placement}
        />
      </QueryClientProvider>,
    );

    expect(view.container.firstChild).toBeNull();
    expect(screen.queryByText("Storyline overview pending")).toBeNull();
    expect(screen.queryByText("Current affairs")).toBeNull();
  });
});

describe("filter option layout", () => {
  it("animates surviving options into alignment after an option disappears", () => {
    const animate = vi.fn();
    const originalAnimate = HTMLElement.prototype.animate;
    Object.defineProperty(HTMLElement.prototype, "animate", {
      configurable: true,
      value: animate,
    });
    const bounds = vi
      .spyOn(HTMLElement.prototype, "getBoundingClientRect")
      .mockImplementation(function (this: HTMLElement) {
        const isSecondOption = this.dataset.filterOption === "theme-2";
        const firstOptionExists = document.querySelector(
          '[data-filter-option="theme-1"]',
        );
        const left = isSecondOption && firstOptionExists !== null ? 100 : 0;
        return {
          bottom: 0,
          height: 0,
          left,
          right: left,
          toJSON: () => ({}),
          top: 0,
          width: 0,
          x: left,
          y: 0,
        };
      });

    try {
      const props = {
        animateLayout: true,
        label: "Theme",
        onToggle: vi.fn(),
        selected: new Set<string>(),
      };
      const view = render(
        <FilterGroup
          {...props}
          options={[
            { label: "Food safety", value: "theme-1" },
            { label: "Wildfire response", value: "theme-2" },
          ]}
        />,
      );

      view.rerender(
        <FilterGroup
          {...props}
          options={[{ label: "Wildfire response", value: "theme-2" }]}
        />,
      );

      expect(animate).toHaveBeenCalledWith(
        [{ transform: "translateX(100px)" }, { transform: "translateX(0)" }],
        {
          duration: filterMotion.layoutDurationMs,
          easing: filterMotion.layoutEasing,
        },
      );
    } finally {
      bounds.mockRestore();
      Object.defineProperty(HTMLElement.prototype, "animate", {
        configurable: true,
        value: originalAnimate,
      });
    }
  });
});
