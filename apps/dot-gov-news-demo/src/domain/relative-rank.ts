import type { StorylineListItem } from "../api/contracts";

export interface StorylinePlacement {
  agencyKey: string | null;
  agencyPosition: number | null;
  categoryPosition: number | null;
}

function byRank(left: StorylineListItem, right: StorylineListItem): number {
  if (left.rankKey === null) return right.rankKey === null ? 0 : 1;
  if (right.rankKey === null) return -1;
  return (
    right.rankKey - left.rankKey ||
    left.firstEntryAt.localeCompare(right.firstEntryAt) ||
    (left.headline ?? "").localeCompare(right.headline ?? "") ||
    left.id.localeCompare(right.id)
  );
}

export function relativeStorylinePlacements(
  storylines: StorylineListItem[],
): Map<string, StorylinePlacement> {
  const placements = new Map<string, StorylinePlacement>(
    storylines.map((storyline) => [
      storyline.id,
      {
        agencyKey: storyline.agencies[0] ?? null,
        agencyPosition: null,
        categoryPosition: null,
      },
    ]),
  );
  const agencyCounts = new Map<string, number>();
  const categoryCounts = new Map<string, number>();

  for (const storyline of [...storylines].sort(byRank)) {
    if (storyline.rankKey === null) continue;

    const agencyKey = storyline.agencies[0] ?? null;
    let agencyPosition: number | null = null;
    for (const agency of new Set(storyline.agencies)) {
      const position = (agencyCounts.get(agency) ?? 0) + 1;
      agencyCounts.set(agency, position);
      if (agency === agencyKey) agencyPosition = position;
    }

    let categoryPosition: number | null = null;
    if (storyline.categoryName !== null) {
      categoryPosition = (categoryCounts.get(storyline.categoryName) ?? 0) + 1;
      categoryCounts.set(storyline.categoryName, categoryPosition);
    }

    placements.set(storyline.id, {
      agencyKey,
      agencyPosition,
      categoryPosition,
    });
  }

  return placements;
}
