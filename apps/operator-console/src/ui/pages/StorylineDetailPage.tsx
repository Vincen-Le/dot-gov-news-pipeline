import { useQuery } from "@tanstack/react-query";
import { useEffect, useRef, useState } from "react";
import { Link, useParams } from "react-router-dom";

import {
  StorylineDetailSchema,
  type EntryEvidence,
  type EventCard,
} from "../../lab/contracts";
import { fetchLab } from "../lab-api";
import {
  CopyCommand,
  ErrorState,
  LoadingState,
  SectionHeading,
  StatusMark,
} from "../components";

function Similarity({
  similarity,
  threshold,
}: {
  similarity: number | null;
  threshold: number | null;
}) {
  if (similarity === null) return <span className="mono">—</span>;
  return (
    <span className="mono">
      {similarity.toFixed(3)}
      {threshold === null ? "" : ` ≥ ${threshold.toFixed(2)}`}
    </span>
  );
}

function EntryInspector({
  close,
  entry,
}: {
  close: () => void;
  entry: EntryEvidence;
}) {
  const dialog = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    dialog.current?.showModal();
    return () => dialog.current?.close();
  }, []);
  return (
    <dialog
      aria-label="Entry evidence"
      className="inspector"
      onCancel={(event) => {
        event.preventDefault();
        close();
      }}
      ref={dialog}
    >
      <header>
        <div>
          <p className="eyebrow">Attach evidence</p>
          <h2>{entry.title ?? entry.url}</h2>
        </div>
        <button aria-label="Close inspector" onClick={close} type="button">
          ×
        </button>
      </header>
      <dl className="inspector-list">
        <div>
          <dt>Entry</dt>
          <dd>{entry.id}</dd>
        </div>
        <div>
          <dt>URL</dt>
          <dd>{entry.url}</dd>
        </div>
        <div>
          <dt>Agency</dt>
          <dd>{entry.agency}</dd>
        </div>
        <div>
          <dt>Published</dt>
          <dd>{entry.publishedAt ?? "—"}</dd>
        </div>
        <div>
          <dt>Method</dt>
          <dd>{entry.attachMethod}</dd>
        </div>
        <div>
          <dt>Similarity</dt>
          <dd>
            {entry.similarity ?? "—"} vs threshold {entry.thresholdUsed ?? "—"}
          </dd>
        </div>
        <div>
          <dt>Matched entry</dt>
          <dd>{entry.matchedEntryId ?? "—"}</dd>
        </div>
        <div>
          <dt>Syndicated</dt>
          <dd>{entry.isSyndicated ? "yes" : "no"}</dd>
        </div>
        <div>
          <dt>Entities</dt>
          <dd>{entry.entitySet.join(", ") || "—"}</dd>
        </div>
        <div>
          <dt>Event keys</dt>
          <dd>{entry.eventKeys.join(", ") || "—"}</dd>
        </div>
      </dl>
      <CopyCommand command="pnpm ops lab storyline <id> --json" />
    </dialog>
  );
}

function OverviewCardBlock({ card }: { card: EventCard }) {
  return (
    <article className="card-block">
      <header>
        <span className="attach-tag">
          overview v{card.version}
          {card.supersededBy === null ? "" : " · superseded"}
        </span>
        <span className="mono source-note">rank {card.rankKey.toFixed(3)}</span>
      </header>
      <h3>{card.headline}</h3>
      <p>{card.summary}</p>
      {card.timeline === null ? null : (
        <ol className="timeline-list">
          {card.timeline.map((item, index) => (
            <li key={index}>
              <span className="mono">{item.date}</span>
              <span>
                {item.text}{" "}
                {item.cited ? (
                  <a className="cite-link" href={`#episode-${item.episodeId}`}>
                    → episode
                  </a>
                ) : (
                  <StatusMark label="uncited" status="failed" />
                )}
              </span>
            </li>
          ))}
        </ol>
      )}
    </article>
  );
}

