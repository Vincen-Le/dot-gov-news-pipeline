import { useQuery } from "@tanstack/react-query";
import { type CSSProperties, useEffect, useMemo, useState } from "react";
import { Link } from "react-router-dom";

import { dotGovApi } from "./api/client";
import { displayDate, StatePanel } from "./components";
import {
  endOfDay,
  isAvailableAsOf,
  isThemeAvailableAsOf,
} from "./domain/as-of";

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
  const [agency, setAgency] = useState("");
  const [category, setCategory] = useState("");
  const [theme, setTheme] = useState("");
  const overview = useQuery({
    queryFn: ({ signal }) => dotGovApi.rankOverview(signal),
    queryKey: ["rank-overview"],
  });
  const storylines = useQuery({
    queryFn: ({ signal }) => dotGovApi.storylines(signal),
    queryKey: ["storylines"],
  });
  const rows = useQuery({
    enabled: overview.data !== undefined,
    queryFn: ({ signal }) =>
      dotGovApi.rankRows(
        {
          agency: agency || undefined,
          category: category || undefined,
          theme: theme || undefined,
        },
        signal,
      ),
    queryKey: ["rank-rows", agency, category, theme],
  });
  const themes = useMemo(
    () =>
      (overview.data?.filters.themes ?? []).filter(
        (item) =>
          (category === "" || item.categoryId === category) &&
          isThemeAvailableAsOf(item, storylines.data?.items ?? [], asOf),
      ),
    [asOf, category, overview.data, storylines.data],
  );
  const availableStorylineIds = useMemo(
    () =>
      new Set(
        (storylines.data?.items ?? [])
          .filter((item) => isAvailableAsOf(item, asOf))
          .map((item) => item.id),
      ),
    [asOf, storylines.data],
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

  useEffect(() => {
    if (theme !== "" && !themes.some((item) => item.id === theme)) setTheme("");
  }, [theme, themes]);

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
            {rows.data === undefined ? "…" : visibleRows.length} of{" "}
            {dataset.storylines} ranked stories by {displayDate(asOf)}
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
            onChange={(event) => setAgency(event.target.value)}
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
              setCategory(event.target.value);
              setTheme("");
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
            onChange={(event) => setTheme(event.target.value)}
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

      {rows.isLoading || storylines.isLoading ? (
        <StatePanel title="Applying the ranking">
          Finding the reviewed stories available on this date.
        </StatePanel>
      ) : rows.error || storylines.error ? (
        <StatePanel title="This ranking slice is unavailable">
          Try removing one of the filters.
        </StatePanel>
      ) : visibleRows.length === 0 ? (
        <StatePanel title="No ranked stories yet">
          Advance the timeline to the first reviewed publication.
        </StatePanel>
      ) : (
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
              {visibleRows.map((row) => (
                <tr key={row.storylineId}>
                  <td className="rank-position">
                    {String(row.position).padStart(2, "0")}
                  </td>
                  <th className="rank-headline" scope="row">
                    <Link
                      to={`/?storyline=${encodeURIComponent(row.storylineId)}`}
                    >
                      {row.headline ?? "Developing storyline"}
                    </Link>
                    <small>
                      {row.summary ?? "Editorial summary is queued."}
                    </small>
                  </th>
                  <td className="rank-key-value">{row.rankKey.toFixed(3)}</td>
                  <td>
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
                  </td>
                  <td className="rank-source-value">
                    {row.sourceName ?? "Multiple agencies"}
                    {row.sourceKey === null ? null : (
                      <small>{row.sourceKey}</small>
                    )}
                  </td>
                  <td className="rank-count">{row.agencies}</td>
                  <td className="rank-count">{row.feeds}</td>
                  <td className="rank-count">{row.entryCount}</td>
                  <td className="rank-rubric">
                    <span
                      className={
                        row.terms.priorUsed ? "rank-prior" : "rank-judged"
                      }
                    >
                      {row.terms.priorUsed ? "Prior" : "Judged"}
                    </span>
                    <small>{row.terms.rubricPoints.toFixed(2)} points</small>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
