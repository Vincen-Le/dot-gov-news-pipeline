import { useQuery } from "@tanstack/react-query";
import { useEffect, useMemo, useRef, useState } from "react";
import { useSearchParams } from "react-router-dom";

import type { StorylineListItem } from "./api/contracts";
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
import { isAvailableAsOf, isThemeAvailableAsOf } from "./domain/as-of";
import { relativeStorylinePlacements } from "./domain/relative-rank";

const INITIAL_COUNT = 18;

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
  const [visibleCount, setVisibleCount] = useState(INITIAL_COUNT);
  const loadMore = useRef<HTMLDivElement>(null);

  const storylines = useQuery({
    queryFn: ({ signal }) => dotGovApi.storylines(signal),
    queryKey: ["storylines"],
  });
  const agencyQuery = useQuery({
    queryFn: ({ signal }) => dotGovApi.agencies(signal),
    queryKey: ["agencies"],
  });
  const categoryQuery = useQuery({
    queryFn: ({ signal }) => dotGovApi.categories(signal),
    queryKey: ["categories"],
  });
  const themeQuery = useQuery({
    queryFn: ({ signal }) => dotGovApi.themes(signal),
    queryKey: ["themes"],
  });

  const agencyMap = useMemo(
    () => agencyNames(agencyQuery.data?.agencies ?? []),
    [agencyQuery.data],
  );
  const available = useMemo(
    () =>
      (storylines.data?.items ?? []).filter((item) =>
        isAvailableAsOf(item, asOf),
      ),
    [asOf, storylines.data],
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
    const ordered = (categoryQuery.data?.categories ?? [])
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
  }, [available, categoryQuery.data]);
  const themeOptions = useMemo(() => {
    const ids = new Set(
      available.flatMap((item) =>
        item.themeId === null ? [] : [item.themeId],
      ),
    );
    return (themeQuery.data?.themes ?? [])
      .filter(
        (theme) =>
          ids.has(theme.id) && isThemeAvailableAsOf(theme, available, asOf),
      )
      .map((theme) => ({ label: theme.displayName, value: theme.id }))
      .sort(optionSort);
  }, [asOf, available, themeQuery.data]);
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
    () => setVisibleCount(INITIAL_COUNT),
    [agencies, asOf, categories, sort, themes],
  );

  useEffect(() => {
    const target = loadMore.current;
    if (
      target === null ||
      view !== "product" ||
      visibleCount >= filtered.length ||
      globalThis.IntersectionObserver === undefined
    ) {
      return;
    }
    const observer = new IntersectionObserver(
      (entries) => {
        if (!entries.some((entry) => entry.isIntersecting)) return;
        setVisibleCount((count) =>
          Math.min(count + INITIAL_COUNT, filtered.length),
        );
      },
      { rootMargin: "480px 0px" },
    );
    observer.observe(target);
    return () => observer.disconnect();
  }, [filtered.length, view, visibleCount]);

  const displayItem = (item: StorylineListItem): StorylineListItem =>
    item.themeId !== null && surfacedThemeIds.has(item.themeId)
      ? item
      : { ...item, themeId: null, themeName: null };
  const visibleItems = filtered.slice(0, visibleCount).map(displayItem);

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

  if (storylines.isLoading) {
    return (
      <StatePanel title="Building the daily view">
        Loading approved storylines and their publishing history.
      </StatePanel>
    );
  }
  if (storylines.error) {
    return (
      <StatePanel title="The storyline API is unavailable">
        Confirm that this deployment can reach its server-side API origin.
      </StatePanel>
    );
  }

  return (
    <div className="page-stack">
      <section className="page-intro">
        <div className="intro-content">
          <div>
            <p className="eyebrow">Public information, connected over time</p>
            <h1>Storylines</h1>
            <p className="intro-description">
              Follow related government updates as one evolving event. This
              briefing contains reviewed source material and shows it as it
              would have appeared on the selected date.
            </p>
          </div>
        </div>
      </section>

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
          <div className="sort-field">
            <label htmlFor="storyline-sort">Sort by</label>
            <select
              id="storyline-sort"
              onChange={(event) => setSort(event.target.value as SortOrder)}
              value={sort}
            >
              <option value="rank">Rank key</option>
              <option value="newest">Newest update</option>
              <option value="episodes">Episode count</option>
            </select>
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
          <section
            className="storyline-grid"
            aria-label="Storylines"
            key={asOf}
          >
            {visibleItems.map((item, index) => (
              <StorylineCard
                agencyMap={agencyMap}
                asOf={asOf}
                item={item}
                key={item.id}
                onOpen={() => open(item)}
                placement={placements.get(item.id)!}
                revealIndex={index}
              />
            ))}
          </section>
        ) : (
          <div className="table-view">
            <table>
              <thead>
                <tr>
                  <th scope="col">Rank key</th>
                  <th scope="col">Storyline</th>
                  <th scope="col">Agencies</th>
                  <th scope="col">Category / theme</th>
                  <th scope="col">Episodes</th>
                  <th scope="col">Articles</th>
                  <th scope="col">Newest</th>
                  <th scope="col">Review</th>
                </tr>
              </thead>
              <tbody>
                {visibleItems.map((item) => (
                  <StorylineTableRow
                    agencyMap={agencyMap}
                    asOf={asOf}
                    item={item}
                    key={item.id}
                    onOpen={() => open(item)}
                  />
                ))}
              </tbody>
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
                  Math.min(count + INITIAL_COUNT, filtered.length),
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
