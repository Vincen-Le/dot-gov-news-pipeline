import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type {
  Card,
  StorylineDetail,
  StorylineListItem,
} from "../src/api/contracts";
import { StorylineCard, StorylineDialog } from "../src/components";

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
  headline: "FDA issues a reviewed update",
  id: storylineId,
  newestEntryAt: "2026-07-12T12:00:00.000Z",
  rankKey: 8,
  themeId: null,
  themeName: null,
  unreviewedEntryCount: 0,
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
      cardUrl: `/api/lab/assets/event-cards/${id}/card`,
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
        />
      </QueryClientProvider>,
    );

    const firstImage = screen.getByAltText("First card illustration");
    expect(firstImage.getAttribute("src")).toBe(firstCard.thumbnail?.cardUrl);
    expect((firstImage as HTMLImageElement).style.objectPosition).toBe(
      "25% 75%",
    );

    view.rerender(
      <QueryClientProvider client={client}>
        <StorylineCard
          agencyMap={new Map([["fda", "Food and Drug Administration"]])}
          asOf="2026-07-12"
          item={item}
          onOpen={vi.fn()}
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

  it("renders an overview placeholder before an event-card version exists", () => {
    const client = queryClient();
    client.setQueryData(["storyline", storylineId], {
      ...detail,
      overviewCards: [],
    });

    render(
      <QueryClientProvider client={client}>
        <StorylineCard
          agencyMap={new Map([["fda", "Food and Drug Administration"]])}
          asOf="2026-07-10"
          item={item}
          onOpen={vi.fn()}
        />
      </QueryClientProvider>,
    );

    expect(screen.getByText("Storyline overview pending")).toBeTruthy();
    expect(screen.queryByText("Current affairs")).toBeNull();
  });
});
