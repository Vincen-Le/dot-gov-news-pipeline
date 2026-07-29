import { useQuery } from "@tanstack/react-query";
import {
  lazy,
  Suspense,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
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
import { filterMotion } from "./motion";
import { StorylinesHero } from "./StorylinesHero";

const RENDER_BATCH_SIZE = 18;
const LOAD_AHEAD_ROOT_MARGIN = "1200px 0px";
const ExplorerView = lazy(() =>
  import("./ExplorerView").then((module) => ({
    default: module.ExplorerView,
  })),
);

type SortOrder = "episodes" | "newest" | "rank";
type ViewMode = "explorer" | "product" | "table";

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

function useFilterPresence(options: FilterOption[]): {
  completeExit: (value: string) => void;
  exitingIds: ReadonlySet<string>;
  options: FilterOption[];
} {
  const [displayed, setDisplayed] = useState(options);
  const [exitingIds, setExitingIds] = useState<ReadonlySet<string>>(new Set());
  const displayedRef = useRef(displayed);
  const pendingExitIds = useRef(new Set<string>());
  const retainedAfterExit = useRef(options);
  const incomingAfterExit = useRef(options);
  const entryTimer =
    useRef<ReturnType<typeof globalThis.setTimeout>>(undefined);

  useEffect(() => {
    if (entryTimer.current !== undefined) {
      globalThis.clearTimeout(entryTimer.current);
      entryTimer.current = undefined;
    }

    const activeIds = new Set(options.map((option) => option.value));
    const exiting = displayedRef.current.filter(
      (option) => !activeIds.has(option.value),
    );
    const displayedIds = new Set(
      displayedRef.current.map((option) => option.value),
    );
    const retained = options.filter((option) => displayedIds.has(option.value));
    const nextDisplayed = [...retained, ...exiting].sort(optionSort);
    const nextExitingIds = new Set(exiting.map((option) => option.value));

    if (exiting.length === 0) {
      pendingExitIds.current.clear();
      displayedRef.current = options;
      setDisplayed(options);
      setExitingIds(nextExitingIds);
      return;
    }

    pendingExitIds.current = new Set(nextExitingIds);
    retainedAfterExit.current = retained;
    incomingAfterExit.current = options;
    displayedRef.current = nextDisplayed;
    setDisplayed(nextDisplayed);
    setExitingIds(nextExitingIds);
  }, [options]);

  const completeExit = useCallback((value: string) => {
    if (!pendingExitIds.current.delete(value)) return;
    if (pendingExitIds.current.size > 0) return;

    const retained = retainedAfterExit.current;
    const incoming = incomingAfterExit.current;
    displayedRef.current = retained;
    setDisplayed(retained);
    setExitingIds(new Set());

    const retainedIds = new Set(retained.map((option) => option.value));
    const hasIncoming = incoming.some(
      (option) => !retainedIds.has(option.value),
    );
    if (!hasIncoming) return;

    entryTimer.current = globalThis.setTimeout(() => {
      displayedRef.current = incomingAfterExit.current;
      setDisplayed(incomingAfterExit.current);
      entryTimer.current = undefined;
    }, filterMotion.entryDelayMs);
  }, []);

  useEffect(
    () => () => {
      if (entryTimer.current !== undefined) {
        globalThis.clearTimeout(entryTimer.current);
      }
    },
    [],
  );

  return { completeExit, exitingIds, options: displayed };
}

export function StorylinesPage({ asOf }: { asOf: string }) {
  const [params, setParams] = useSearchParams();
  const agencies = useMemo(() => new Set(params.getAll("agency")), [params]);
  const categories = useMemo(
    () => new Set(params.getAll("category")),
    [params],
  );
  const themes = useMemo(() => new Set(params.getAll("theme")), [params]);
  const requestedSort = params.get("sort");
  const sort: SortOrder =
    requestedSort === "episodes" || requestedSort === "newest"
      ? requestedSort
      : "rank";
  const requestedView = params.get("view");
  const view: ViewMode =
    requestedView === "table" || requestedView === "explorer"
      ? requestedView
      : "product";
  const groupBy: StorylineGroupBy =
    params.get("group") === "category" ? "category" : "theme";
  const [visibleCount, setVisibleCount] = useState(RENDER_BATCH_SIZE);
  const loadMore = useRef<HTMLDivElement>(null);

  const setValues = useCallback(
    (key: string, values: ReadonlySet<string>) => {
      setParams((current) => {
        const next = new URLSearchParams(current);
        next.delete(key);
        for (const value of [...values].sort()) next.append(key, value);
        return next;
      });
    },
    [setParams],
  );
  const setValue = useCallback(
    (key: string, value: string, defaultValue: string) => {
      setParams((current) => {
        const next = new URLSearchParams(current);
        if (value === defaultValue) next.delete(key);
        else next.set(key, value);
        return next;
      });
    },
    [setParams],
  );

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
  const displayedAgencies = useFilterPresence(agencyOptions);
  const displayedCategories = useFilterPresence(categoryOptions);
  const displayedThemes = useFilterPresence(themeOptions);
  const surfacedThemeIds = useMemo(
    () => new Set(displayedThemes.options.map((theme) => theme.value)),
    [displayedThemes.options],
  );

  useEffect(() => {
    if (bootstrap.data === undefined) return;
    const retainedAgencies = retainAvailable(agencies, agencyOptions);
    const retainedCategories = retainAvailable(categories, categoryOptions);
    const retainedThemes = retainAvailable(themes, themeOptions);
    if (
      retainedAgencies === agencies &&
      retainedCategories === categories &&
      retainedThemes === themes
    ) {
      return;
    }
    setParams(
      (current) => {
        const next = new URLSearchParams(current);
        for (const [key, values] of [
          ["agency", retainedAgencies],
          ["category", retainedCategories],
          ["theme", retainedThemes],
        ] as const) {
          next.delete(key);
          for (const value of [...values].sort()) next.append(key, value);
        }
        return next;
      },
      { replace: true },
    );
  }, [
    agencies,
    agencyOptions,
    bootstrap.data,
    categories,
    categoryOptions,
    setParams,
    themes,
    themeOptions,
  ]);

  const filtered = useMemo(() => {
    const hasNoSelections =
      agencies.size === 0 && categories.size === 0 && themes.size === 0;
    const items = available.filter(
      (item) =>
        hasNoSelections ||
        (agencies.size > 0 && item.agencies.some((key) => agencies.has(key))) ||
        (categories.size > 0 &&
          item.categoryName !== null &&
          categories.has(item.categoryName)) ||
        (themes.size > 0 && item.themeId !== null && themes.has(item.themeId)),
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
  const topStoryline = useMemo(
    () =>
      filtered.reduce<StorylineListItem | null>((top, item) => {
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
    [filtered],
  );
  const heroArtwork = useMemo(() => {
    if (topStoryline === null) return null;
    const preview = previewByStoryline.get(topStoryline.id);
    if (preview === undefined) return undefined;
    return cardAsOf(preview.overviewCards, asOf)?.thumbnail ?? null;
  }, [asOf, previewByStoryline, topStoryline]);

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
  const focusedId = params.get("focus");
  const selectedSource =
    available.find((item) => item.id === selectedId) ?? null;
  const selected = selectedSource === null ? null : displayItem(selectedSource);
  const open = (item: StorylineListItem) => {
    const next = new URLSearchParams(params);
    next.set("storyline", item.id);
    setParams(next);
  };
  const close = () => {
    const next = new URLSearchParams(params);
    next.delete("storyline");
    setParams(next, { replace: true });
  };
  const focus = (storylineId: string) => {
    const next = new URLSearchParams(params);
    next.set("focus", storylineId);
    setParams(next, { replace: true });
  };
  const clearFilters = () => {
    setParams((current) => {
      const next = new URLSearchParams(current);
      next.delete("agency");
      next.delete("category");
      next.delete("theme");
      return next;
    });
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
              onClick={() => setValue("view", "product", "product")}
              type="button"
            >
              Product view
            </button>
            <button
              aria-pressed={view === "table"}
              className="view-button"
              onClick={() => setValue("view", "table", "product")}
              type="button"
            >
              Table view
            </button>
            <button
              aria-pressed={view === "explorer"}
              className="view-button"
              onClick={() => setValue("view", "explorer", "product")}
              type="button"
            >
              Explorer
            </button>
          </div>
        </header>
        <div className="filter-deck" aria-label="Storyline filters">
          <FilterGroup
            animateLayout
            exitingOptions={displayedAgencies.exitingIds}
            label="Agency"
            onOptionExit={displayedAgencies.completeExit}
            onToggle={(value) => setValues("agency", toggled(agencies, value))}
            optionClassName="filter-option-transition"
            options={displayedAgencies.options}
            selected={agencies}
          />
          <FilterGroup
            animateLayout
            exitingOptions={displayedCategories.exitingIds}
            label="Category"
            onOptionExit={displayedCategories.completeExit}
            onToggle={(value) =>
              setValues("category", toggled(categories, value))
            }
            optionClassName="filter-option-transition"
            options={displayedCategories.options}
            selected={categories}
          />
          <FilterGroup
            animateLayout
            exitingOptions={displayedThemes.exitingIds}
            label="Theme"
            onOptionExit={displayedThemes.completeExit}
            onToggle={(value) => setValues("theme", toggled(themes, value))}
            optionClassName="filter-option-transition"
            options={displayedThemes.options}
            selected={themes}
          />
        </div>

        <div className="toolbar">
          <div className="result-copy" aria-live="polite">
            Showing <strong>{filtered.length}</strong> of{" "}
            <strong>{available.length}</strong> reviewed storylines
          </div>
          {view === "explorer" ? null : (
            <div className="table-controls">
              <div className="sort-field">
                <label htmlFor="storyline-sort">Sort by</label>
                <select
                  id="storyline-sort"
                  onChange={(event) =>
                    setValue("sort", event.target.value, "rank")
                  }
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
                      setValue("group", event.target.value, "theme")
                    }
                    value={groupBy}
                  >
                    <option value="theme">Theme</option>
                    <option value="category">Category</option>
                  </select>
                </div>
              ) : null}
            </div>
          )}
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
                themeExiting={
                  item.themeId !== null &&
                  displayedThemes.exitingIds.has(item.themeId)
                }
              />
            ))}
          </section>
        ) : view === "table" ? (
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
                      themeExiting={
                        item.themeId !== null &&
                        displayedThemes.exitingIds.has(item.themeId)
                      }
                    />
                  ))}
                </tbody>
              ))}
            </table>
          </div>
        ) : (
          <Suspense
            fallback={
              <div className="explorer-state" role="status">
                Preparing Explorer…
              </div>
            }
          >
            <ExplorerView
              asOf={asOf}
              focusedId={
                focusedId !== null &&
                filtered.some((item) => item.id === focusedId)
                  ? focusedId
                  : null
              }
              items={filtered.map(displayItem)}
              onFocus={focus}
              onOpen={open}
              previewByStoryline={previewByStoryline}
            />
          </Suspense>
        )}
        {view !== "explorer" && visibleCount < filtered.length ? (
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
