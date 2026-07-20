import { usePrefetchQuery, useQuery } from "@tanstack/react-query";
import {
  type CSSProperties,
  type ReactNode,
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "react";

import {
  type AgencyOption,
  type StorylineListItem,
  type StorylinePreview,
} from "./api/contracts";
import { dotGovApi } from "./api/client";
import { cardAsOf, detailAsOf, isoDay } from "./domain/as-of";
import type { StorylinePlacement } from "./domain/relative-rank";
import { filterMotion } from "./motion";
import { NewsMark } from "./NewsMark";

export function displayDate(value: string | null | undefined): string {
  if (value === null || value === undefined) return "Date unavailable";
  const date = new Date(value.includes("T") ? value : `${value}T12:00:00Z`);
  if (Number.isNaN(date.valueOf())) return "Date unavailable";
  return new Intl.DateTimeFormat("en-US", {
    day: "numeric",
    month: "short",
    timeZone: "UTC",
    year: "numeric",
  }).format(date);
}

export function agencyNames(options: AgencyOption[]): Map<string, string> {
  return new Map(options.map((option) => [option.key, option.displayName]));
}

export function StatePanel({
  children,
  title,
}: {
  children: ReactNode;
  title: string;
}) {
  return (
    <section className="state-panel" role="status">
      <span aria-hidden="true" className="state-mark" />
      <div>
        <h2>{title}</h2>
        <p>{children}</p>
      </div>
    </section>
  );
}

export interface FilterOption {
  label: string;
  value: string;
}

function usePrefetchStorylineDetail(storylineId: string): void {
  usePrefetchQuery({
    queryFn: ({ signal }) => dotGovApi.storyline(storylineId, signal),
    queryKey: ["storyline", storylineId],
  });
}

export function FilterGroup({
  animateLayout = false,
  exitingOptions,
  label,
  onOptionExit,
  onToggle,
  optionClassName,
  options,
  selected,
}: {
  animateLayout?: boolean;
  exitingOptions?: ReadonlySet<string>;
  label: string;
  onOptionExit?: (value: string) => void;
  onToggle: (value: string) => void;
  optionClassName?: string;
  options: FilterOption[];
  selected: Set<string>;
}) {
  const rail = useRef<HTMLDivElement>(null);
  const previousPositions = useRef(new Map<string, number>());
  const layoutAnimations = useRef(new Map<string, Animation>());

  useLayoutEffect(() => {
    for (const animation of layoutAnimations.current.values()) {
      animation.cancel();
    }
    layoutAnimations.current.clear();

    const buttons = rail.current?.querySelectorAll<HTMLButtonElement>(
      "[data-filter-option]",
    );
    const currentPositions = new Map<string, number>();
    for (const button of buttons ?? []) {
      const value = button.dataset.filterOption;
      if (value !== undefined) {
        // offsetLeft is the card's stable layout position inside the rail. A
        // viewport-relative rect can include an in-flight transform or a
        // browser-adjusted scroll position when the date changes quickly.
        currentPositions.set(value, button.offsetLeft);
      }
    }

    const layoutChanged = [...currentPositions].some(
      ([value, left]) => previousPositions.current.get(value) !== left,
    );
    const reduceMotion =
      typeof globalThis.matchMedia === "function" &&
      globalThis.matchMedia("(prefers-reduced-motion: reduce)").matches;
    if (animateLayout && layoutChanged && !reduceMotion) {
      for (const button of buttons ?? []) {
        const value = button.dataset.filterOption;
        if (value === undefined) continue;
        const previousLeft = previousPositions.current.get(value);
        if (
          previousLeft === undefined ||
          typeof button.animate !== "function"
        ) {
          continue;
        }
        const currentLeft = currentPositions.get(value);
        if (currentLeft === undefined) continue;
        const delta = previousLeft - currentLeft;
        if (delta === 0) continue;
        const animation = button.animate(
          [
            { transform: `translateX(${delta}px)` },
            { transform: "translateX(0)" },
          ],
          {
            duration: filterMotion.layoutDurationMs,
            easing: filterMotion.layoutEasing,
          },
        );
        layoutAnimations.current.set(value, animation);
      }
    }
    previousPositions.current = currentPositions;
  }, [animateLayout, options]);

  useEffect(
    () => () => {
      for (const animation of layoutAnimations.current.values()) {
        animation.cancel();
      }
    },
    [],
  );

  if (options.length === 0) return null;
  return (
    <div className="facet-row">
      <span className="facet-label" id={`filter-${label.toLowerCase()}`}>
        {label}
      </span>
      <div
        aria-labelledby={`filter-${label.toLowerCase()}`}
        className="pill-rail"
        ref={rail}
      >
        {options.map((option) => {
          const pressed = selected.has(option.value);
          const exiting = exitingOptions?.has(option.value) ?? false;
          return (
            <button
              aria-pressed={pressed}
              className={`pill${optionClassName === undefined ? "" : ` ${optionClassName}`}${exiting ? " is-exiting" : ""}`}
              data-filter-option={option.value}
              disabled={exiting}
              key={option.value}
              onAnimationEnd={() => {
                if (exiting) onOptionExit?.(option.value);
              }}
              onClick={() => onToggle(option.value)}
              type="button"
            >
              {option.label}
            </button>
          );
        })}
      </div>
    </div>
  );
}

export function StorylineCard({
  agencyMap,
  asOf,
  item,
  onOpen,
  placement,
  preview,
  revealIndex = 0,
  themeExiting = false,
}: {
  agencyMap: Map<string, string>;
  asOf: string;
  item: StorylineListItem;
  onOpen: () => void;
  placement: StorylinePlacement;
  preview?: StorylinePreview;
  revealIndex?: number;
  themeExiting?: boolean;
}) {
  usePrefetchStorylineDetail(item.id);
  const detail = useQuery({
    enabled: preview === undefined,
    queryFn: ({ signal }) => dotGovApi.storyline(item.id, signal),
    queryKey: ["storyline", item.id],
  });
  const asOfDetail = useMemo(
    () =>
      detail.data === undefined || detail.data.unreviewedEntryCount !== 0
        ? null
        : detailAsOf(detail.data, asOf),
    [asOf, detail.data],
  );
  const overview =
    preview === undefined
      ? (asOfDetail?.overview ?? null)
      : cardAsOf(preview.overviewCards, asOf);
  const visibleEntries =
    asOfDetail?.episodes.flatMap((episode) => episode.entries) ?? [];
  const agencies = (
    preview === undefined
      ? [
          ...new Set(
            visibleEntries.map(
              (entry) => agencyMap.get(entry.agency) ?? entry.agency,
            ),
          ),
        ]
      : item.agencies.map((agency) => agencyMap.get(agency) ?? agency)
  ).slice(0, 2);
  const episodeCount =
    preview === undefined
      ? (asOfDetail?.episodes.length ?? 0)
      : item.episodeCount;
  const entryCount =
    preview === undefined ? visibleEntries.length : item.entryCount;
  const isLoading = preview === undefined && detail.isLoading;
  const headline =
    overview?.headline ??
    (isLoading ? "Loading storyline" : "Storyline unavailable");
  const placementLabel = [
    placement.agencyPosition === null
      ? "Unranked agency"
      : `#${placement.agencyPosition} in ${
          placement.agencyKey === null
            ? "Agency"
            : (agencyMap.get(placement.agencyKey) ?? placement.agencyKey)
        }`,
    placement.categoryPosition === null
      ? "Unranked category"
      : `#${placement.categoryPosition} in ${item.categoryName ?? "Category"}`,
  ].join(" · ");

  if (
    (preview !== undefined || detail.data !== undefined) &&
    !isLoading &&
    overview === null
  ) {
    return null;
  }

  return (
    <article
      className="storyline-card event-card"
      style={{ "--reveal-index": revealIndex } as CSSProperties}
    >
      <button
        aria-label={`Read ${headline}`}
        className="event-card-hit"
        onClick={onOpen}
        type="button"
      >
        <div className="storyline-visual event-image">
          {overview?.thumbnail === null || overview === null ? (
            <div className="image-placeholder">
              <NewsMark className="news-mark news-mark--placeholder" />
              <span>
                <strong>Event image pending</strong>
                <small>Editorial enrichment queued</small>
              </span>
            </div>
          ) : (
            <>
              <img
                alt={overview.thumbnail.altText}
                className="storyline-image"
                fetchPriority={revealIndex < 4 ? "high" : "auto"}
                key={overview.thumbnail.cardUrl}
                loading={revealIndex < 4 ? "eager" : "lazy"}
                onLoad={(event) =>
                  event.currentTarget.classList.add("is-loaded")
                }
                src={overview.thumbnail.cardUrl}
                style={{
                  objectPosition: `${overview.thumbnail.focalX * 100}% ${overview.thumbnail.focalY * 100}%`,
                }}
              />
              <span className="image-credit">Reviewed editorial image</span>
            </>
          )}
        </div>
        <div className="storyline-body event-card-body">
          <div className="event-card-meta">
            <span className="storyline-placement">{placementLabel}</span>
            {overview === null ? (
              <span>Snapshot loading</span>
            ) : (
              <time dateTime={overview.newestEntryAt}>
                {displayDate(overview.newestEntryAt)}
              </time>
            )}
          </div>
          <h2>{headline}</h2>
          {overview === null ? (
            <div className="card-copy-placeholder">
              <span>
                {isLoading
                  ? "Loading storyline overview"
                  : "Storyline overview pending"}
              </span>
              <i aria-hidden="true" />
              <i aria-hidden="true" />
              <i aria-hidden="true" />
            </div>
          ) : (
            <p>{overview.summary}</p>
          )}
          <div className="taxonomy">
            <span>{item.categoryName ?? "Government"}</span>
            {item.themeName === null ? null : (
              <span
                className={`theme-emergence${themeExiting ? " is-exiting" : ""}`}
                key={item.themeId}
              >
                {item.themeName}
              </span>
            )}
          </div>
          <footer>
            <span className="card-volume">
              {agencies.join(" · ") || "Agency source pending"} · {episodeCount}{" "}
              episode
              {episodeCount === 1 ? "" : "s"} · {entryCount} source
              {entryCount === 1 ? "" : "s"}
            </span>
            <span className="open-cue">Open storyline</span>
          </footer>
        </div>
      </button>
    </article>
  );
}

export function StorylineTableRow({
  agencyMap,
  asOf,
  item,
  onOpen,
  preview,
  themeExiting = false,
}: {
  agencyMap: Map<string, string>;
  asOf: string;
  item: StorylineListItem;
  onOpen: () => void;
  preview?: StorylinePreview;
  themeExiting?: boolean;
}) {
  usePrefetchStorylineDetail(item.id);
  const detail = useQuery({
    enabled: preview === undefined,
    queryFn: ({ signal }) => dotGovApi.storyline(item.id, signal),
    queryKey: ["storyline", item.id],
  });
  const snapshot = useMemo(
    () =>
      detail.data === undefined || detail.data.unreviewedEntryCount !== 0
        ? null
        : detailAsOf(detail.data, asOf),
    [asOf, detail.data],
  );
  const overview =
    preview === undefined
      ? (snapshot?.overview ?? null)
      : cardAsOf(preview.overviewCards, asOf);
  const entries =
    snapshot?.episodes.flatMap((episode) => episode.entries) ?? [];
  const agencies =
    preview === undefined
      ? [
          ...new Set(
            entries.map((entry) => agencyMap.get(entry.agency) ?? entry.agency),
          ),
        ]
      : item.agencies.map((agency) => agencyMap.get(agency) ?? agency);

  if ((preview !== undefined || detail.data !== undefined) && overview === null)
    return null;

  return (
    <tr>
      <td>{overview?.rankKey.toFixed(3) ?? "—"}</td>
      <th scope="row">
        <button className="table-open" onClick={onOpen} type="button">
          {overview?.headline ?? "Loading historical snapshot"}
        </button>
      </th>
      <td className="wrap">{agencies.join(" · ") || "—"}</td>
      <td className="wrap">
        {item.categoryName ?? (item.themeName === null ? "—" : null)}
        {item.themeName === null ? null : (
          <span
            className={`theme-emergence${themeExiting ? " is-exiting" : ""}`}
            key={item.themeId}
          >
            {item.categoryName === null ? "" : " · "}
            {item.themeName}
          </span>
        )}
      </td>
      <td>
        {preview === undefined
          ? (snapshot?.episodes.length ?? "—")
          : item.episodeCount}
      </td>
      <td>
        {preview === undefined
          ? snapshot === null
            ? "—"
            : entries.length
          : item.entryCount}
      </td>
      <td>{overview?.newestEntryAt.slice(0, 10) ?? "—"}</td>
      <td>
        <span className="reviewed-mark">Reviewed</span>
      </td>
    </tr>
  );
}

export function StorylineDialog({
  agencyMap,
  asOf,
  close,
  item,
}: {
  agencyMap: Map<string, string>;
  asOf: string;
  close: () => void;
  item: StorylineListItem;
}) {
  const dialog = useRef<HTMLDialogElement>(null);
  const closeFinished = useRef(false);
  const [closing, setClosing] = useState(false);
  const detail = useQuery({
    queryFn: ({ signal }) => dotGovApi.storyline(item.id, signal),
    queryKey: ["storyline", item.id],
  });
  const asOfDetail = useMemo(
    () =>
      detail.data === undefined || detail.data.unreviewedEntryCount !== 0
        ? null
        : detailAsOf(detail.data, asOf),
    [asOf, detail.data],
  );

  const finishClose = useCallback(() => {
    if (closeFinished.current) return;
    closeFinished.current = true;
    dialog.current?.close();
    close();
  }, [close]);
  const requestClose = useCallback(() => {
    if (closing || closeFinished.current) return;
    if (window.matchMedia?.("(prefers-reduced-motion: reduce)").matches) {
      finishClose();
      return;
    }
    setClosing(true);
  }, [closing, finishClose]);

  useEffect(() => {
    const current = dialog.current;
    if (current === null) return;
    current.showModal();
    return () => current.close();
  }, []);

  useEffect(() => {
    if (!closing) return;
    const fallback = window.setTimeout(finishClose, 260);
    return () => window.clearTimeout(fallback);
  }, [closing, finishClose]);

  const headline = asOfDetail?.overview?.headline ?? "Loading storyline";
  const visibleEntries =
    asOfDetail?.episodes.flatMap((episode) => episode.entries) ?? [];
  const namedAgencies = [
    ...new Set(
      visibleEntries.map(
        (entry) => agencyMap.get(entry.agency) ?? entry.agency,
      ),
    ),
  ];
  const synthesisCutoff = asOfDetail?.overview?.newestEntryAt ?? null;
  const overviewTimeline = useMemo(() => {
    if (asOfDetail === null) return [];
    const episodesById = new Map(
      asOfDetail.episodes.map((episode) => [episode.id, episode]),
    );
    const generatedTimeline = asOfDetail.overview?.timeline;
    const timelineItems =
      generatedTimeline !== null &&
      generatedTimeline !== undefined &&
      generatedTimeline.length > 0
        ? generatedTimeline
        : asOfDetail.episodes.map((episode) => ({
            date: episode.firstEntryAt,
            episodeId: episode.id,
            text: null,
          }));

    return timelineItems.map((item) => {
      const episode =
        item.episodeId === null ? undefined : episodesById.get(item.episodeId);
      return {
        date: isoDay(item.date) ?? isoDay(episode?.firstEntryAt) ?? "",
        episodeId: item.episodeId,
        text:
          item.text?.trim() ||
          episode?.card?.headline ||
          episode?.entries[0]?.title ||
          "Developing episode",
      };
    });
  }, [asOfDetail]);

  return (
    <dialog
      aria-label={headline}
      className={`storyline-dialog story-dialog${closing ? " is-closing" : ""}`}
      onCancel={(event) => {
        event.preventDefault();
        requestClose();
      }}
      onClick={(event) => {
        if (event.target === event.currentTarget) requestClose();
      }}
      onAnimationEnd={(event) => {
        if (closing && event.target === event.currentTarget) finishClose();
      }}
      ref={dialog}
    >
      <div className="dialog-shell">
        <header className="dialog-header">
          <div>
            <p className="eyebrow">Storyline as of {displayDate(asOf)}</p>
            <h1>{headline}</h1>
            <p className="dialog-taxonomy">
              {[item.categoryName, item.themeName, ...namedAgencies]
                .filter(Boolean)
                .join(" · ")}
            </p>
          </div>
          <button
            aria-label="Close storyline"
            className="dialog-close"
            onClick={requestClose}
            type="button"
          >
            <span aria-hidden="true">×</span>
          </button>
        </header>

        {detail.isLoading ? (
          <StatePanel title="Opening storyline">
            Loading the timeline and sources.
          </StatePanel>
        ) : detail.error ? (
          <StatePanel title="Storyline unavailable">
            The detail API did not return this storyline. Try again shortly.
          </StatePanel>
        ) : detail.data?.unreviewedEntryCount !== 0 ? (
          <StatePanel title="Storyline unavailable">
            This storyline is not available for the demonstration.
          </StatePanel>
        ) : asOfDetail === null ? null : (
          <div className="dialog-columns">
            <main className="storyline-reading-column chain-pane">
              <div className="pane-heading">Overview + timeline</div>
              <article className="overview-card">
                <header className="overview-card-meta">
                  <span>Latest overview</span>
                  {asOfDetail.overview === null ? null : (
                    <span>V{asOfDetail.overview.version}</span>
                  )}
                </header>
                <h2>{headline}</h2>
                <p>
                  {asOfDetail.overview?.summary ??
                    "An editorial overview has not been generated for this date."}
                </p>
                <ol
                  aria-label="Storyline timeline"
                  className="overview-timeline"
                >
                  {overviewTimeline.map((timelineItem, index) => (
                    <li
                      key={`${timelineItem.episodeId ?? "uncited"}:${timelineItem.date}:${index}`}
                    >
                      <time dateTime={timelineItem.date}>
                        {timelineItem.date || "Date unavailable"}
                      </time>
                      <p>{timelineItem.text}</p>
                    </li>
                  ))}
                </ol>
              </article>
            </main>

            <aside className="source-column synthesis-pane">
              <div className="pane-heading">Article synthesis</div>
              {asOfDetail.overview?.articleOverview === null ||
              asOfDetail.overview === null ? (
                <section
                  aria-label="Article synthesis pending"
                  className="article-overview synthesis-placeholder"
                >
                  <header>
                    <p className="eyebrow">Pending enrichment</p>
                    <h2>Article synthesis pending</h2>
                    <p>
                      Source records remain available below while the aggregate
                      analysis is prepared.
                    </p>
                  </header>
                  <div aria-hidden="true" className="placeholder-lines">
                    <span />
                    <span />
                    <span />
                    <span />
                  </div>
                </section>
              ) : (
                <section className="article-overview">
                  <header>
                    <h2>What the available articles say</h2>
                    <div className="article-summary">
                      {asOfDetail.overview.articleOverview.summary.text
                        .split(/\n{2,}/u)
                        .map((paragraph, index) => (
                          <p key={`${index}:${paragraph}`}>{paragraph}</p>
                        ))}
                    </div>
                  </header>
                  <ol className="synthesis-points">
                    {asOfDetail.overview.articleOverview.keyPoints.map(
                      (point, index) => (
                        <li
                          key={`${point.sourceEntryIds.join(":")}:${point.text}`}
                        >
                          <span aria-hidden="true">
                            {String(index + 1).padStart(2, "0")}
                          </span>
                          <p>{point.text}</p>
                        </li>
                      ),
                    )}
                  </ol>
                </section>
              )}
              <header className="source-records-header">
                <p className="eyebrow">Source record</p>
                <h2>Available source articles</h2>
                <p className="source-availability">
                  {visibleEntries.length} source article
                  {visibleEntries.length === 1 ? "" : "s"} available as of{" "}
                  {displayDate(asOf)}.
                  {synthesisCutoff === null
                    ? ""
                    : ` Synthesis reflects source material through ${displayDate(synthesisCutoff)}.`}
                </p>
              </header>
              <ul className="source-list">
                {visibleEntries.map((entry) => (
                  <li key={entry.id}>
                    <a href={entry.url} rel="noreferrer" target="_blank">
                      <span>{agencyMap.get(entry.agency) ?? entry.agency}</span>
                      <strong>{entry.title ?? "Untitled agency update"}</strong>
                      <small>
                        {displayDate(entry.publishedAt)} · Open source ↗
                      </small>
                    </a>
                  </li>
                ))}
              </ul>
            </aside>
          </div>
        )}
      </div>
    </dialog>
  );
}
