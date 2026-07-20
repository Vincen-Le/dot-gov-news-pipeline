import { useQuery } from "@tanstack/react-query";
import { type CSSProperties, useEffect, useMemo, useState } from "react";
import { Link } from "react-router-dom";

import { dotGovApi } from "./api/client";
import { displayDate, StatePanel } from "./components";
import { isThemeAvailableAsOf } from "./domain/as-of";

function termStyle(terms: {
  agencyTerm: number;
  feedTerm: number;
  freshnessTerm: number;
  rubricPoints: number;
  sourceTerm: number;
}): CSSProperties {
  const rubric = Math.abs(terms.rubricPoints);
  const agency = Math.abs(terms.agencyTerm);
  const feed = Math.abs(terms.feedTerm);
  const source = Math.abs(terms.sourceTerm);
  const freshness = Math.abs(terms.freshnessTerm);
  const total = rubric + agency + feed + source + freshness || 1;
  return {
    "--agency-width": `${(agency / total) * 100}%`,
    "--feed-width": `${(feed / total) * 100}%`,
    "--freshness-width": `${(freshness / total) * 100}%`,
    "--rubric-width": `${(rubric / total) * 100}%`,
    "--source-width": `${(source / total) * 100}%`,
  } as CSSProperties;
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
          <span>Reviewed golden dataset · {dataset.storylines} storylines</span>
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
            <li>
              <i className="term-freshness" />
              Freshness
            </li>
          </ul>
        </div>
      </header>

      <section className="rank-controls" aria-label="Ranking filters">
        <label>
          <span>Scope</span>
          <output>Reviewed dataset</output>
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

      {rows.isLoading ? (
        <StatePanel title="Applying the ranking">
          Recalculating this editorial slice.
        </StatePanel>
      ) : rows.error ? (
        <StatePanel title="This ranking slice is unavailable">
          Try removing one of the filters.
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
              {(rows.data?.rows ?? []).map((row) => (
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
                    <span
                      aria-label="Rank term composition"
                      className="rank-term-bar"
                      style={termStyle(row.terms)}
                    >
                      <i className="term-rubric" />
                      <i className="term-agency" />
                      <i className="term-feed" />
                      <i className="term-source" />
                      <i className="term-freshness" />
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
