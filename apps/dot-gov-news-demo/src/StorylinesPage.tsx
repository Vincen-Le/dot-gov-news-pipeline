import { useQuery } from "@tanstack/react-query";
import { useEffect, useMemo, useRef, useState } from "react";
import { useSearchParams } from "react-router-dom";

import type { StorylineListItem, StorylinePreview } from "./api/contracts";
import { dotGovApi } from "./api/client";
import {
  agencyNames,
  FilterGroup,
  StatePanel,
  StorylineCard,
  StorylineDialog,
  StorylineTableRow,
  type FilterOption,
} from "./components";
import {
  cardAsOf,
  isAvailableAsOf,
  isThemeAvailableAsOf,
  rankKeyAsOf,
} from "./domain/as-of";
import { relativeStorylinePlacements } from "./domain/relative-rank";
import {
  groupStorylinesForTable,
  type StorylineGroupBy,
} from "./domain/storyline-groups";
import { StorylinesHero } from "./StorylinesHero";

const RENDER_BATCH_SIZE = 18;
const LOAD_AHEAD_ROOT_MARGIN = "1200px 0px";

type SortOrder = "episodes" | "newest" | "rank";
type ViewMode = "product" | "table";

function toggled(current: Set<string>, value: string): Set<string> {
  const next = new Set(current);
  if (next.has(value)) next.delete(value);
  else next.add(value);
  return next;
}

function optionSort(left: FilterOption, right: FilterOption): number {
  return left.label.localeCompare(right.label);
}

function retainAvailable(
  current: Set<string>,
  options: FilterOption[],
): Set<string> {
  const available = new Set(options.map((option) => option.value));
  const next = new Set([...current].filter((value) => available.has(value)));
  return next.size === current.size ? current : next;
}