export function StorylineDetailPage() {
  const { id } = useParams();
  const [selected, setSelected] = useState<EntryEvidence | null>(null);
  const detail = useQuery({
    enabled: id !== undefined,
    queryFn: () => fetchLab(`/storylines/${id}`, StorylineDetailSchema),
    queryKey: ["lab-storyline", id],
  });

  if (detail.isLoading) return <LoadingState label="Loading chain" />;
  if (detail.error) return <ErrorState error={detail.error} />;
  const storyline = detail.data;
  if (storyline === undefined) return null;

  return (
    <div className="page-stack">
      <section className="page-intro">
        <span className="section-index">
          <Link className="row-button" to="/storylines">
            ← Storylines
          </Link>
        </span>
        <div>
          <p className="eyebrow">
            {storyline.episodeCount} episodes · {storyline.entryCount} entries ·{" "}
            {storyline.distinctFeeds} feeds
          </p>
          <h1>{storyline.headline ?? "Uncarded storyline"}</h1>
          <p>
            {storyline.agencies.join(", ")}
            {storyline.eventKeys.length > 0
              ? ` · keys: ${storyline.eventKeys.join(" ")}`
              : ""}
          </p>
          {storyline.themeName === null ? null : (
            <p className="source-note">
              Theme: {storyline.themeName}
              {storyline.categoryName === null
                ? ""
                : ` · ${storyline.categoryName}`}
              {storyline.themeAttachMethod === null
                ? ""
                : ` · ${storyline.themeAttachMethod}`}
              {storyline.themeSimilarity === null
                ? ""
                : ` · sim ${storyline.themeSimilarity.toFixed(3)}`}
              {storyline.themeReason === null
                ? ""
                : ` — ${storyline.themeReason}`}
            </p>
          )}
        </div>
      </section>

      <div className="two-column-grid">
        <section className="ruled-section">
          <SectionHeading
            index="I"
            title="Episode chain"
            aside={
              <CopyCommand command={`pnpm ops lab storyline ${storyline.id}`} />
            }
          />
          <ol className="chain-rail">
            {storyline.episodes.map((episode, index) => (
              <li id={`episode-${episode.id}`} key={episode.id}>
                <header>
                  <span className="section-index">
                    {String(index + 1).padStart(2, "0")}
                  </span>
                  <StatusMark
                    label={episode.status}
                    status={episode.status === "open" ? "live" : "muted"}
                  />
                  <span className="attach-tag">{episode.attachMethod}</span>
                  {episode.attachSimilarity === null ? null : (
                    <span className="mono source-note">
                      sim {episode.attachSimilarity.toFixed(3)}
                    </span>
                  )}
                </header>
                <h3>{episode.card?.headline ?? "(no episode card yet)"}</h3>
                {episode.attachReason === null ? null : (
                  <p className="source-note">
                    {episode.adjudicatorModel === null
                      ? ""
                      : `${episode.adjudicatorModel}: `}
                    {episode.attachReason}
                  </p>
                )}
                <div className="table-scroll">
                  <table>
                    <thead>
                      <tr>
                        <th>Entry</th>
                        <th>Agency</th>
                        <th>Method</th>
                        <th>Similarity</th>
                        <th>Synd.</th>
                      </tr>
                    </thead>
                    <tbody>
                      {episode.entries.map((entry) => (
                        <tr key={entry.id}>
                          <th scope="row">
                            <button
                              className="row-button"
                              onClick={() => setSelected(entry)}
                              type="button"
                            >
                              {entry.title ?? entry.url}
                            </button>
                          </th>
                          <td>{entry.agency}</td>
                          <td className="mono">{entry.attachMethod}</td>
                          <td>
                            <Similarity
                              similarity={entry.similarity}
                              threshold={entry.thresholdUsed}
                            />
                          </td>
                          <td>{entry.isSyndicated ? "yes" : "—"}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </li>
            ))}
          </ol>
        </section>

        <section className="ruled-section">
          <SectionHeading index="II" title="Event cards" />
          {storyline.overviewCards.length === 0 ? (
            <p className="empty-row">No overview card yet.</p>
          ) : (
            <div className="card-stack">
              {storyline.overviewCards.map((card) => (
                <OverviewCardBlock card={card} key={card.id} />
              ))}
            </div>
          )}
        </section>
      </div>

      {selected === null ? null : (
        <EntryInspector close={() => setSelected(null)} entry={selected} />
      )}
    </div>
  );
}
