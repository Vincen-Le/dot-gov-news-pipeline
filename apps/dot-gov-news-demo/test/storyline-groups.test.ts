import { describe, expect, it } from "vitest";

import type { StorylineListItem } from "../src/api/contracts";
import { groupStorylinesForTable } from "../src/domain/storyline-groups";

function storyline(
  id: string,
  categoryName: string | null,
  themeId: string | null,
  themeName: string | null,
): StorylineListItem {
  return {
    agencies: [],
    categoryName,
    distinctFeeds: 1,
    entities: [],
    entryCount: 1,
    episodeCount: 1,
    eventKeys: [],
    firstEntryAt: "2026-07-01T00:00:00.000Z",
    firstOverviewAt: "2026-07-01T00:00:00.000Z",
    headline: id,
    id,
    newestEntryAt: "2026-07-01T00:00:00.000Z",
    rankKey: 1,
    themeId,
    themeName,
    unreviewedEntryCount: 0,
  };
}

describe("groupStorylinesForTable", () => {
  const items = [
    storyline("health-2", "Health", "health", "Public Health"),
    storyline("budget", "Economy", "budget", "Federal Budget"),
    storyline("health-1", "Health", "health", "Public Health"),
    storyline("other", null, null, null),
  ];

  it("groups themes alphabetically, preserves row order, and puts unassigned last", () => {
    const groups = groupStorylinesForTable(items, "theme");

    expect(groups.map((group) => group.label)).toEqual([
      "Federal Budget",
      "Public Health",
      "No theme",
    ]);
    expect(groups[1]?.items.map((item) => item.id)).toEqual([
      "health-2",
      "health-1",
    ]);
  });

  it("groups by category and labels unassigned storylines", () => {
    const groups = groupStorylinesForTable(items, "category");

    expect(groups.map((group) => group.label)).toEqual([
      "Economy",
      "Health",
      "Uncategorized",
    ]);
  });
});
