import { useQuery } from "@tanstack/react-query";
import { type CSSProperties, useCallback, useEffect, useMemo } from "react";
import { useSearchParams } from "react-router-dom";

import { dotGovApi } from "./api/client";
import {
  agencyNames,
  displayDate,
  StatePanel,
  StorylineDialog,
} from "./components";
import {
  endOfDay,
  isAvailableAsOf,
  isThemeAvailableAsOf,
} from "./domain/as-of";

const RANKING_PAGE_SIZE = 100;

function termStyle(terms: {
  agencyTerm: number;
  feedTerm: number;
  rubricPoints: number;
  sourceTerm: number;
}): CSSProperties {
  const rubric = Math.max(terms.rubricPoints, 0);
  const agency = Math.max(terms.agencyTerm, 0);
  const feed = Math.max(terms.feedTerm, 0);
  const source = Math.max(terms.sourceTerm, 0);
  const total = rubric + agency + feed + source || 1;
  return {
    "--agency-width": `${(agency / total) * 100}%`,
    "--feed-width": `${(feed / total) * 100}%`,
    "--rubric-width": `${(rubric / total) * 100}%`,
    "--source-width": `${(source / total) * 100}%`,
  } as CSSProperties;
}

function termLabel(terms: {
  agencyTerm: number;
  feedTerm: number;
  freshnessTerm: number;
  rubricPoints: number;
  sourceTerm: number;
}): string {
  return [
    `rubric ${terms.rubricPoints.toFixed(2)}`,
    `agency ${terms.agencyTerm.toFixed(2)}`,
    `feed ${terms.feedTerm.toFixed(2)}`,
    `source ${terms.sourceTerm.toFixed(2)}`,
    `freshness ${terms.freshnessTerm.toFixed(1)}`,
  ].join(" · ");
}

