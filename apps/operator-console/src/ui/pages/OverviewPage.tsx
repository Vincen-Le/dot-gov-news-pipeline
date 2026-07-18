import { OverviewDataSchema } from "@dot-gov-news/contracts";
import { useQuery } from "@tanstack/react-query";
import { useRef, useState } from "react";

import { fetchOperator } from "../api";
import {
  ComponentList,
  ErrorState,
  LoadingState,
  QueueTable,
  SectionHeading,
  StatusMark,
} from "../components";
import { useLiveActivity } from "../live";

function activityText(value: unknown): string {
  if (typeof value !== "object" || value === null) return String(value);
  const encoded = JSON.stringify(value);
  return encoded.length > 180 ? `${encoded.slice(0, 180)}…` : encoded;
}

export function OverviewPage() {
  const [livePaused, setLivePaused] = useState(false);
  const ledger = useRef<HTMLOListElement>(null);
  const overview = useQuery({
    queryFn: () => fetchOperator("/ops/v1/overview", OverviewDataSchema),
    queryKey: ["overview"],
    refetchInterval: () =>
      document.visibilityState === "visible" ? 30_000 : false,
  });
  const live = useLiveActivity(25, livePaused);
  const payload = overview.data;
  const failed =
    payload?.data.components.some(
      (component) => component.status === "failed",
    ) ?? false;

  return (
    <div className="page-stack">
      <section className="hero-grid">
        <div className="hero-orientation">
          <span className="section-index">I</span>
          <p className="eyebrow">Live system</p>
          <h1>Pipeline overview.</h1>
        </div>
        <div className="hero-statement">
          {overview.isLoading ? (
            <LoadingState />
          ) : overview.error !== null ? (
            <ErrorState error={overview.error} />
          ) : payload === undefined ? null : payload.data.inventory === null ? (
            <ErrorState error={new Error("Inventory source is unavailable")} />
          ) : (
            <>
              <p className="hero-number">
                {payload.data.inventory.totalCount.toLocaleString()}
              </p>
              <p>government sites are reconciled.</p>
              <p className="hero-secondary">
                {payload.data.inventory.usableCount.toLocaleString()} are usable
                inputs. Discovery and polling remain explicit capability gates.
              </p>
            </>
          )}
          <div className="hero-status">
            <StatusMark
              label={failed ? "Attention required" : "System healthy"}
              status={failed ? "attention" : "healthy"}
            />
            <StatusMark
              label={`Tail ${live.state}`}
              status={live.state === "live" ? "live" : "muted"}
            />
          </div>
        </div>
      </section>

      {payload === undefined ? null : (
        <>
          <section aria-label="Pipeline stages" className="pipeline-spine">
            <div className="pipeline-stage">
              <span>Inventory</span>
              <strong>
                {payload.data.inventory === null
                  ? "—"
                  : payload.data.inventory.usableCount.toLocaleString()}
              </strong>
              <small>usable</small>
            </div>
            <div className="pipeline-stage">
              <span>Discovery</span>
              <strong>
                {payload.data.inventory !== null &&
                payload.meta.capabilities.discovery.status === "available"
                  ? payload.data.inventory.discoveryLeasedCount
                  : "—"}
              </strong>
              <small>
                {payload.meta.capabilities.discovery.status.replace("_", " ")}
              </small>
            </div>
            <div className="pipeline-stage">
              <span>Feeds</span>
              <strong>—</strong>
              <small>
                {payload.meta.capabilities.feeds.status.replace("_", " ")}
              </small>
            </div>
            <div className="pipeline-stage">
              <span>Polling</span>
              <strong>—</strong>
              <small>
                {payload.meta.capabilities.polling.status.replace("_", " ")}
              </small>
            </div>
            <div className="pipeline-stage">
              <span>Entries</span>
              <strong>—</strong>
              <small>
                {payload.meta.capabilities.entries.status.replace("_", " ")}
              </small>
            </div>
            <div className="pipeline-stage">
              <span>Ranking</span>
              <strong>—</strong>
              <small>
                {payload.meta.capabilities.ranking.status.replace("_", " ")}
              </small>
            </div>
          </section>

          <div className="two-column-grid">
            <section className="ruled-section">
              <SectionHeading index="II" title="Active work" />
              <div className="not-enabled compact">
                <span className="eyebrow">Capability gated</span>
                <p>
                  Active work will use durable discovery leases as truth after
                  migrations 00400 and 00500 land.
                </p>
              </div>
            </section>
            <section className="ruled-section">
              <SectionHeading index="III" title="Component health" />
              <ComponentList components={payload.data.components} />
            </section>
          </div>

          <section className="ruled-section" id="queues">
            <SectionHeading
              index="IV"
              title="Queue pressure"
              aside={
                <span className="source-note">Cloudflare · approximate</span>
              }
            />
            <QueueTable queues={payload.data.queues} />
          </section>
        </>
      )}

      <section className="ruled-section">
        <SectionHeading
          index="V"
          title="Live activity"
          aside={
            <StatusMark
              label={live.state}
              status={live.state === "live" ? "live" : "muted"}
            />
          }
        />
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
              Waiting for sampled structured Worker activity.
            </li>
          ) : (
            live.activities.map((activity, index) => (
              <li key={`${activity.receivedAt}-${index}`}>
                <time dateTime={activity.receivedAt}>
                  {new Date(activity.receivedAt).toLocaleTimeString()}
                </time>
                <span>{activityText(activity.value)}</span>
              </li>
            ))
          )}
        </ol>
      </section>
    </div>
  );
}
