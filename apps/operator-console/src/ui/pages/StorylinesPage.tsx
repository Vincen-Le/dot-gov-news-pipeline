import { useQuery } from "@tanstack/react-query";
import { Fragment } from "react";
import { z } from "zod";
import { Link, useSearchParams } from "react-router-dom";

import {
  LabCapabilitySchema,
  StorylineListItemSchema,
  TopicCategorySchema,
  TopicThemeSchema,
  type StorylineListItem,
} from "../../lab/contracts";
import { LabMetricsSchema } from "../../lab/metrics";
import { fetchLab } from "../lab-api";
import { useExperimentView, withExperiment } from "../experiment-view";
import {
  CopyCommand,
  ErrorState,
  LoadingState,
  SectionHeading,
  relativeTime,
} from "../components";

const PAGE_SIZE = 50;
type GroupBy = "category" | "theme";

function groupLabel(item: StorylineListItem, groupBy: GroupBy): string {
  if (groupBy === "theme") return item.themeName ?? "Unassigned theme";
  return item.categoryName ?? "Unassigned category";
}

export function StorylinesPage() {
  const { selectedId } = useExperimentView();
  const [params, setParams] = useSearchParams();
  const entity = params.get("entity") ?? "";
  const agency = params.get("agency") ?? "";
  const minEpisodes = params.get("minEpisodes") ?? "";
  const sort = params.get("sort") ?? "";
  const theme = params.get("theme") ?? "";
  const category = params.get("category") ?? "";
  const groupByParam = params.get("groupBy");
  const groupBy: GroupBy | "" =
    groupByParam === "theme" || groupByParam === "category" ? groupByParam : "";
  const parsedPage = Number(params.get("page") ?? "1");
  const page = Number.isInteger(parsedPage) && parsedPage > 1 ? parsedPage : 1;
  const offset = (page - 1) * PAGE_SIZE;

  const capability = useQuery({
    queryFn: () => fetchLab("/capability", LabCapabilitySchema),
    queryKey: ["lab-capability"],
  });
  const metrics = useQuery({
    enabled: capability.data?.status === "available",
    queryFn: () =>
      fetchLab(withExperiment("/metrics", selectedId), LabMetricsSchema),
    queryKey: ["lab-metrics", selectedId],
    refetchInterval: 60_000,
  });
  const agencies = useQuery({
    enabled: capability.data?.status === "available",
    queryFn: () =>
      fetchLab(
        withExperiment("/agencies", selectedId),
        z.object({ agencies: z.string().array() }),
      ),
    queryKey: ["lab-agencies", selectedId],
  });
  const categories = useQuery({
    enabled: capability.data?.status === "available",
    queryFn: () =>
      fetchLab(
        withExperiment("/topics/categories", selectedId),
        z.object({ categories: TopicCategorySchema.array() }),
      ),
    queryKey: ["lab-topic-categories", selectedId],
  });
  const themes = useQuery({
    enabled: capability.data?.status === "available",
    queryFn: () =>
      fetchLab(
        withExperiment(
          `/topics/themes${category === "" ? "" : `?category=${category}`}`,
          selectedId,
        ),
        z.object({ themes: TopicThemeSchema.array() }),
      ),
    queryKey: ["lab-topic-themes", selectedId, category],
  });
  const query = new URLSearchParams();
  if (entity !== "") query.set("entity", entity);
  if (agency !== "") query.set("agency", agency);
  if (minEpisodes !== "") query.set("minEpisodes", minEpisodes);
  if (sort !== "") query.set("sort", sort);
  if (theme !== "") query.set("theme", theme);
  if (category !== "") query.set("category", category);
  if (groupBy !== "") query.set("groupBy", groupBy);
  if (offset > 0) query.set("offset", String(offset));
  if (selectedId !== null) query.set("experiment", selectedId);
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
    queryKey: [
      "lab-storylines",
      selectedId,
      entity,
      agency,
      minEpisodes,
      sort,
      theme,
      category,
      groupBy,
      page,
    ],
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
    category === "" ? "" : ` --category ${category}`,
    theme === "" ? "" : ` --theme ${theme}`,
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
            for (const key of [
              "entity",
              "agency",
              "minEpisodes",
              "sort",
              "category",
              "theme",
              "groupBy",
            ]) {
              const value = data.get(key);
              if (typeof value === "string" && value !== "") next[key] = value;
            }
            setParams(next);
          }}
        >
          <div className="filter-field">
            <label htmlFor="entity">Entity</label>
            <input
              defaultValue={entity}
              id="entity"
              name="entity"
              placeholder="valsatrex"
            />
          </div>
          <div className="filter-field">
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
          </div>
          <div className="filter-field">
            <label htmlFor="category">Category</label>
            <select
              defaultValue={category}
              id="category"
              key={categories.data === undefined ? "cat-loading" : "cat-loaded"}
              name="category"
            >
              <option value="">All categories</option>
              {(categories.data?.categories ?? []).map((option) => (
                <option key={option.id} value={option.id}>
                  {option.origin === "llm"
                    ? `${option.displayName} (LLM)`
                    : option.displayName}
                </option>
              ))}
            </select>
          </div>
          <div className="filter-field">
            <label htmlFor="theme">Theme</label>
            <select
              defaultValue={theme}
              id="theme"
              key={themes.data === undefined ? "theme-loading" : "theme-loaded"}
              name="theme"
            >
              <option value="">All themes</option>
              {(themes.data?.themes ?? []).map((option) => (
                <option key={option.id} value={option.id}>
                  {option.displayName} ({option.storylineCount})
                </option>
              ))}
            </select>
          </div>
          <div className="filter-field">
            <label htmlFor="groupBy">Group by</label>
            <select defaultValue={groupBy} id="groupBy" name="groupBy">
              <option value="">None</option>
              <option value="theme">Theme</option>
              <option value="category">Category</option>
            </select>
          </div>
          <div className="filter-field">
            <label htmlFor="minEpisodes">Min episodes</label>
            <input
              defaultValue={minEpisodes}
              id="minEpisodes"
              inputMode="numeric"
              name="minEpisodes"
              placeholder="2"
            />
          </div>
          <div className="filter-field">
            <label htmlFor="sort">Sort</label>
            <select defaultValue={sort} id="sort" name="sort">
              <option value="">Newest first</option>
              <option value="episodes">Most episodes</option>
            </select>
          </div>
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
                    <th>Category</th>
                    <th>Theme</th>
                    <th>Event keys</th>
                    <th>Newest</th>
                  </tr>
                </thead>
                <tbody>
                  {storylines.data?.items.map((item, index, items) => {
                    const label =
                      groupBy === "" ? null : groupLabel(item, groupBy);
                    const previousLabel =
                      groupBy === "" || index === 0
                        ? null
                        : groupLabel(items[index - 1]!, groupBy);
                    return (
                      <Fragment key={item.id}>
                        {label !== null && label !== previousLabel ? (
                          <tr className="storyline-group-row">
                            <th colSpan={9} scope="rowgroup">
                              <span>
                                {groupBy === "theme" ? "Theme" : "Category"}
                              </span>
                              <strong>{label}</strong>
                            </th>
                          </tr>
                        ) : null}
                        <tr>
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
                          <td className="wrap">
                            {item.agencies.join(", ") || "—"}
                          </td>
                          <td className="wrap">{item.categoryName ?? "—"}</td>
                          <td className="wrap">{item.themeName ?? "—"}</td>
                          <td className="mono wrap">
                            {item.eventKeys.join(" ") || "—"}
                          </td>
                          <td>{relativeTime(item.newestEntryAt)}</td>
                        </tr>
                      </Fragment>
                    );
                  })}
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
