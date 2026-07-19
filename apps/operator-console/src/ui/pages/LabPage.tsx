import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useRef, useState } from "react";
import { z } from "zod";

import {
  BorderlinePairSchema,
  CorpusSummarySchema,
  ExperimentRunSchema,
  LabCapabilitySchema,
  type ExperimentRun,
} from "../../lab/contracts";
import type { RunStage } from "../../lab/harness";
import { LabMetricsSchema } from "../../lab/metrics";
import {
  fetchLab,
  fetchPipelines,
  labBasePath,
  postLab,
  LabApiError,
} from "../lab-api";
import {
  CopyCommand,
  ErrorState,
  LoadingState,
  SectionHeading,
  StatusMark,
} from "../components";

const RunStageSchema = z.object({
  detail: z.string().optional(),
  name: z.enum(["reset-features", "prepare", "experiment"]),
  status: z.enum(["pending", "running", "succeeded", "failed", "skipped"]),
});
const ActiveRunSchema = z.object({
  name: z.string(),
  stages: RunStageSchema.array(),
  startedAt: z.string(),
  stub: z.boolean(),
});
const ExperimentListSchema = z.object({
  active: ActiveRunSchema.nullable(),
  items: ExperimentRunSchema.array(),
});
const SnapshotEventSchema = ActiveRunSchema.nullable();

// hints mirror pipeline/config.py defaults and the attach tiers in
// pipeline/episodes.py + pipeline/storylines.py — update together
const OVERRIDE_FIELDS = [
  {
    hint: "Similarity at or above which an entry attaches to an episode as a syndicated near-duplicate. Default 0.90.",
    key: "NEAR_DUP_THRESHOLD",
  },
  {
    hint: "Minimum centroid similarity to join an open episode — rare shared entities join outright, the rest go to the adjudicator. Default 0.78.",
    key: "CLUSTER_JOIN_THRESHOLD",
  },
  {
    hint: "Entities with a daily EMA at or above this are ambient (seen everywhere) and never justify a join on their own. Default 3.",
    key: "AMBIENT_EMA_CEILING",
  },
  {
    hint: "Open episodes close after this many hours without a new entry; later matches start a new episode in the chain. Default 4.",
    key: "EPISODE_DORMANCY_HOURS",
  },
  {
    hint: "Set false to embed raw titles instead of LLM-enriched text — isolates enrichment's effect on clustering. Default true.",
    key: "ENRICHMENT_ENABLED",
  },
] as const;

function stageStatus(stage: RunStage) {
  return stage.status === "running"
    ? ("live" as const)
    : stage.status === "succeeded"
      ? ("healthy" as const)
      : stage.status === "failed"
        ? ("failed" as const)
        : ("muted" as const);
}

function summaryRows(run: ExperimentRun): [string, number | null][] {
  return [
    ["entries clustered", run.summary?.entries_clustered ?? null],
    ["episodes", run.summary?.episodes ?? null],
    ["storylines", run.summary?.storylines ?? null],
    ["cards", run.summary?.cards ?? null],
    ["singleton episode rate", run.summary?.singleton_episode_rate ?? null],
    ["multi-episode chains", run.summary?.multi_episode_storylines ?? null],
  ];
}

function configDiff(
  left: Record<string, unknown> | null,
  right: Record<string, unknown> | null,
): { key: string; left: string; right: string }[] {
  const keys = new Set([
    ...Object.keys(left ?? {}),
    ...Object.keys(right ?? {}),
  ]);
  return [...keys]
    .sort()
    .filter(
      (key) => JSON.stringify(left?.[key]) !== JSON.stringify(right?.[key]),
    )
    .map((key) => ({
      key,
      left: JSON.stringify(left?.[key]) ?? "—",
      right: JSON.stringify(right?.[key]) ?? "—",
    }));
}

function Meter({ count, max }: { count: number; max: number }) {
  const width = max === 0 ? 0 : Math.max(4, Math.round((count / max) * 120));
  return (
    <span className="meter-track">
      <span className="meter" style={{ width: `${width}px` }} />
    </span>
  );
}

