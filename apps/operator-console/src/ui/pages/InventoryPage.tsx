import {
  GovernmentSiteListDataSchema,
  InventoryRunListDataSchema,
  InventorySummaryDataSchema,
  type GovernmentSite,
} from "@dot-gov-news/contracts";
import { useQuery } from "@tanstack/react-query";
import { useEffect, useRef, useState } from "react";
import { useSearchParams } from "react-router-dom";

import { fetchOperator } from "../api";
import {
  CopyCommand,
  ErrorState,
  LoadingState,
  SectionHeading,
  StatusMark,
  relativeTime,
} from "../components";

function SiteInspector({
  close,
  site,
}: {
  close: () => void;
  site: GovernmentSite;
}) {
  const dialog = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    dialog.current?.showModal();
    return () => dialog.current?.close();
  }, []);

  return (
    <dialog
      aria-label="Site inspector"
      className="inspector"
      onCancel={(event) => {
        event.preventDefault();
        close();
      }}
      ref={dialog}
    >
      <header>
        <div>
          <p className="eyebrow">Site inspector</p>
          <h2>{site.baseDomain ?? site.sourceInitialUrl}</h2>
        </div>
        <button aria-label="Close inspector" onClick={close} type="button">
          ×
        </button>
      </header>
      <dl className="inspector-list">
        <div>
          <dt>ID</dt>
          <dd>{site.id}</dd>
        </div>
        <div>
          <dt>Agency</dt>
          <dd>{site.agency ?? "—"}</dd>
        </div>
        <div>
          <dt>Initial URL</dt>
          <dd>{site.initialUrl ?? "—"}</dd>
        </div>
        <div>
          <dt>Inventory</dt>
          <dd>{site.inventoryUsable ? "Usable" : site.exclusionReason}</dd>
        </div>
        <div>
          <dt>Discovery state</dt>
          <dd>{site.discoveryStatus ?? "Not enabled"}</dd>
        </div>
      </dl>
      <CopyCommand
        command={`pnpm ops site inspect ${site.baseDomain ?? site.sourceInitialUrl}`}
      />
    </dialog>
  );
}

