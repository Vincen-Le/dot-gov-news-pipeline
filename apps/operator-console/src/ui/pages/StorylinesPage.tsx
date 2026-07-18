import { useQuery } from "@tanstack/react-query";
import { z } from "zod";
import { Link, useSearchParams } from "react-router-dom";

import {
  LabCapabilitySchema,
  StorylineListItemSchema,
} from "../../lab/contracts";
import { LabMetricsSchema } from "../../lab/metrics";
import { fetchLab } from "../lab-api";
import {
  CopyCommand,
  ErrorState,
  LoadingState,
  SectionHeading,
  relativeTime,
} from "../components";

const PAGE_SIZE = 50;

export function StorylinesPage() {
  const [params, setParams] = useSearchParams();
  const entity = params.get("entity") ?? "";
  const agency = params.get("agency") ?? "";
  const minEpisodes = params.get("minEpisodes") ?? "";
  const sort = params.get("sort") ?? "";
  const parsedPage = Number(params.get("page") ?? "1");
  const page = Number.isInteger(parsedPage) && parsedPage > 1 ? parsedPage : 1;
  const offset = (page - 1) * PAGE_SIZE;

  const capability = useQuery({
    queryFn: () => fetchLab("/capability", LabCapabilitySchema),
    queryKey: ["lab-capability"],
  });
  const metrics = useQuery({
    enabled: capability.data?.status === "available",
    queryFn: () => fetchLab("/metrics", LabMetricsSchema),
    queryKey: ["lab-metrics"],
    refetchInterval: 60_000,
  });
  const agencies = useQuery({
    enabled: capability.data?.status === "available",
    queryFn: () =>
      fetchLab("/agencies", z.object({ agencies: z.string().array() })),
    queryKey: ["lab-agencies"],
  });
  const query = new URLSearchParams();
  if (entity !== "") query.set("entity", entity);
  if (agency !== "") query.set("agency", agency);
  if (minEpisodes !== "") query.set("minEpisodes", minEpisodes);
  if (sort !== "") query.set("sort", sort);
  if (offset > 0) query.set("offset", String(offset));
  const storylines = useQuery({
    enabled: capability.data?.status === "available",
    queryFn: () =>
      fetchLab(
        `/storylines?${query.toString()}`,
        z.object({
          hasMore: z.boolean(),
          items: StorylineListItemSchema.array(),
        }),
      ),
    queryKey: ["lab-storylines", entity, agency, minEpisodes, sort, page],
  });

  if (capability.data?.status === "not_enabled") {
    return (
      <div className="not-enabled">
        <span className="eyebrow">Not enabled</span>
        <h2>Storylines</h2>
        <p>{capability.data.reason}</p>
      </div>
    );
  }

  const volume = metrics.data?.volume;
  const cliFilter = [
    entity === "" ? "" : ` --entity ${entity}`,
    agency === "" ? "" : ` --agency ${agency}`,
    minEpisodes === "" ? "" : ` --min-episodes ${minEpisodes}`,
    sort === "" ? "" : ` --sort ${sort}`,
    offset === 0 ? "" : ` --offset ${offset}`,
  ].join("");
  const goToPage = (next: number): void => {
    const nextParams = new URLSearchParams(params);
    if (next <= 1) nextParams.delete("page");
    else nextParams.set("page", String(next));
    setParams(nextParams);
  };
  const knownAgencies = agencies.data?.agencies ?? [];
  const agencyOptions =
    agency === "" || knownAgencies.includes(agency)
      ? knownAgencies
      : [agency, ...knownAgencies];

  return (
    <div className="page-stack">
      <section className="page-intro">
        <span className="section-index">S</span>
        <div>
          <p className="eyebrow">Cluster QA</p>
          <h1>Storylines</h1>
          <p>
            Chains reconstructed from the synced corpus: every attach decision
            carries its method, similarity, and threshold as evidence.
          </p>
        </div>
      </section>

      <section className="receipt-grid">
        {metrics.isLoading ? (
          <LoadingState label="Loading clustering state" />
        ) : metrics.error ? (
          <ErrorState error={metrics.error} />
        ) : volume === undefined ? null : volume.storylines === 0 ? (
          <div className="not-enabled compact">
            <span className="eyebrow">No clustered state</span>
            <p>
              The corpus has not been clustered yet. Run{" "}
              <code>pnpm ops lab run --name baseline --stub</code> or open the
              Lab.
            </p>
          </div>
        ) : (
          <>
            <div className="receipt-primary">
              <span className="eyebrow">Multi-episode chains</span>
              <strong>{volume.multiEpisodeStorylines.toLocaleString()}</strong>
              <span>the chain-reconstruction hypothesis, counted</span>
            </div>
            <dl className="metric-list">
              <div>
                <dt>Storylines</dt>
                <dd>{volume.storylines.toLocaleString()}</dd>
              </div>
              <div>
                <dt>Episodes</dt>
                <dd>{volume.episodes.toLocaleString()}</dd>
              </div>
              <div>
                <dt>Entries clustered</dt>
                <dd>{volume.entries.toLocaleString()}</dd>
              </div>
              <div>
                <dt>Event cards</dt>
                <dd>{volume.cards.toLocaleString()}</dd>
              </div>
            </dl>
          </>
        )}
      </section>

      <section className="ruled-section">
        <SectionHeading
          index="I"
          title="Chains"
          aside={
            <CopyCommand command={`pnpm ops lab storylines${cliFilter}`} />
          }
        />
        <form
          className="filter-bar"
          onSubmit={(event) => {
            event.preventDefault();
            const data = new FormData(event.currentTarget);
            const next: Record<string, string> = {};
            for (const key of ["entity", "agency", "minEpisodes", "sort"]) {
              const value = data.get(key);
              if (typeof value === "string" && value !== "") next[key] = value;
            }
            setParams(next);
          }}
        >
          <label htmlFor="entity">Entity</label>
          <input
            defaultValue={entity}
            id="entity"
            name="entity"
            placeholder="valsatrex"
          />
          <label htmlFor="agency">Agency</label>
          {/* remount once options load so defaultValue selects the URL's agency */}
          <select
            defaultValue={agency}
            id="agency"
            key={agencies.data === undefined ? "loading" : "loaded"}
            name="agency"
          >
            <option value="">All agencies</option>
            {agencyOptions.map((option) => (
              <option key={option} value={option}>
                {option}
              </option>
            ))}
          </select>
          <label htmlFor="minEpisodes">Min episodes</label>
          <input
            defaultValue={minEpisodes}
            id="minEpisodes"
            inputMode="numeric"
            name="minEpisodes"
            placeholder="2"
          />
          <label htmlFor="sort">Sort</label>
          <select defaultValue={sort} id="sort" name="sort">
            <option value="">Newest first</option>
            <option value="episodes">Most episodes</option>
          </select>
          <button type="submit">Apply filter</button>
        </form>
        {storylines.isLoading ? (
          <LoadingState />
        ) : storylines.error ? (
          <ErrorState error={storylines.error} />
        ) : storylines.data?.items.length === 0 && page === 1 ? (
          <p className="empty-row">No storylines match this filter.</p>
        ) : (
          <>
            <div className="table-scroll">
              <table>
                <thead>
                  <tr>
                    <th>Storyline</th>
                    <th>Episodes</th>
                    <th>Entries</th>
                    <th>Feeds</th>
                    <th>Agencies</th>
                    <th>Event keys</th>
                    <th>Newest</th>
                  </tr>
                </thead>
                <tbody>
                  {storylines.data?.items.map((item) => (
                    <tr key={item.id}>
                      <th scope="row">
                        <Link
                          className="row-button"
                          to={`/storylines/${item.id}`}
                        >
                          {item.headline ?? "(no card yet)"}
                        </Link>
                      </th>
                      <td className="numeric">{item.episodeCount}</td>
                      <td className="numeric">{item.entryCount}</td>
                      <td className="numeric">{item.distinctFeeds}</td>
                      <td>{item.agencies.join(", ") || "—"}</td>
                      <td className="mono">
                        {item.eventKeys.join(" ") || "—"}
                      </td>
                      <td>{relativeTime(item.newestEntryAt)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            {storylines.data?.items.length === 0 ? (
              <p className="empty-row">Nothing on this page.</p>
            ) : null}
            <div className="pagination">
              <button
                disabled={page <= 1}
                onClick={() => goToPage(page - 1)}
                type="button"
              >
                Previous
              </button>
              <span>Page {page}</span>
              <button
                disabled={storylines.data?.hasMore !== true}
                onClick={() => goToPage(page + 1)}
                type="button"
              >
                Next
              </button>
            </div>
          </>
        )}
      </section>
    </div>
  );
}