function RunSection({
  disabledReason,
  pipeline,
}: {
  disabledReason: string | null;
  pipeline?: string;
}) {
  const queryClient = useQueryClient();
  const [stages, setStages] = useState<RunStage[]>([]);
  const [log, setLog] = useState<string[]>([]);
  const [runName, setRunName] = useState<string | null>(null);
  const [result, setResult] = useState<{
    reportPath: string | null;
    runId: string | null;
    status: "failed" | "succeeded";
  } | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const sourceRef = useRef<EventSource | null>(null);
  // Tracks whether this tab is still waiting on a `done` event for the run
  // it just started. A fast (stub) run can finish before the EventSource
  // connects, so the initial `snapshot` may already show no active run.
  const awaitingTerminalRef = useRef(false);

  useEffect(() => () => sourceRef.current?.close(), []);

  const invalidateLabQueries = (): void => {
    for (const key of [
      "lab-metrics",
      "lab-experiments",
      "lab-storylines",
      "lab-corpus",
    ]) {
      void queryClient.invalidateQueries({ queryKey: [key, pipeline] });
    }
  };

  const follow = (): void => {
    sourceRef.current?.close();
    const source = new EventSource(
      `${labBasePath(pipeline)}/experiments/stream`,
    );
    sourceRef.current = source;
    source.addEventListener("snapshot", (event) => {
      const payload = SnapshotEventSchema.parse(
        JSON.parse((event as MessageEvent<string>).data),
      );
      if (payload !== null) {
        setStages(payload.stages);
        return;
      }
      // The harness has no active run. If we were still waiting on this
      // run's `done` event, it must have finished before we connected —
      // settle the UI the same way the `done` handler does.
      if (awaitingTerminalRef.current) {
        awaitingTerminalRef.current = false;
        source.close();
        invalidateLabQueries();
      }
    });
    source.addEventListener("stage", (event) => {
      const payload = JSON.parse((event as MessageEvent<string>).data) as {
        stage: RunStage;
      };
      setStages((current) =>
        current.map((stage) =>
          stage.name === payload.stage.name ? payload.stage : stage,
        ),
      );
    });
    source.addEventListener("log", (event) => {
      const payload = JSON.parse((event as MessageEvent<string>).data) as {
        line: string;
      };
      setLog((current) => [...current.slice(-400), payload.line]);
    });
    source.addEventListener("done", (event) => {
      const payload = JSON.parse((event as MessageEvent<string>).data) as {
        reportPath: string | null;
        runId: string | null;
        status: "failed" | "succeeded";
      };
      awaitingTerminalRef.current = false;
      setResult(payload);
      source.close();
      invalidateLabQueries();
    });
  };

  return (
    <section className="ruled-section" id="run">
      <SectionHeading
        index="II"
        title="Run experiment"
        aside={
          <CopyCommand command="pnpm ops lab run --name baseline --stub" />
        }
      />
      {disabledReason !== null ? (
        <p className="empty-row">{disabledReason}</p>
      ) : (
        <form
          className="lab-form"
          onSubmit={(event) => {
            event.preventDefault();
            setNotice(null);
            const data = new FormData(event.currentTarget);
            const env: Record<string, string> = {};
            for (const { key } of OVERRIDE_FIELDS) {
              const value = data.get(key);
              if (typeof value === "string" && value.trim() !== "")
                env[key] = value.trim();
            }
            const limitRaw = String(data.get("limit") ?? "");
            void postLab(
              "/experiments",
              {
                clearFeatures: data.get("clearFeatures") === "on",
                env,
                limit: limitRaw === "" ? null : Number(limitRaw),
                name: String(data.get("name") ?? ""),
                noCache: data.get("noCache") === "on",
                prepare: data.get("prepare") === "on" ? true : undefined,
                stub: data.get("stub") === "on",
              },
              ActiveRunSchema,
              pipeline,
            )
              .then((active) => {
                setRunName(active.name);
                setStages(active.stages);
                setLog([]);
                setResult(null);
                awaitingTerminalRef.current = true;
                follow();
              })
              .catch((error: unknown) => {
                setNotice(
                  error instanceof LabApiError
                    ? error.message
                    : "Failed to start the experiment",
                );
              });
          }}
        >
          <div>
            <label htmlFor="exp-name">Name</label>
            <input id="exp-name" name="name" placeholder="baseline" required />
          </div>
          {OVERRIDE_FIELDS.map(({ hint, key }) => (
            <div key={key}>
              <label htmlFor={`exp-${key}`}>{key.toLowerCase()}</label>
              <input
                className="mono"
                id={`exp-${key}`}
                name={key}
                placeholder="default"
              />
              <p className="field-hint">{hint}</p>
            </div>
          ))}
          <div>
            <label htmlFor="exp-limit">Limit</label>
            <input
              id="exp-limit"
              inputMode="numeric"
              name="limit"
              placeholder="all prepared entries"
            />
          </div>
          <div className="lab-form-actions">
            <span className="checkbox-row">
              <input id="exp-stub" name="stub" type="checkbox" />
              <label htmlFor="exp-stub">Stub models</label>
            </span>
            <span className="checkbox-row">
              <input id="exp-prepare" name="prepare" type="checkbox" />
              <label htmlFor="exp-prepare">Prepare features</label>
            </span>
            <span className="checkbox-row">
              <input id="exp-clear" name="clearFeatures" type="checkbox" />
              <label htmlFor="exp-clear">Re-embed (feature A/B)</label>
            </span>
            <span className="checkbox-row">
              <input id="exp-nocache" name="noCache" type="checkbox" />
              <label htmlFor="exp-nocache">Bypass decision cache</label>
            </span>
            <button type="submit">Start run</button>
          </div>
        </form>
      )}
      {notice === null ? null : (
        <p>
          <StatusMark label={notice} status="attention" />
        </p>
      )}
      {runName === null ? null : (
        <>
          <div aria-live="polite" className="stage-list">
            <span className="mono source-note">{runName}</span>
            {stages.map((stage) => (
              <StatusMark
                key={stage.name}
                label={`${stage.name} ${stage.status}`}
                status={stageStatus(stage)}
              />
            ))}
            {result === null ? null : (
              <>
                <StatusMark
                  label={result.status}
                  status={result.status === "succeeded" ? "healthy" : "failed"}
                />
                {result.runId === null ? null : (
                  <a
                    className="text-button"
                    href={`${labBasePath(pipeline)}/experiments/${result.runId}/report`}
                    rel="noreferrer"
                    target="_blank"
                  >
                    Open report
                  </a>
                )}
              </>
            )}
          </div>
          <ul className="activity-ledger">
            {log.map((line, index) => (
              <li key={index}>
                <time>·</time>
                <span>{line}</span>
              </li>
            ))}
          </ul>
        </>
      )}
    </section>
  );
}