export function InventoryPage() {
  const [params, setParams] = useSearchParams();
  const [selected, setSelected] = useState<GovernmentSite | null>(null);
  const hostname = params.get("hostname") ?? "";
  const summary = useQuery({
    queryFn: () =>
      fetchOperator("/ops/v1/inventory/summary", InventorySummaryDataSchema),
    queryKey: ["inventory-summary"],
    refetchInterval: 60_000,
  });
  const runs = useQuery({
    queryFn: () =>
      fetchOperator(
        "/ops/v1/inventory/runs?limit=10",
        InventoryRunListDataSchema,
      ),
    queryKey: ["inventory-runs"],
    refetchInterval: 60_000,
  });
  const sites = useQuery({
    queryFn: () =>
      fetchOperator(
        `/ops/v1/inventory/sites?limit=50${hostname === "" ? "" : `&hostname=${encodeURIComponent(hostname)}`}`,
        GovernmentSiteListDataSchema,
      ),
    queryKey: ["inventory-sites", hostname],
  });

  const receipt = summary.data?.data;

  return (
    <div className="page-stack">
      <section className="page-intro">
        <span className="section-index">I</span>
        <div>
          <p className="eyebrow">Verification receipt</p>
          <h1>Inventory</h1>
          <p>
            Durable GSA reconciliation state, run history, and site-level
            inputs.
          </p>
        </div>
      </section>

      <section className="receipt-grid">
        {summary.isLoading ? (
          <LoadingState label="Loading inventory receipt" />
        ) : summary.error !== null ? (
          <ErrorState error={summary.error} />
        ) : receipt === undefined ? null : (
          <>
            <div className="receipt-primary">
              <StatusMark
                label={receipt.latestRun?.status ?? "No runs"}
                status={
                  receipt.latestRun?.status === "succeeded"
                    ? "healthy"
                    : "attention"
                }
              />
              <strong>{receipt.summary.usableCount.toLocaleString()}</strong>
              <span>usable sites</span>
            </div>
            <dl className="metric-list">
              <div>
                <dt>Total</dt>
                <dd>{receipt.summary.totalCount.toLocaleString()}</dd>
              </div>
              <div>
                <dt>Active</dt>
                <dd>{receipt.summary.activeCount.toLocaleString()}</dd>
              </div>
              <div>
                <dt>Excluded</dt>
                <dd>
                  {receipt.summary.ingestionExcludedCount.toLocaleString()}
                </dd>
              </div>
              <div>
                <dt>Filtered</dt>
                <dd>{receipt.summary.gsaFilteredCount.toLocaleString()}</dd>
              </div>
              <div>
                <dt>Last success</dt>
                <dd>
                  {receipt.summary.latestSuccessAt === null
                    ? "—"
                    : relativeTime(receipt.summary.latestSuccessAt)}
                </dd>
              </div>
              <div>
                <dt>Artifact</dt>
                <dd>{receipt.latestRun?.rawArtifactKey ?? "—"}</dd>
              </div>
            </dl>
          </>
        )}
      </section>

      <section className="ruled-section" id="runs">
        <SectionHeading
          index="II"
          title="Run history"
          aside={<CopyCommand command="pnpm ops inventory runs --limit 10" />}
        />
        {runs.isLoading ? (
          <LoadingState />
        ) : runs.error !== null ? (
          <ErrorState error={runs.error} />
        ) : runs.data?.data.items.length === 0 ? (
          <p className="empty-row">No inventory runs have been recorded yet.</p>
        ) : (
          <div className="table-scroll">
            <table>
              <thead>
                <tr>
                  <th>Started</th>
                  <th>Status</th>
                  <th>Source</th>
                  <th>Inserted</th>
                  <th>Updated</th>
                  <th>Eligible</th>
                </tr>
              </thead>
              <tbody>
                {runs.data?.data.items.map((run) => (
                  <tr key={run.id}>
                    <td>{new Date(run.startedAt).toLocaleString()}</td>
                    <td>{run.status}</td>
                    <td className="numeric">{run.counts.sourceRows ?? "—"}</td>
                    <td className="numeric">{run.counts.inserted}</td>
                    <td className="numeric">{run.counts.updated}</td>
                    <td className="numeric">{run.counts.eligible}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>

      <section className="ruled-section">
        <SectionHeading
          index="III"
          title="Government sites"
          aside={
            <CopyCommand
              command={
                hostname === ""
                  ? "pnpm ops inventory sites --limit 50"
                  : `pnpm ops inventory sites --hostname ${hostname}`
              }
            />
          }
        />
        <form
          className="filter-bar"
          onSubmit={(event) => {
            event.preventDefault();
            const value = new FormData(event.currentTarget).get("hostname");
            setParams(
              typeof value === "string" && value !== ""
                ? { hostname: value }
                : {},
            );
          }}
        >
          <div className="filter-field">
            <label htmlFor="hostname">Hostname</label>
            <input
              defaultValue={hostname}
              id="hostname"
              name="hostname"
              placeholder="nasa.gov"
            />
          </div>
          <button type="submit">Apply filter</button>
        </form>
        {sites.isLoading ? (
          <LoadingState />
        ) : sites.error !== null ? (
          <ErrorState error={sites.error} />
        ) : sites.data?.data.items.length === 0 ? (
          <p className="empty-row">
            No government sites match this hostname filter.
          </p>
        ) : (
          <div className="table-scroll">
            <table>
              <thead>
                <tr>
                  <th>Hostname</th>
                  <th>Agency</th>
                  <th>Usable</th>
                  <th>Active</th>
                  <th>Discovery</th>
                  <th>Last seen</th>
                </tr>
              </thead>
              <tbody>
                {sites.data?.data.items.map((site) => (
                  <tr key={site.id}>
                    <th scope="row">
                      <button
                        className="row-button"
                        onClick={() => setSelected(site)}
                        type="button"
                      >
                        {site.baseDomain ?? site.sourceInitialUrl}
                      </button>
                    </th>
                    <td>{site.agency ?? "—"}</td>
                    <td>{site.inventoryUsable ? "Yes" : "No"}</td>
                    <td>{site.inventoryActive ? "Yes" : "No"}</td>
                    <td>{site.discoveryStatus ?? "—"}</td>
                    <td>{relativeTime(site.lastSeenAt)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>

      {selected === null ? null : (
        <SiteInspector close={() => setSelected(null)} site={selected} />
      )}
    </div>
  );
}