export function RankingPage({ asOf }: { asOf: string }) {
  const [params, setParams] = useSearchParams();
  const agency = params.get("agency") ?? "";
  const category = params.get("category") ?? "";
  const theme = params.get("theme") ?? "";
  const requestedPage = Number.parseInt(params.get("page") ?? "1", 10);
  const page =
    Number.isFinite(requestedPage) && requestedPage > 0 ? requestedPage : 1;
  const setFilter = useCallback(
    (key: "agency" | "category" | "theme", value: string) => {
      setParams((current) => {
        const next = new URLSearchParams(current);
        if (value === "") next.delete(key);
        else next.set(key, value);
        next.delete("page");
        return next;
      });
    },
    [setParams],
  );
  const setPage = useCallback(
    (nextPage: number) => {
      setParams((current) => {
        const next = new URLSearchParams(current);
        if (nextPage <= 1) next.delete("page");
        else next.set("page", String(nextPage));
        return next;
      });
    },
    [setParams],
  );
  const overview = useQuery({
    queryFn: ({ signal }) => dotGovApi.rankOverview(signal),
    queryKey: ["rank-overview"],
  });
  const bootstrap = useQuery({
    queryFn: ({ signal }) => dotGovApi.bootstrap(signal),
    queryKey: ["bootstrap"],
  });
  const rows = useQuery({
    enabled: overview.data !== undefined,
    queryFn: ({ signal }) =>
      dotGovApi.rankRows(
        {
          agency: agency || undefined,
          asOf,
          category: category || undefined,
          theme: theme || undefined,
        },
        signal,
      ),
    queryKey: ["rank-rows", asOf, agency, category, theme],
  });
  const themes = useMemo(
    () =>
      (overview.data?.filters.themes ?? []).filter(
        (item) =>
          (category === "" || item.categoryId === category) &&
          isThemeAvailableAsOf(
            item,
            bootstrap.data?.storylines.items ?? [],
            asOf,
          ),
      ),
    [asOf, bootstrap.data, category, overview.data],
  );
  const availableStorylineIds = useMemo(
    () =>
      new Set(
        (bootstrap.data?.storylines.items ?? [])
          .filter((item) => isAvailableAsOf(item, asOf))
          .map((item) => item.id),
      ),
    [asOf, bootstrap.data],
  );
  const selectedStoryline = useMemo(() => {
    const selectedId = params.get("storyline");
    if (selectedId === null) return null;
    return (
      (bootstrap.data?.storylines.items ?? []).find(
        (item) => item.id === selectedId && isAvailableAsOf(item, asOf),
      ) ?? null
    );
  }, [asOf, bootstrap.data, params]);
  const agencyMap = useMemo(
    () => agencyNames(bootstrap.data?.agencies ?? []),
    [bootstrap.data],
  );
  const visibleRows = useMemo(
    () =>
      (rows.data?.rows ?? [])
        .filter(
          (row) =>
            availableStorylineIds.has(row.storylineId) &&
            row.newestEntryAt !== null &&
            Date.parse(row.newestEntryAt) <= endOfDay(asOf),
        )
        .map((row, index) => ({ ...row, position: index + 1 })),
    [asOf, availableStorylineIds, rows.data],
  );
  const pageCount = Math.max(
    1,
    Math.ceil(visibleRows.length / RANKING_PAGE_SIZE),
  );
  const currentPage = Math.min(page, pageCount);
  const pageStart = (currentPage - 1) * RANKING_PAGE_SIZE;
  const pageRows = visibleRows.slice(pageStart, pageStart + RANKING_PAGE_SIZE);
  const openStoryline = (storylineId: string) => {
    const next = new URLSearchParams(params);
    next.set("storyline", storylineId);
    setParams(next);
  };
  const closeStoryline = () => {
    const next = new URLSearchParams(params);
    next.delete("storyline");
    setParams(next, { replace: true });
  };

  useEffect(() => {
    if (theme !== "" && !themes.some((item) => item.id === theme)) {
      setFilter("theme", "");
    }
  }, [setFilter, theme, themes]);

  useEffect(() => {
    if (page > pageCount) setPage(pageCount);
  }, [page, pageCount, setPage]);

  if (overview.isLoading) {
    return (
      <StatePanel title="Loading the ranking">
        Reading the current approved ranking.
      </StatePanel>
    );
  }
  if (overview.error || overview.data === undefined) {
    return (
      <StatePanel title="The ranking is not available">
        The ranked-storyline API is not ready for this environment.
      </StatePanel>
    );
  }

  const { dataset, filters } = overview.data;
  return (
    <div className="rank-page">
      <header className="rank-heading">
        <div className="rank-heading-title">
          <span className="section-index">R</span>
          <div>
            <p className="eyebrow">Approved editorial index</p>
            <h1>Ranking</h1>
            <p className="rank-formula">
              rank_key = rubric + agency + feed diversity + source weight +
              freshness
            </p>
          </div>
        </div>
        <div className="rank-heading-meta">
          <span>
            Reviewed golden dataset ·{" "}
            {rows.data === undefined ? "…" : visibleRows.length} ranked stories
            by {displayDate(asOf)}
          </span>
          <ul aria-label="Score composition color key" className="rank-legend">
            <li>
              <i className="term-rubric" />
              Rubric
            </li>
            <li>
              <i className="term-agency" />
              Agency
            </li>
            <li>
              <i className="term-feed" />
              Feed diversity
            </li>
            <li>
              <i className="term-source" />
              Source weight
            </li>
            <li className="rank-legend-freshness">
              <i aria-hidden="true">+t</i>
              Freshness
            </li>
          </ul>
        </div>
      </header>

      <section className="rank-controls" aria-label="Ranking filters">
        <label>
          <span>Scope</span>
          <output>Published through {displayDate(asOf)}</output>
        </label>
        <label>
          <span>Dataset</span>
          <output>{dataset.sourceRunName}</output>
        </label>
        <label>
          <span>Agency</span>
          <select
            onChange={(event) => {
              setFilter("agency", event.target.value);
            }}
            value={agency}
          >
            <option value="">All agencies</option>
            {filters.agencies.map((item) => (
              <option key={item.key} value={item.key}>
                {item.displayName}
              </option>
            ))}
          </select>
        </label>
        <label>
          <span>Category</span>
          <select
            onChange={(event) => {
              const value = event.target.value;
              setParams((current) => {
                const next = new URLSearchParams(current);
                if (value === "") next.delete("category");
                else next.set("category", value);
                next.delete("theme");
                next.delete("page");
                return next;
              });
            }}
            value={category}
          >
            <option value="">All areas</option>
            {filters.categories.map((item) => (
              <option key={item.id} value={item.id}>
                {item.displayName}
              </option>
            ))}
          </select>
        </label>
        <label>
          <span>Theme</span>
          <select
            onChange={(event) => {
              setFilter("theme", event.target.value);
            }}
            value={theme}
          >
            <option value="">All themes</option>
            {themes.map((item) => (
              <option key={item.id} value={item.id}>
                {item.displayName}
              </option>
            ))}
          </select>
        </label>
      </section>

      <p className="rank-audit-receipt">
        canonical source: {dataset.sourceRunName} · reviewed{" "}
        {displayDate(dataset.approvedAt)} · {dataset.approvedEntries} approved
        entries
      </p>

      {rows.isLoading || bootstrap.isLoading ? (
        <StatePanel title="Applying the ranking">
          Finding the reviewed stories available on this date.
        </StatePanel>
      ) : rows.error || bootstrap.error ? (
        <StatePanel title="This ranking slice is unavailable">
          Try removing one of the filters.
        </StatePanel>
      ) : visibleRows.length === 0 ? (
        <StatePanel title="No ranked stories yet">
          Advance the timeline to the first reviewed publication.
        </StatePanel>
      ) : (
        <>
          <div className="rank-pagination rank-pagination-top">
            <span>
              Showing {pageStart + 1}–{pageStart + pageRows.length} of{" "}
              {visibleRows.length}
            </span>
            <span>
              Page {currentPage} of {pageCount}
            </span>
          </div>
          <div className="rank-table-scroll">
            <table className="rank-table">
              <thead>
                <tr>
                  <th scope="col">#</th>
                  <th scope="col">Headline</th>
                  <th scope="col">rank_key</th>
                  <th scope="col">Score makeup</th>
                  <th scope="col">Source</th>
                  <th scope="col">Agencies</th>
                  <th scope="col">Feeds</th>
                  <th scope="col">Entries</th>
                  <th scope="col">Rubric basis</th>
                </tr>
              </thead>
              <tbody>
                {pageRows.map((row) => (
                  <tr className="rank-row" key={row.storylineId}>
                    <td className="rank-position">
                      {String(row.position).padStart(2, "0")}
                    </td>
                    <th className="rank-headline" scope="row">
                      <button
                        className="rank-headline-button"
                        onClick={() => openStoryline(row.storylineId)}
                        type="button"
                      >
                        {row.headline ?? "Developing storyline"}
                      </button>
                      <small>
                        {row.summary ?? "Editorial summary is queued."}
                      </small>
                    </th>
                    <td className="rank-key-value">{row.rankKey.toFixed(3)}</td>
                    <td>
                      {row.terms === null ? (
                        <small>Historical breakdown unavailable</small>
                      ) : (
                        <span className="rank-term-cell">
                          <span
                            aria-label={termLabel(row.terms)}
                            className="rank-term-bar"
                            role="img"
                            style={termStyle(row.terms)}
                          >
                            <i className="term-rubric" />
                            <i className="term-agency" />
                            <i className="term-feed" />
                            <i className="term-source" />
                          </span>
                          <small>+{row.terms.freshnessTerm.toFixed(1)}t</small>
                        </span>
                      )}
                    </td>
                    <td className="rank-source-value">
                      {row.terms === null
                        ? "Historical attribution unavailable"
                        : (row.sourceName ?? "Multiple agencies")}
                      {row.sourceKey === null || row.terms === null ? null : (
                        <small>{row.sourceKey}</small>
                      )}
                    </td>
                    <td className="rank-count">{row.agencies ?? "—"}</td>
                    <td className="rank-count">{row.feeds ?? "—"}</td>
                    <td className="rank-count">{row.entryCount ?? "—"}</td>
                    <td className="rank-rubric">
                      {row.terms === null ? (
                        <small>Unavailable for historical card</small>
                      ) : (
                        <>
                          <span
                            className={
                              row.terms.priorUsed ? "rank-prior" : "rank-judged"
                            }
                          >
                            {row.terms.priorUsed ? "Prior" : "Judged"}
                          </span>
                          <small>
                            {row.terms.rubricPoints.toFixed(2)} points
                          </small>
                        </>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <nav aria-label="Ranking pages" className="rank-pagination">
            <button
              disabled={currentPage === 1}
              onClick={() => setPage(Math.max(1, currentPage - 1))}
              type="button"
            >
              Previous
            </button>
            <span>
              Page {currentPage} of {pageCount}
            </span>
            <button
              disabled={currentPage === pageCount}
              onClick={() => setPage(Math.min(pageCount, currentPage + 1))}
              type="button"
            >
              Next
            </button>
          </nav>
        </>
      )}
      {selectedStoryline === null ? null : (
        <StorylineDialog
          agencyMap={agencyMap}
          asOf={asOf}
          close={closeStoryline}
          item={selectedStoryline}
        />
      )}
    </div>
  );
}
