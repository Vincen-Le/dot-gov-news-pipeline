import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { Link, useSearchParams } from "react-router-dom";
import { z } from "zod";

import {
  ExperimentRunSchema,
  RankAuditPairSchema,
  RankAuditRunSchema,
  RankFacetSchema,
  RankSnapshotRowSchema,
  type RankAuditPair,
  type RankSnapshotRow,
} from "../../lab/contracts";
import { ErrorState, LoadingState, SectionHeading } from "../components";
import { fetchLab, postLab } from "../lab-api";
import "../rank.css";

const ExperimentListSchema = z.object({
  active: z.unknown().nullable(),
  items: ExperimentRunSchema.array(),
});
const FacetsSchema = z.object({ facets: RankFacetSchema.array() });
const SnapshotSchema = z.object({ rows: RankSnapshotRowSchema.array() });
const AuditSchema = z.object({ pairs: RankAuditPairSchema.array() });
const AuditRunsSchema = z.object({ auditRuns: RankAuditRunSchema.array() });
const OkSchema = z.object({ ok: z.boolean() });

const RUBRIC_CRITERIA = [
  "mass_impact",
  "health_safety",
  "economic",
  "policy_change",
  "rights_legal",
  "national_scope",
  "urgency",
  "novelty",
] as const;

function TermBar({ row }: { row: RankSnapshotRow }) {
  const t = row.terms;
  const parts = [
    ["term-rubric", t.rubric_points, "rubric"],
    ["term-agency", t.agency_term, "agency"],
    ["term-feed", t.feed_term, "feed"],
    ["term-source", t.source_term, "source"],
  ] as const;
  const total = parts.reduce((sum, [, value]) => sum + Math.max(value, 0), 0);
  const title = parts
    .map(([, value, label]) => `${label} ${value.toFixed(2)}`)
    .concat(`freshness ${t.freshness_term.toFixed(1)}`)
    .join(" · ");
  return (
    <span className="rank-term-cell" title={title}>
      <span className="rank-term-bar">
        {parts.map(([cls, value, label]) =>
          value > 0 && total > 0 ? (
            <span
              className={cls}
              key={label}
              style={{ width: `${(100 * value) / total}%` }}
            />
          ) : null,
        )}
      </span>
      <small>+{t.freshness_term.toFixed(1)}t</small>
    </span>
  );
}

function AuditDetail({
  pair,
  rows,
  runId,
}: {
  pair: RankAuditPair;
  rows: RankSnapshotRow[];
  runId: string;
}) {
  const queryClient = useQueryClient();
  const label = useMutation({
    mutationFn: (preferred: "a" | "b") =>
      postLab(
        "/rank/labels",
        {
          preferred,
          runId,
          storylineA: pair.storylineA,
          storylineB: pair.storylineB,
        },
        OkSchema,
      ),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ["rank-audit"] });
    },
  });
  const headline = (position: number): string =>
    rows.find((row) => row.position === position)?.headline ?? `#${position}`;
  return (
    <div className="rank-audit-detail">
      <p>
        <b>formula:</b> #{pair.positionA} {headline(pair.positionA)} above #
        {pair.positionB} {headline(pair.positionB)}
      </p>
      <p>
        <b>llm says:</b> {pair.llmPrefers === "b" ? "swap them" : pair.llmPrefers}
        {pair.llmReason === null ? null : <> — {pair.llmReason}</>}
      </p>
      <p className="rank-audit-actions">
        <button
          disabled={label.isPending}
          onClick={() => label.mutate("a")}
          type="button"
        >
          formula is right
        </button>
        <button
          disabled={label.isPending}
          onClick={() => label.mutate("b")}
          type="button"
        >
          LLM is right
        </button>
        {label.isSuccess ? <span className="rank-labeled">labeled ✓</span> : null}
      </p>
    </div>
  );
}