export function StorylinesPage({ asOf }: { asOf: string }) {
  const [params, setParams] = useSearchParams();
  const [agencies, setAgencies] = useState<Set<string>>(new Set());
  const [categories, setCategories] = useState<Set<string>>(new Set());
  const [themes, setThemes] = useState<Set<string>>(new Set());
  const [sort, setSort] = useState<SortOrder>("rank");
  const [view, setView] = useState<ViewMode>("product");
  const [groupBy, setGroupBy] = useState<StorylineGroupBy>("theme");
  const [visibleCount, setVisibleCount] = useState(RENDER_BATCH_SIZE);
  const loadMore = useRef<HTMLDivElement>(null);

  const bootstrap = useQuery({
    queryFn: ({ signal }) => dotGovApi.bootstrap(signal),
    queryKey: ["bootstrap"],
  });

  const agencyMap = useMemo(
    () => agencyNames(bootstrap.data?.agencies ?? []),
    [bootstrap.data],
  );
  const available = useMemo(
    () =>
      (bootstrap.data?.storylines.items ?? [])
        .filter((item) => isAvailableAsOf(item, asOf))
        .map((item) => ({ ...item, rankKey: rankKeyAsOf(item, asOf) })),
    [asOf, bootstrap.data],
  );
  const previewByStoryline = useMemo(
    () =>
      new Map<string, StorylinePreview>(
        (bootstrap.data?.previews ?? []).map((preview) => [
          preview.storylineId,
          preview,
        ]),
      ),
    [bootstrap.data],
  );
  const topStoryline = useMemo(
    () =>
      available.reduce<StorylineListItem | null>((top, item) => {
        if (item.rankKey === null) return top;
        if (
          top === null ||
          top.rankKey === null ||
          item.rankKey > top.rankKey
        ) {
          return item;
        }
        return top;
      }, null),
    [available],
  );
  const heroArtwork = useMemo(() => {
    if (topStoryline === null) return null;
    const preview = previewByStoryline.get(topStoryline.id);
    if (preview === undefined) return undefined;
    return cardAsOf(preview.overviewCards, asOf)?.thumbnail ?? null;
  }, [asOf, previewByStoryline, topStoryline]);
  const placements = useMemo(
    () => relativeStorylinePlacements(available),
    [available],
  );

  const agencyOptions = useMemo(() => {
    const keys = new Set(available.flatMap((item) => item.agencies));
    return [...keys]
      .map((key) => ({ label: agencyMap.get(key) ?? key, value: key }))
      .sort(optionSort);
  }, [agencyMap, available]);
  const categoryOptions = useMemo(() => {
    const names = new Set(
      available.flatMap((item) =>
        item.categoryName === null ? [] : [item.categoryName],
      ),
    );
    const ordered = (bootstrap.data?.categories ?? [])
      .filter((category) => names.has(category.displayName))
      .map((category) => ({
        label: category.displayName,
        value: category.displayName,
      }));
    return ordered.length > 0
      ? ordered
      : [...names]
          .map((name) => ({ label: name, value: name }))
          .sort(optionSort);
  }, [available, bootstrap.data]);
  const themeOptions = useMemo(() => {
    const ids = new Set(
      available.flatMap((item) =>
        item.themeId === null ? [] : [item.themeId],
      ),
    );
    return (bootstrap.data?.themes ?? [])
      .filter(
        (theme) =>
          ids.has(theme.id) && isThemeAvailableAsOf(theme, available, asOf),
      )
      .map((theme) => ({ label: theme.displayName, value: theme.id }))
      .sort(optionSort);
  }, [asOf, available, bootstrap.data]);
  const surfacedThemeIds = useMemo(
    () => new Set(themeOptions.map((theme) => theme.value)),
    [themeOptions],
  );

  useEffect(
    () => setAgencies((current) => retainAvailable(current, agencyOptions)),
    [agencyOptions],
  );
  useEffect(
    () => setCategories((current) => retainAvailable(current, categoryOptions)),
    [categoryOptions],
  );
  useEffect(
    () => setThemes((current) => retainAvailable(current, themeOptions)),
    [themeOptions],
  );

  const filtered = useMemo(() => {
    const items = available.filter(
      (item) =>
        (agencies.size === 0 ||
          item.agencies.some((key) => agencies.has(key))) &&
        (categories.size === 0 ||
          (item.categoryName !== null && categories.has(item.categoryName))) &&
        (themes.size === 0 ||
          (item.themeId !== null && themes.has(item.themeId))),
    );
    return [...items].sort((left, right) => {
      if (sort === "episodes") {
        return right.episodeCount - left.episodeCount;
      }
      if (sort === "newest") {
        return Date.parse(right.newestEntryAt) - Date.parse(left.newestEntryAt);
      }
      if (left.rankKey === null) return 1;
      if (right.rankKey === null) return -1;
      return right.rankKey - left.rankKey;
    });
  }, [agencies, available, categories, sort, themes]);

  useEffect(
    () => setVisibleCount(RENDER_BATCH_SIZE),
    [agencies, asOf, categories, sort, themes],
  );

  useEffect(() => {
    const target = loadMore.current;
    if (
      target === null ||
      visibleCount >= filtered.length ||
      globalThis.IntersectionObserver === undefined
    ) {
      return;
    }
    const observer = new IntersectionObserver(
      (entries) => {
        if (!entries.some((entry) => entry.isIntersecting)) return;
        setVisibleCount((count) =>
          Math.min(count + RENDER_BATCH_SIZE, filtered.length),
        );
      },
      { rootMargin: LOAD_AHEAD_ROOT_MARGIN },
    );
    observer.observe(target);
    return () => observer.disconnect();
  }, [filtered.length, visibleCount]);

  const displayItem = (item: StorylineListItem): StorylineListItem =>
    item.themeId !== null && surfacedThemeIds.has(item.themeId)
      ? item
      : { ...item, themeId: null, themeName: null };
  const visibleItems = filtered.slice(0, visibleCount).map(displayItem);
  const tableGroups = groupStorylinesForTable(visibleItems, groupBy);

  const selectedId = params.get("storyline");
  const selectedSource =
    available.find((item) => item.id === selectedId) ?? null;
  const selected = selectedSource === null ? null : displayItem(selectedSource);
  const open = (item: StorylineListItem) => {
    const next = new URLSearchParams(params);
    next.set("storyline", item.id);
    setParams(next, { replace: true });
  };
  const close = () => {
    const next = new URLSearchParams(params);
    next.delete("storyline");
    setParams(next, { replace: true });
  };
  const clearFilters = () => {
    setAgencies(new Set());
    setCategories(new Set());
    setThemes(new Set());
  };

  if (bootstrap.isLoading) {
    return (
      <StatePanel title="Building the daily view">
        Loading approved storylines and their publishing history.
      </StatePanel>
    );
  }
  if (bootstrap.error) {
    return (
      <StatePanel title="The storyline API is unavailable">
        Confirm that this deployment can reach its server-side API origin.
      </StatePanel>
    );
  }

  return (
    <div className="page-stack">
      <StorylinesHero artwork={heroArtwork}>
        <div className="intro-content">
          <div>
            <p className="eyebrow">Government news connected.</p>
            <h1>Storylines</h1>
            <p className="intro-description">
              See how government actions unfold over time. Each storyline brings
              reviewed sources together and shows the public record as it stood
              on the date you select.
            </p>
          </div>
        </div>
      </StorylinesHero>

      <section className="workspace" aria-labelledby="browse-title">
        <header className="browse-heading">
          <div>
            <p className="eyebrow">Browse the current brief</p>
            <h2 id="browse-title">Reviewed storylines</h2>
          </div>
          <div className="view-switcher" aria-label="Choose storylines view">
            <button
              aria-pressed={view === "product"}
              className="view-button"
              onClick={() => setView("product")}
              type="button"
            >
              Product view
            </button>
            <button
              aria-pressed={view === "table"}
              className="view-button"
              onClick={() => setView("table")}
              type="button"
            >
              Table view
            </button>
          </div>
        </header>
        <div className="filter-deck" aria-label="Storyline filters">
          <FilterGroup
            label="Agency"
            onToggle={(value) =>
              setAgencies((current) => toggled(current, value))
            }
            options={agencyOptions}
            selected={agencies}
          />
          <FilterGroup
            label="Category"
            onToggle={(value) =>
              setCategories((current) => toggled(current, value))
            }
            options={categoryOptions}
            selected={categories}
          />
          <FilterGroup
            label="Theme"
            onToggle={(value) =>
              setThemes((current) => toggled(current, value))
            }
            options={themeOptions}
            selected={themes}
          />
        </div>

        <div className="toolbar">
          <div className="result-copy" aria-live="polite">
            Showing <strong>{filtered.length}</strong> of{" "}
            <strong>{available.length}</strong> reviewed storylines
          </div>
          <div className="table-controls">
            <div className="sort-field">
              <label htmlFor="storyline-sort">Sort by</label>
              <select
                id="storyline-sort"
                onChange={(event) => setSort(event.target.value as SortOrder)}
                value={sort}
              >
                <option value="rank">Ranking</option>
                <option value="newest">Newest update</option>
                <option value="episodes">Episode count</option>
              </select>
            </div>
            {view === "table" ? (
              <div className="sort-field">
                <label htmlFor="storyline-group">Group by</label>
                <select
                  id="storyline-group"
                  onChange={(event) =>
                    setGroupBy(event.target.value as StorylineGroupBy)
                  }
                  value={groupBy}
                >
                  <option value="theme">Theme</option>
                  <option value="category">Category</option>
                </select>
              </div>
            ) : null}
          </div>
          {agencies.size + categories.size + themes.size > 0 ? (
            <button
              className="clear-button"
              onClick={clearFilters}
              type="button"
            >
              Clear selected filters
            </button>
          ) : null}
        </div>

        {filtered.length === 0 ? (
          <StatePanel title="No matching storylines">
            Try clearing a filter or moving the publication date forward.
          </StatePanel>
        ) : view === "product" ? (
          <section className="storyline-grid" aria-label="Storylines">
            {visibleItems.map((item, index) => (
              <StorylineCard
                agencyMap={agencyMap}
                asOf={asOf}
                item={item}
                key={item.id}
                onOpen={() => open(item)}
                placement={placements.get(item.id)!}
                preview={previewByStoryline.get(item.id)}
                revealIndex={index}
              />
            ))}
          </section>
        ) : (
          <div className="table-view">
            <table>
              <thead>
                <tr>
                  <th scope="col">Ranking</th>
                  <th scope="col">Storyline</th>
                  <th scope="col">Agencies</th>
                  <th scope="col">Category / theme</th>
                  <th scope="col">Episodes</th>
                  <th scope="col">Articles</th>
                  <th scope="col">Newest</th>
                  <th scope="col">Review</th>
                </tr>
              </thead>
              {tableGroups.map((group) => (
                <tbody key={group.key}>
                  <tr className="table-group-heading">
                    <th colSpan={8} scope="rowgroup">
                      {group.label}
                    </th>
                  </tr>
                  {group.items.map((item) => (
                    <StorylineTableRow
                      agencyMap={agencyMap}
                      asOf={asOf}
                      item={item}
                      key={item.id}
                      onOpen={() => open(item)}
                      preview={previewByStoryline.get(item.id)}
                    />
                  ))}
                </tbody>
              ))}
            </table>
          </div>
        )}
        {visibleCount < filtered.length ? (
          <div className="load-more-sentinel" ref={loadMore}>
            <span aria-live="polite">
              {Math.min(visibleCount, filtered.length)} of {filtered.length}
            </span>
            <button
              className="load-more primary-button"
              onClick={() =>
                setVisibleCount((count) =>
                  Math.min(count + RENDER_BATCH_SIZE, filtered.length),
                )
              }
              type="button"
            >
              Load next storylines
            </button>
          </div>
        ) : null}
      </section>
      {selected === null ? null : (
        <StorylineDialog
          agencyMap={agencyMap}
          asOf={asOf}
          close={close}
          item={selected}
        />
      )}
    </div>
  );
}
