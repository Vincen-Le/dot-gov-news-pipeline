import { PipelineEventListDataSchema } from "@dot-gov-news/contracts";
import { useQuery } from "@tanstack/react-query";
import { useMemo, useRef, useState } from "react";
import { useSearchParams } from "react-router-dom";

import { fetchOperator } from "../api";
import {
  ErrorState,
  LoadingState,
  SectionHeading,
  StatusMark,
} from "../components";
import { useLiveActivity } from "../live";
import { sinceTimestamp } from "../../output";

function renderActivity(value: unknown): string {
  const text = JSON.stringify(value);
  return text.length > 300 ? `${text.slice(0, 300)}…` : text;
}

export function EventsPage() {
  const [livePaused, setLivePaused] = useState(false);
  const ledger = useRef<HTMLOListElement>(null);
  const [params] = useSearchParams();
  const since = params.get("since");
  const sinceValue = useMemo(() => {
    if (since === null) return undefined;
    try {
      return sinceTimestamp(since);
    } catch {
      return undefined;
    }
  }, [since]);
  const events = useQuery({
    queryFn: () =>
      fetchOperator(
        `/ops/v1/events?limit=100${sinceValue === undefined ? "" : `&since=${encodeURIComponent(sinceValue)}`}`,
        PipelineEventListDataSchema,
      ),
    queryKey: ["events", sinceValue],
    refetchInterval: () =>
      document.visibilityState === "visible" ? 15_000 : false,
  });
  const live = useLiveActivity(100, livePaused);

  return (
    <div className="page-stack">
      <section className="page-intro">
        <span className="section-index">I</span>
        <div>
          <p className="eyebrow">Durable + sampled</p>
          <h1>Events</h1>
          <p>
            Durable pipeline history and explicitly sampled real-time Worker
            activity.
          </p>
        </div>
      </section>
      <section className="ruled-section">
        <SectionHeading
          index="II"
          title="Live Worker activity"
          aside={
            <StatusMark
              label={live.state}
              status={live.state === "live" ? "live" : "muted"}
            />
          }
        />
        <p className="source-note">
          Sampled, transient, and never used as proof that a lease is still
          executing.
        </p>
        {live.pendingCount > 0 ? (
          <button
            className="text-button"
            onClick={() => {
              live.flush();
              setLivePaused(false);
              ledger.current?.scrollTo({ top: 0 });
            }}
            type="button"
          >
            Show {live.pendingCount} new live events
          </button>
        ) : null}
        <ol
          className="activity-ledger"
          onScroll={(event) => setLivePaused(event.currentTarget.scrollTop > 8)}
          ref={ledger}
        >
          {live.activities.length === 0 ? (
            <li className="empty-row">
              Waiting for structured lifecycle logs.
            </li>
          ) : (
            live.activities.map((activity, index) => (
              <li key={`${activity.receivedAt}-${index}`}>
                <time>
                  {new Date(activity.receivedAt).toLocaleTimeString()}
                </time>
                <span>{renderActivity(activity.value)}</span>
              </li>
            ))
          )}
        </ol>
      </section>
      <section className="ruled-section">
        <SectionHeading index="III" title="Durable event ledger" />
        {events.isLoading ? (
          <LoadingState />
        ) : events.error !== null ? (
          <ErrorState error={events.error} />
        ) : events.data?.data.items.length === 0 ? (
          <p className="empty-row">
            No durable events exist in this time range.
          </p>
        ) : (
          <div className="table-scroll">
            <table>
              <thead>
                <tr>
                  <th>Occurred</th>
                  <th>Type</th>
                  <th>Event ID</th>
                  <th>Artifact</th>
                </tr>
              </thead>
              <tbody>
                {events.data?.data.items.map((event) => (
                  <tr key={event.id}>
                    <td>{new Date(event.occurredAt).toLocaleString()}</td>
                    <th scope="row">{event.eventType}</th>
                    <td className="mono">{event.id}</td>
                    <td>{event.artifactKey ?? "—"}</td>
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
