import { describe, expect, it } from "vitest";

import type { StorylineListItem } from "../src/api/contracts";
import { relativeStorylinePlacements } from "../src/domain/relative-rank";

function storyline(
  id: string,
  rankKey: number | null,
  agencies: string[],
  categoryName: string | null,
): StorylineListItem {
  return {
    agencies,
    categoryName,
    distinctFeeds: 1,
    entities: [],
    entryCount: 1,
    episodeCount: 1,
    eventKeys: [],
    firstEntryAt: `2026-07-${id.padStart(2, "0")}T12:00:00.000Z`,
    firstOverviewAt: "2026-07-01T12:00:00.000Z",
    headline: `Storyline ${id}`,
    id,
    newestEntryAt: "2026-07-20T12:00:00.000Z",
    rankKey,
    themeId: null,
    themeName: null,
    unreviewedEntryCount: 0,
  };
}

describe("relative storyline placements", () => {
  it("ranks each storyline within its primary agency and category", () => {
    const placements = relativeStorylinePlacements([
      storyline("1", 100, ["fda", "hhs"], "Public Health"),
      storyline("2", 90, ["fda"], "Consumer Safety"),
      storyline("3", 80, ["epa"], "Public Health"),
      storyline("4", 70, ["hhs"], "Public Health"),
    ]);

    expect(placements.get("1")).toEqual({
      agencyKey: "fda",
      agencyPosition: 1,
      categoryPosition: 1,
    });
    expect(placements.get("2")).toEqual({
      agencyKey: "fda",
      agencyPosition: 2,
      categoryPosition: 1,
    });
    expect(placements.get("3")).toEqual({
      agencyKey: "epa",
      agencyPosition: 1,
      categoryPosition: 2,
    });
    expect(placements.get("4")).toEqual({
      agencyKey: "hhs",
      agencyPosition: 2,
      categoryPosition: 3,
    });
  });

  it("leaves missing rank, agency, and category positions unranked", () => {
    const placements = relativeStorylinePlacements([
      storyline("1", null, ["fda"], "Public Health"),
      storyline("2", 10, [], null),
    ]);

    expect(placements.get("1")).toEqual({
      agencyKey: "fda",
      agencyPosition: null,
      categoryPosition: null,
    });
    expect(placements.get("2")).toEqual({
      agencyKey: null,
      agencyPosition: null,
      categoryPosition: null,
    });
  });
});
