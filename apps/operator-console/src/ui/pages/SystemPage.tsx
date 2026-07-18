import { HealthDataSchema, QueueListDataSchema } from "@dot-gov-news/contracts";
import { useQuery } from "@tanstack/react-query";
import { useSearchParams } from "react-router-dom";

import { fetchOperator } from "../api";
import {
  ComponentList,
  ErrorState,
  LoadingState,
  QueueTable,
  SectionHeading,
  StatusMark,
} from "../components";

export function SystemPage() {
  const [params, setParams] = useSearchParams();
  const depth = params.get("depth") === "deep" ? "deep" : "shallow";
  const health = useQuery({
    queryFn: () =>
      fetchOperator(`/ops/v1/system/health?depth=${depth}`, HealthDataSchema),
    queryKey: ["health", depth],
    refetchInterval: depth === "shallow" ? 10_000 : false,
  });
  const queues = useQuery({
    queryFn: () => fetchOperator("/ops/v1/queues", QueueListDataSchema),
    queryKey: ["queues"],
    refetchInterval: 10_000,
  });

  return (
    <div className="page-stack">
      <section className="page-intro">
        <span className="section-index">I</span>
        <div>
          <p className="eyebrow">Dependency checks</p>
          <h1>System</h1>
          <p>Independent read-only checks for every hosted component.</p>
        </div>
      </section>
      <section className="ruled-section">
        <SectionHeading
          index="II"
          title="Health checks"
          aside={
            <button
              className="text-button"
              onClick={() =>
                setParams(depth === "deep" ? {} : { depth: "deep" })
              }
              type="button"
            >
              Run {depth === "deep" ? "shallow" : "deep"} check
            </button>
          }
        />
        {health.isLoading ? (
          <LoadingState />
        ) : health.error !== null ? (
          <ErrorState error={health.error} />
        ) : health.data === undefined ? null : (
          <>
            <StatusMark
              label={`${health.data.data.status} · ${health.data.data.depth}`}
              status={
                health.data.data.status === "healthy"
                  ? "healthy"
                  : health.data.data.status === "failed"
                    ? "failed"
                    : "attention"
              }
            />
            <ComponentList components={health.data.data.components} />
          </>
        )}
      </section>
      <section className="ruled-section" id="queues">
        <SectionHeading
          index="III"
          title="Queues"
          aside={
            <span className="source-note">Provider observation time shown</span>
          }
        />
        {queues.isLoading ? (
          <LoadingState />
        ) : queues.error !== null ? (
          <ErrorState error={queues.error} />
        ) : queues.data === undefined ? null : (
          <QueueTable queues={queues.data.data.queues} />
        )}
      </section>
    </div>
  );
}
