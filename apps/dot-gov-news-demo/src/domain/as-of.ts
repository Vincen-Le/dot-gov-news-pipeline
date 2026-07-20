import type {
  Card,
  Episode,
  StorylineDetail,
  StorylineListItem,
  Theme,
} from "../api/contracts";

export function isoDay(value: string | null | undefined): string | null {
  if (value === null || value === undefined) return null;
  const date = new Date(value);
  return Number.isNaN(date.valueOf()) ? null : date.toISOString().slice(0, 10);
}

export function endOfDay(day: string): number {
  return Date.parse(`${day}T23:59:59.999Z`);
}

export function isAvailableAsOf(
  storyline: StorylineListItem,
  day: string,
): boolean {
  return (
    storyline.unreviewedEntryCount === 0 &&
    storyline.firstOverviewAt !== null &&
    Date.parse(storyline.firstOverviewAt) <= endOfDay(day)
  );
}

export function rankKeyAsOf(
  storyline: StorylineListItem,
  day: string,
): number | null {
  if (storyline.rankHistory === undefined) return storyline.rankKey;
  const cutoff = endOfDay(day);
  return (
    storyline.rankHistory
      .filter((snapshot) => Date.parse(snapshot.newestEntryAt) <= cutoff)
      .sort((left, right) => right.version - left.version)[0]?.rankKey ?? null
  );
}

export const THEME_SURFACE_THRESHOLD = 4;
export const THEME_ACTIVE_WINDOW_DAYS = 2;

export function isThemeAvailableAsOf(
  theme: Theme,
  storylines: StorylineListItem[],
  day: string,
): boolean {
  const requiredStorylines = theme.manuallySet ? 1 : THEME_SURFACE_THRESHOLD;
  const themedStorylines = storylines.filter(
    (storyline) =>
      storyline.themeId === theme.id && isAvailableAsOf(storyline, day),
  );
  if (themedStorylines.length < requiredStorylines) return false;

  const newestStorylineDay = themedStorylines
    .flatMap((storyline) =>
      storyline.firstOverviewAt === null
        ? []
        : [storyline.firstOverviewAt.slice(0, 10)],
    )
    .sort()
    .at(-1);
  if (newestStorylineDay === undefined) return false;

  const oldestActiveDate = new Date(`${day}T12:00:00Z`);
  oldestActiveDate.setUTCDate(
    oldestActiveDate.getUTCDate() - THEME_ACTIVE_WINDOW_DAYS,
  );
  return newestStorylineDay >= oldestActiveDate.toISOString().slice(0, 10);
}

export function cardAsOf<T extends { newestEntryAt: string; version: number }>(
  cards: T[],
  day: string,
): T | null {
  const cutoff = endOfDay(day);
  return (
    cards
      .filter((card) => Date.parse(card.newestEntryAt) <= cutoff)
      .sort((left, right) => right.version - left.version)[0] ?? null
  );
}

export function episodesAsOf(episodes: Episode[], day: string): Episode[] {
  const cutoff = endOfDay(day);
  return episodes
    .filter((episode) => Date.parse(episode.firstEntryAt) <= cutoff)
    .map((episode) => ({
      ...episode,
      card:
        episode.card !== null &&
        Date.parse(episode.card.newestEntryAt) <= cutoff
          ? episode.card
          : null,
      entries: episode.entries.filter(
        (entry) =>
          entry.publishedAt !== null && Date.parse(entry.publishedAt) <= cutoff,
      ),
    }))
    .filter((episode) => episode.entries.length > 0)
    .sort(
      (left, right) =>
        Date.parse(right.firstEntryAt) - Date.parse(left.firstEntryAt),
    );
}

export function detailAsOf(
  detail: StorylineDetail,
  day: string,
): { overview: Card | null; episodes: Episode[] } {
  return {
    episodes: episodesAsOf(detail.episodes, day),
    overview: cardAsOf(detail.overviewCards, day),
  };
}