export function LabPage() {
  const queryClient = useQueryClient();
  const [baselineId, setBaselineId] = useState<string>("");
  const [pipeline, setPipeline] = useState<string | undefined>(undefined);

  const pipelines = useQuery({
    queryFn: fetchPipelines,
    queryKey: ["lab-pipelines"],
  });
  // Once the registry loads, default to its first pipeline rather than the
  // env-only connection — with a registry present that env DSN is not
  // guaranteed to be either registered pipeline's own database.
  useEffect(() => {
    if (pipeline === undefined && (pipelines.data?.length ?? 0) > 0) {
      setPipeline(pipelines.data?.[0]?.name);
    }
  }, [pipeline, pipelines.data]);

  const capability = useQuery({
    queryFn: () => fetchLab("/capability", LabCapabilitySchema, pipeline),
    queryKey: ["lab-capability", pipeline],
  });
  const enabled = capability.data?.status === "available";
  const corpus = useQuery({
    enabled,
    queryFn: () => fetchLab("/corpus", CorpusSummarySchema, pipeline),
    queryKey: ["lab-corpus", pipeline],
  });
  const metrics = useQuery({
    enabled,
    queryFn: () => fetchLab("/metrics", LabMetricsSchema, pipeline),
    queryKey: ["lab-metrics", pipeline],
  });
  const experiments = useQuery({
    enabled,
    queryFn: () =>
      fetchLab("/experiments", ExperimentListSchema, pipeline),
    queryKey: ["lab-experiments", pipeline],
    refetchInterval: 30_000,
  });
  const borderline = useQuery({
    enabled,
    queryFn: () =>
      fetchLab(
        "/borderline?limit=25",
        z.object({ items: BorderlinePairSchema.array() }),
        pipeline,
      ),
    queryKey: ["lab-borderline", pipeline],
  });
  const labels = useQuery({
    enabled,
    queryFn: () =>
      fetchLab(
        "/labels",
        z.object({ count: z.number(), labels: z.unknown().array() }),
        pipeline,
      ),
    queryKey: ["lab-labels", pipeline],
  });

  if (capability.data?.status === "not_enabled") {
    return (
      <div className="not-enabled">
        <span className="eyebrow">Not enabled</span>
        <h2>Clustering lab</h2>
        <p>{capability.data.reason}</p>
      </div>
    );
  }

  const summary = corpus.data;
  const runs = experiments.data?.items ?? [];
  const newest = runs[0];
  const baseline = runs.find((run) => run.id === baselineId);
  const attachMax = Math.max(
    1,
    ...(metrics.data?.attachMix.map((row) => row.count) ?? [1]),
  );

  return (
    <div className="page-stack">
      <section className="page-intro">
        <span className="section-index">L</span>
        <div>
          <p className="eyebrow">Experiment bench</p>
          <h1>Lab</h1>
          {(pipelines.data?.length ?? 0) > 0 ? (
            <div className="pipeline-switcher">
              <label htmlFor="pipeline-select">Pipeline</label>
              <select
                id="pipeline-select"
                onChange={(event) => {
                  setBaselineId("");
                  setPipeline(event.currentTarget.value);
                }}
                value={pipeline ?? ""}
              >
                {pipelines.data?.map((entry) => (
                  <option key={entry.name} value={entry.name}>
                    {entry.name} ({entry.engine})
                  </option>
                ))}
              </select>
            </div>
          ) : null}
          <p>
            Replay the synced corpus through the clustering pipeline, measure
            the chains it builds, and label its borderline decisions.
          </p>
        </div>
      </section>

      <section className="receipt-grid" id="corpus">
        {corpus.isLoading ? (
          <LoadingState label="Loading corpus receipt" />
        ) : corpus.error ? (
          <ErrorState error={corpus.error} />
        ) : summary === undefined ? null : (
          <>
            <div className="receipt-primary">
              <span className="eyebrow">Corpus entries</span>
              <strong>{summary.entries.toLocaleString()}</strong>
              <span>
                {summary.firstPublishedAt ?? "—"} →{" "}
                {summary.lastPublishedAt ?? "—"} · {summary.sources} sources
              </span>
            </div>
            <dl className="metric-list">
              <div>
                <dt>Embedded</dt>
                <dd>{summary.embedded.toLocaleString()}</dd>
              </div>
              <div>
                <dt>Enriched</dt>
                <dd>{summary.enriched.toLocaleString()}</dd>
              </div>
              <div>
                <dt>Clustered</dt>
                <dd>{summary.clustered.toLocaleString()}</dd>
              </div>
              <div>
                <dt>Needs prepare</dt>
                <dd>
                  {summary.needsPrepare > 0 ? (
                    <StatusMark
                      label={`${summary.needsPrepare.toLocaleString()} — run form auto-prepares`}
                      status="attention"
                    />
                  ) : (
                    "0"
                  )}
                </dd>
              </div>
            </dl>
          </>
        )}
      </section>

      <RunSection
        disabledReason={
          capability.data === undefined
            ? "Loading capability"
            : !capability.data.experimentsEnabled
              ? (capability.data.experimentsReason ??
                "Experiments are not enabled")
              : experiments.data?.active
                ? `Experiment "${experiments.data.active.name}" is running`
                : null
        }
        pipeline={pipeline}
      />

      <section className="ruled-section" id="experiments">
        <SectionHeading
          index="III"
          title="Experiment runs"
          aside={<CopyCommand command="pnpm ops lab experiments" />}
        />
        {runs.length === 0 ? (
          <p className="empty-row">
            No experiment runs recorded yet — failed runs are not recorded.
          </p>
        ) : (
          <div className="table-scroll">
            <table>
              <thead>
                <tr>
                  <th>Run</th>
                  <th>Engine</th>
                  <th>Created</th>
                  <th>Duration</th>
                  <th>Processed</th>
                  <th>Episodes</th>
                  <th>Chains</th>
                  <th>Cache h/m</th>
                  <th>Report</th>
                  <th>Baseline</th>
                </tr>
              </thead>
              <tbody>
                {runs.map((run) => (
                  <tr key={run.id}>
                    <th className="mono" scope="row">
                      {run.name}
                    </th>
                    <td className="mono">
                      {typeof run.config?.engine === "string"
                        ? run.config.engine
                        : "—"}
                    </td>
                    <td>{new Date(run.createdAt).toLocaleString()}</td>
                    <td className="numeric">{run.durationSeconds}s</td>
                    <td className="numeric">
                      {run.clusterReport?.processed ?? "—"}
                    </td>
                    <td className="numeric">{run.summary?.episodes ?? "—"}</td>
                    <td className="numeric">
                      {run.summary?.multi_episode_storylines ?? "—"}
                    </td>
                    <td className="numeric">
                      {run.cacheHits}/{run.cacheMisses}
                    </td>
                    <td>
                      <a
                        className="text-button"
                        href={`${labBasePath(pipeline)}/experiments/${run.id}/report`}
                        rel="noreferrer"
                        target="_blank"
                      >
                        report
                      </a>
                    </td>
                    <td>
                      <button
                        className="row-button"
                        onClick={() => setBaselineId(run.id)}
                        type="button"
                      >
                        {baselineId === run.id ? "selected" : "compare"}
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
        {baseline !== undefined && newest !== undefined ? (
          <>
            <div className="table-scroll">
              <table>
                <thead>
                  <tr>
                    <th>Metric</th>
                    <th>{baseline.name}</th>
                    <th>{newest.name} (newest)</th>
                    <th>Delta</th>
                  </tr>
                </thead>
                <tbody>
                  {summaryRows(baseline).map(([label, left], index) => {
                    const right = summaryRows(newest)[index]?.[1] ?? null;
                    const delta =
                      left === null || right === null ? null : right - left;
                    return (
                      <tr key={label}>
                        <th scope="row">{label}</th>
                        <td className="numeric">{left ?? "—"}</td>
                        <td className="numeric">{right ?? "—"}</td>
                        <td
                          className={`numeric ${
                            delta === null || delta === 0
                              ? ""
                              : delta > 0
                                ? "delta-up"
                                : "delta-down"
                          }`}
                        >
                          {delta === null
                            ? "—"
                            : `${delta > 0 ? "+" : ""}${Number(delta.toFixed(4))}`}
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
            {configDiff(baseline.config, newest.config).length === 0 ? (
              <p className="empty-row">Identical configs.</p>
            ) : (
              <ul className="component-list">
                {configDiff(baseline.config, newest.config).map((row) => (
                  <li key={row.key}>
                    <span className="mono">{row.key}</span>
                    <strong className="mono">
                      {row.left} → {row.right}
                    </strong>
                    <span>config diff</span>
                  </li>
                ))}
              </ul>
            )}
          </>
        ) : null}
      </section>

      <section className="ruled-section" id="quality">
        <SectionHeading
          index="IV"
          title="Quality"
          aside={<CopyCommand command="pnpm ops lab metrics" />}
        />
        {metrics.isLoading ? (
          <LoadingState />
        ) : metrics.error ? (
          <ErrorState error={metrics.error} />
        ) : metrics.data === undefined ? null : metrics.data.volume
            .episodes === 0 ? (
          <p className="empty-row">
            No clustered state to measure — run an experiment first.
          </p>
        ) : (
          <>
            <div className="table-scroll">
              <table>
                <thead>
                  <tr>
                    <th>Attach method</th>
                    <th>Count</th>
                    <th />
                    <th>Avg similarity</th>
                  </tr>
                </thead>
                <tbody>
                  {metrics.data.attachMix.map((row) => (
                    <tr key={row.method}>
                      <th className="mono" scope="row">
                        {row.method}
                      </th>
                      <td className="numeric">{row.count}</td>
                      <td>
                        <Meter count={row.count} max={attachMax} />
                      </td>
                      <td className="numeric">{row.avgSimilarity ?? "—"}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            <p className="source-note">
              singleton episode rate {metrics.data.singletonEpisodeRate ?? "—"}{" "}
              · syndication {metrics.data.syndicationRate ?? "—"} · calibration
              pairs {metrics.data.calibration.pairCount} · suggested
              NEAR_DUP_THRESHOLD{" "}
              {metrics.data.calibration.suggestedNearDupThreshold ?? "—"}
            </p>
          </>
        )}
      </section>

      <section className="ruled-section" id="labels">
        <SectionHeading
          index="V"
          title="Label queue"
          aside={<CopyCommand command="pnpm ops lab borderline --limit 25" />}
        />
        <p className="source-note">
          {labels.data === undefined
            ? ""
            : `${labels.data.count} labeled pairs in docs/eval/labels.csv — the future eval harness's --labels input.`}
        </p>
        {borderline.data?.items.length === 0 ? (
          <p className="empty-row">
            No borderline attach decisions within 0.03 of a threshold.
          </p>
        ) : (
          <div className="table-scroll">
            <table>
              <thead>
                <tr>
                  <th>Entry</th>
                  <th>Matched</th>
                  <th>Method</th>
                  <th>Similarity</th>
                  <th>Same event?</th>
                </tr>
              </thead>
              <tbody>
                {borderline.data?.items.map((pair) => (
                  <tr key={`${pair.entryId}-${pair.matchedEntryId}`}>
                    <th scope="row">{pair.entryTitle ?? pair.entryId}</th>
                    <td>{pair.matchedTitle ?? pair.matchedEntryId ?? "—"}</td>
                    <td className="mono">{pair.attachMethod}</td>
                    <td className="mono">
                      {pair.similarity.toFixed(3)} /{" "}
                      {pair.thresholdUsed.toFixed(2)}
                    </td>
                    <td>
                      {pair.matchedEntryId === null ? (
                        "—"
                      ) : (
                        <span className="label-actions">
                          {(["y", "n"] as const).map((verdict) => (
                            <button
                              key={verdict}
                              onClick={() => {
                                void postLab(
                                  "/labels",
                                  {
                                    entryA: pair.entryId,
                                    entryB: pair.matchedEntryId,
                                    sameEvent: verdict === "y",
                                  },
                                  z.object({ saved: z.boolean() }),
                                  pipeline,
                                ).then(() => {
                                  void queryClient.invalidateQueries({
                                    queryKey: ["lab-borderline", pipeline],
                                  });
                                  void queryClient.invalidateQueries({
                                    queryKey: ["lab-labels", pipeline],
                                  });
                                });
                              }}
                              type="button"
                            >
                              {verdict}
                            </button>
                          ))}
                        </span>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>
    </div>
  );
}
