import { describe, expect, it } from "vitest";

import type {
  Card,
  Episode,
  StorylineListItem,
  Theme,
} from "../src/api/contracts";
import {
  cardAsOf,
  episodesAsOf,
  isAvailableAsOf,
  isThemeAvailableAsOf,
} from "../src/domain/as-of";

const storyline: StorylineListItem = {
  agencies: ["epa"],
  categoryName: "Environment",
  distinctFeeds: 1,
  entities: [],
  entryCount: 1,
  episodeCount: 1,
  eventKeys: [],
  firstEntryAt: "2026-07-10T12:00:00.000Z",
  firstOverviewAt: "2026-07-11T12:00:00.000Z",
  headline: "Test storyline",
  id: "storyline-1",
  newestEntryAt: "2026-07-10T12:00:00.000Z",
  rankKey: 0.8,
  themeId: "theme-1",
  themeName: "Air quality",
  unreviewedEntryCount: 0,
};

const cards: Card[] = [
  {
    articleOverview: null,
    generatedAt: "2026-07-20T18:00:00.000Z",
    headline: "First version",
    id: "card-1",
    interestReason: null,
    kind: "overview",
    newestEntryAt: "2026-07-10T18:00:00.000Z",
    rankKey: 0.5,
    summary: "First summary",
    thumbnail: null,
    timeline: null,
    version: 1,
  },
  {
    articleOverview: null,
    generatedAt: "2026-07-20T18:00:00.000Z",
    headline: "Second version",
    id: "card-2",
    interestReason: null,
    kind: "overview",
    newestEntryAt: "2026-07-12T18:00:00.000Z",
    rankKey: 0.7,
    summary: "Second summary",
    thumbnail: null,
    timeline: null,
    version: 2,
  },
];

describe("as-of selection", () => {
  it("excludes storylines until their first event card exists", () => {
    expect(isAvailableAsOf(storyline, "2026-07-09")).toBe(false);
    expect(isAvailableAsOf(storyline, "2026-07-10")).toBe(false);
    expect(isAvailableAsOf(storyline, "2026-07-11")).toBe(true);
    expect(
      isAvailableAsOf({ ...storyline, unreviewedEntryCount: 1 }, "2026-07-11"),
    ).toBe(false);
  });

  it("only exposes a generated theme once four storylines have emerged", () => {
    const theme: Theme = {
      categoryId: null,
      categoryName: null,
      displayName: "Food safety",
      firstStorylineAt: "2025-07-20T14:00:00.000Z",
      id: "theme-1",
      manuallySet: false,
      newestStorylineAt: "2025-07-25T14:00:00.000Z",
      storylineCount: 4,
    };
    const storylines = [20, 21, 22, 23].map((day, index) => ({
      ...storyline,
      firstEntryAt: `2025-07-${day}T14:00:00.000Z`,
      firstOverviewAt: `2025-07-${day}T14:00:00.000Z`,
      id: `storyline-${index + 1}`,
    }));

    expect(isThemeAvailableAsOf(theme, storylines, "2025-07-22")).toBe(false);
    expect(isThemeAvailableAsOf(theme, storylines, "2025-07-23")).toBe(true);
  });

  it("exposes a manually set theme with its first emerged storyline", () => {
    const theme: Theme = {
      categoryId: null,
      categoryName: null,
      displayName: "Food safety",
      firstStorylineAt: "2025-07-20T14:00:00.000Z",
      id: "theme-1",
      manuallySet: true,
      newestStorylineAt: "2025-07-20T14:00:00.000Z",
      storylineCount: 1,
    };
    const firstStoryline = {
      ...storyline,
      firstEntryAt: "2025-07-20T14:00:00.000Z",
      firstOverviewAt: "2025-07-20T14:00:00.000Z",
    };

    expect(isThemeAvailableAsOf(theme, [firstStoryline], "2025-07-19")).toBe(
      false,
    );
    expect(isThemeAvailableAsOf(theme, [firstStoryline], "2025-07-20")).toBe(
      true,
    );
  });

  it("uses the newest card whose represented news event was published by the selected date", () => {
    expect(cardAsOf(cards, "2026-07-11")?.id).toBe("card-1");
    expect(cardAsOf(cards, "2026-07-12")?.id).toBe("card-2");
  });

  it("reveals an episode card at its event time rather than its later processing time", () => {
    const episode: Episode = {
      attachMethod: "new_storyline",
      attachReason: null,
      card: { ...cards[0]!, kind: "episode" },
      entries: [
        {
          agency: "epa",
          attachMethod: "new_cluster",
          entitySet: [],
          eventKeys: [],
          id: "entry-1",
          matchedEntryId: null,
          publishedAt: "2026-07-09T12:00:00.000Z",
          similarity: null,
          thresholdUsed: null,
          title: "Initial announcement",
          url: "https://epa.gov/initial",
        },
        {
          agency: "epa",
          attachMethod: "knn_join",
          entitySet: [],
          eventKeys: [],
          id: "entry-2",
          matchedEntryId: "entry-1",
          publishedAt: "2026-07-10T18:00:00.000Z",
          similarity: 0.9,
          thresholdUsed: 0.8,
          title: "Follow-up announcement",
          url: "https://epa.gov/follow-up",
        },
      ],
      entryCount: 2,
      firstEntryAt: "2026-07-09T12:00:00.000Z",
      id: "episode-1",
      newestEntryAt: "2026-07-10T18:00:00.000Z",
      status: "dormant",
    };

    expect(episodesAsOf([episode], "2026-07-09")[0]?.card).toBeNull();
    expect(episodesAsOf([episode], "2026-07-10")[0]?.card?.id).toBe("card-1");
  });
});