export function RankingPage() {
  const [params, setParams] = useSearchParams();
  const [expanded, setExpanded] = useState<string | null>(null);

  const runs = useQuery({
    queryFn: () => fetchLab("/experiments", ExperimentListSchema),
    queryKey: ["lab-experiments"],
  });
  const runId = params.get("run") ?? runs.data?.items[0]?.id ?? "";
  const compareId = params.get("compare") ?? "";
  const facetType = params.get("facetType") ?? "global";
  const facetKey = params.get("facetKey") ?? "";
  const facetParam = `run=${runId}&facetType=${encodeURIComponent(facetType)}&facetKey=${encodeURIComponent(facetKey)}`;

  const setParam = (key: string, value: string): void => {
    setParams((current) => {
      const next = new URLSearchParams(current);
      if (value === "") {
        next.delete(key);
      } else {
        next.set(key, value);
      }
      if (key === "run") {
        next.delete("facetType");
        next.delete("facetKey");
      }
      return next;
    });
  };

  const facets = useQuery({
    enabled: runId !== "",
    queryFn: () => fetchLab(`/rank/facets?run=${runId}`, FacetsSchema),
    queryKey: ["rank-facets", runId],
  });
  const snapshot = useQuery({
    enabled: runId !== "",
    queryFn: () => fetchLab(`/rank/snapshot?${facetParam}&limit=50`, SnapshotSchema),
    queryKey: ["rank-snapshot", runId, facetType, facetKey],
  });
  const audit = useQuery({
    enabled: runId !== "",
    queryFn: () => fetchLab(`/rank/audit?${facetParam}`, AuditSchema),
    queryKey: ["rank-audit", runId, facetType, facetKey],
  });
  const auditRuns = useQuery({
    enabled: runId !== "",
    queryFn: () => fetchLab(`/rank/audit-runs?run=${runId}`, AuditRunsSchema),
    queryKey: ["rank-audit-runs", runId],
  });
  const compare = useQuery({
    enabled: compareId !== "",
    queryFn: () =>
      fetchLab(
        `/rank/snapshot?run=${compareId}&facetType=${encodeURIComponent(facetType)}&facetKey=${encodeURIComponent(facetKey)}&limit=200`,
        SnapshotSchema,
      ),
    queryKey: ["rank-snapshot", compareId, facetType, facetKey],
  });

  if (runs.isPending) return <LoadingState label="Loading experiment runs" />;
  if (runs.isError) return <ErrorState error={runs.error} />;

  const disagreeing = new Map<number, RankAuditPair[]>();
  for (const pair of audit.data?.pairs ?? []) {
    if (pair.llmPrefers !== "b") continue;
    for (const position of [pair.positionA, pair.positionB]) {
      disagreeing.set(position, [...(disagreeing.get(position) ?? []), pair]);
    }
  }
  const comparePosition = new Map<string, number>(
    (compare.data?.rows ?? []).map((row) => [row.storylineId, row.position]),
  );
  const metrics = auditRuns.data?.auditRuns[0]?.metrics as
    | {
        agreement_rate?: number | null;
        inconsistent_rate?: number | null;
        kendall_tau_sampled?: number | null;
        pairs?: number;
      }
    | null
    | undefined;

  return (
    <section>
      <SectionHeading
        aside={
          <span className="rank-metrics-strip">
            frozen per-run facet rankings · LLM audit is read-only tuning signal
          </span>
        }
        index="R"
        title="Ranking"
      />
      <div className="rank-controls">
        <label>
          Run{" "}
          <select onChange={(e) => setParam("run", e.target.value)} value={runId}>
            {runs.data.items.map((run) => (
              <option key={run.id} value={run.id}>
                {run.name} · {new Date(run.createdAt).toLocaleString()}
              </option>
            ))}
          </select>
        </label>
        <label>
          Facet{" "}
          <select
            onChange={(e) => {
              const [type, key] = e.target.value.split("|", 2);
              // one setParams call: chained functional updates in the same
              // tick resolve from the same base and drop each other's writes
              setParams((current) => {
                const next = new URLSearchParams(current);
                next.set("facetType", type ?? "global");
                next.set("facetKey", key ?? "");
                return next;
              });
            }}
            value={`${facetType}|${facetKey}`}
          >
            {(facets.data?.facets ?? []).map((facet) => (
              <option
                key={`${facet.facetType}|${facet.facetKey}`}
                value={`${facet.facetType}|${facet.facetKey}`}
              >
                {facet.facetType}
                {facet.facetKey === "" ? "" : `: ${facet.facetKey}`} (
                {facet.rows})
              </option>
            ))}
          </select>
        </label>
        <label>
          Compare with{" "}
          <select
            onChange={(e) => setParam("compare", e.target.value)}
            value={compareId}
          >
            <option value="">(none)</option>
            {runs.data.items
              .filter((run) => run.id !== runId)
              .map((run) => (
                <option key={run.id} value={run.id}>
                  {run.name} · {new Date(run.createdAt).toLocaleString()}
                </option>
              ))}
          </select>
        </label>
      </div>
      {metrics ? (
        <p className="rank-metrics-strip">
          audit: {metrics.pairs ?? 0} pairs · agreement{" "}
          {metrics.agreement_rate === null || metrics.agreement_rate === undefined
            ? "—"
            : `${(100 * metrics.agreement_rate).toFixed(0)}%`}{" "}
          · τ{" "}
          {metrics.kendall_tau_sampled === null ||
          metrics.kendall_tau_sampled === undefined
            ? "—"
            : metrics.kendall_tau_sampled.toFixed(2)}{" "}
          · inconsistent{" "}
          {metrics.inconsistent_rate === null ||
          metrics.inconsistent_rate === undefined
            ? "—"
            : `${(100 * metrics.inconsistent_rate).toFixed(0)}%`}
        </p>
      ) : (
        <p className="rank-metrics-strip">
          no audit yet — run <code>pipeline rank audit --run {runId}</code>
        </p>
      )}
      {snapshot.isPending ? <LoadingState label="Loading snapshot" /> : null}
      {snapshot.isError ? <ErrorState error={snapshot.error} /> : null}
      {snapshot.data ? (
        <table className="rank-table">
          <thead>
            <tr>
              <th>#</th>
              {compareId === "" ? null : <th>Δ</th>}
              <th>headline</th>
              <th>rank_key</th>
              <th>terms</th>
              <th>ag</th>
              <th>feeds</th>
              <th>entries</th>
              <th>judged</th>
              <th>rubric</th>
            </tr>
          </thead>
          <tbody>
            {snapshot.data.rows.map((row) => {
              const pairs = disagreeing.get(row.position) ?? [];
              const other = comparePosition.get(row.storylineId);
              const delta = other === undefined ? null : other - row.position;
              const rowKey = `${row.facetType}|${row.facetKey}|${row.position}`;
              return (
                <tr key={rowKey}>
                  <td>
                    {row.position}
                    {pairs.length > 0 ? (
                      <button
                        className="rank-audit-flag"
                        onClick={() =>
                          setExpanded(expanded === rowKey ? null : rowKey)
                        }
                        title="LLM audit disagrees with this placement"
                        type="button"
                      >
                        ⚑
                      </button>
                    ) : null}
                    {expanded === rowKey
                      ? pairs.map((pair) => (
                          <AuditDetail
                            key={`${pair.positionA}-${pair.positionB}`}
                            pair={pair}
                            rows={snapshot.data.rows}
                            runId={runId}
                          />
                        ))
                      : null}
                  </td>
                  {compareId === "" ? null : (
                    <td className="rank-delta">
                      {delta === null
                        ? "·"
                        : delta === 0
                          ? "="
                          : delta > 0
                            ? `▼${delta}`
                            : `▲${-delta}`}
                    </td>
                  )}
                  <td className="rank-headline">
                    <Link to={`/storylines/${row.storylineId}`}>
                      {row.headline ?? "(no headline)"}
                    </Link>
                    {row.interestReason === null ? null : (
                      <small title={row.interestReason}>
                        {row.interestReason}
                      </small>
                    )}
                  </td>
                  <td>{row.rankKey.toFixed(2)}</td>
                  <td>
                    <TermBar row={row} />
                  </td>
                  <td>{row.agencies}</td>
                  <td>{row.feeds}</td>
                  <td>{row.entryCount}</td>
                  <td>
                    <span className={row.judged ? "rank-judged" : "rank-prior"}>
                      {row.judged ? "judged" : "prior"}
                    </span>
                  </td>
                  <td className="rank-rubric">
                    {RUBRIC_CRITERIA.filter(
                      (criterion) => String(row.rubric?.[criterion]) === "1",
                    ).map((criterion) => (
                      <span className="rank-chip" key={criterion}>
                        {criterion}
                      </span>
                    ))}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      ) : null}
    </section>
  );
}
