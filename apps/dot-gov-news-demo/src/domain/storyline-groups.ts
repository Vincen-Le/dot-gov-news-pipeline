import type { StorylineListItem } from "../api/contracts";

export type StorylineGroupBy = "category" | "theme";

export interface StorylineTableGroup {
  items: StorylineListItem[];
  key: string;
  label: string;
  unassigned: boolean;
}

export function groupStorylinesForTable(
  items: StorylineListItem[],
  groupBy: StorylineGroupBy,
): StorylineTableGroup[] {
  const groups = new Map<string, StorylineTableGroup>();

  for (const item of items) {
    const unassigned =
      groupBy === "theme" ? item.themeId === null : item.categoryName === null;
    const key =
      groupBy === "theme"
        ? `theme:${item.themeId ?? "unassigned"}`
        : `category:${item.categoryName ?? "unassigned"}`;
    const label =
      groupBy === "theme"
        ? (item.themeName ?? "No theme")
        : (item.categoryName ?? "Uncategorized");
    const group = groups.get(key);
    if (group === undefined) {
      groups.set(key, { items: [item], key, label, unassigned });
    } else {
      group.items.push(item);
    }
  }

  return [...groups.values()].sort((left, right) => {
    if (left.unassigned !== right.unassigned) return left.unassigned ? 1 : -1;
    return left.label.localeCompare(right.label);
  });
}
