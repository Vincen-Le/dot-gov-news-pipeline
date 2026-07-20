import { describe, expect, it } from "vitest";

import {
  CardSchema,
  CategorySchema,
  EpisodeSchema,
  StorylineListItemSchema,
} from "../src/api/contracts";

const storyline = {
  agencies: ["fda"],
  categoryName: "Public Health",
  distinctFeeds: 1,
  entities: [],
  entryCount: 1,
  episodeCount: 1,
  eventKeys: [],
  firstEntryAt: "2026-07-18T12:00:00.000Z",
  firstOverviewAt: "2026-07-18T12:00:00.000Z",
  headline: "Reviewed update",
  id: "storyline-1",
  newestEntryAt: "2026-07-18T12:00:00.000Z",
  rankKey: 1,
  themeId: null,
  themeName: null,
};

describe("operator-console API contracts", () => {
  it("requires the reviewed-state field instead of defaulting missing data to reviewed", () => {
    expect(StorylineListItemSchema.safeParse(storyline).success).toBe(false);
    expect(
      StorylineListItemSchema.parse({
        ...storyline,
        unreviewedEntryCount: 0,
      }).unreviewedEntryCount,
    ).toBe(0);
  });

  it("accepts the API's dormant episode and LLM category values", () => {
    expect(
      EpisodeSchema.parse({
        attachMethod: "new_storyline",
        attachReason: null,
        card: null,
        entries: [],
        entryCount: 0,
        firstEntryAt: "2026-07-18T12:00:00.000Z",
        id: "episode-1",
        newestEntryAt: "2026-07-18T12:00:00.000Z",
        status: "dormant",
      }).status,
    ).toBe("dormant");
    expect(
      CategorySchema.parse({
        displayName: "Emergent policy area",
        id: "category-1",
        origin: "llm",
        proposalReason: "Grouped from reviewed stories",
        storylineCount: 1,
        themeCount: 1,
      }).origin,
    ).toBe("llm");
  });

  it("parses nullable generated content and card-scoped thumbnail metadata", () => {
    const card = CardSchema.parse({
      articleOverview: {
        keyPoints: [
          { sourceEntryIds: ["entry-1"], text: "First detail" },
          { sourceEntryIds: ["entry-1"], text: "Second detail" },
        ],
        summary: {
          sourceEntryIds: ["entry-1"],
          text: "The agency issued the update.",
        },
      },
      generatedAt: "2026-07-18T12:00:00.000Z",
      headline: "Reviewed update",
      id: "card-1",
      interestReason: null,
      kind: "overview",
      newestEntryAt: "2026-07-18T11:30:00.000Z",
      rankKey: 1,
      summary: "Reviewed summary",
      thumbnail: {
        altText: "Geometric editorial illustration of an agency notice.",
        cardUrl: "/api/lab/assets/event-cards/card-1/card",
        focalX: 0.25,
        focalY: 0.75,
      },
      timeline: null,
      version: 1,
    });

    expect(card.articleOverview?.keyPoints).toHaveLength(2);
    expect(card).toMatchObject({
      generatedAt: "2026-07-18T12:00:00.000Z",
      newestEntryAt: "2026-07-18T11:30:00.000Z",
    });
    expect(card.thumbnail?.focalY).toBe(0.75);
    expect(
      CardSchema.parse({
        generatedAt: "2026-07-18T12:00:00.000Z",
        headline: "Legacy card",
        id: "card-2",
        interestReason: null,
        kind: "overview",
        newestEntryAt: "2026-07-18T12:00:00.000Z",
        rankKey: 1,
        summary: "Reviewed summary",
        timeline: null,
        version: 1,
      }),
    ).toMatchObject({ articleOverview: null, thumbnail: null });
  });
});
