import { useEffect, useRef } from "react";

import type { RankRowDetail } from "../../lab/contracts";

export function RankStorylineDialog({
  detail,
  error,
  loading,
  onClose,
}: {
  detail?: RankRowDetail;
  error?: Error | null;
  loading: boolean;
  onClose: () => void;
}) {
  const ref = useRef<HTMLDialogElement>(null);

  useEffect(() => {
    const dialog = ref.current;
    if (dialog && !dialog.open) dialog.showModal();
    return () => dialog?.close();
  }, []);

  const opinion = detail?.positionOpinion;
  const movement =
    opinion?.positionDelta === null || opinion?.positionDelta === undefined
      ? null
      : Math.abs(opinion.positionDelta);

  return (
    <dialog
      aria-labelledby="rank-detail-title"
      className="rank-detail-dialog"
      onCancel={(event) => {
        event.preventDefault();
        onClose();
      }}
      onClick={(event) => {
        if (event.target === ref.current) onClose();
      }}
      ref={ref}
    >
      <div className="rank-detail-shell">
        <header className="rank-detail-header">
          <div>
            <small>
              {detail
                ? `Storyline snapshot as of ${new Date(
                    detail.storylineSnapshot.knowledgeCutoffAt,
                  ).toLocaleString()} · rank system v${detail.identity.rankSystemVersionNumber}`
                : "Ranked storyline snapshot"}
            </small>
            <h2 id="rank-detail-title">
              {detail?.storylineSnapshot.headline ?? "Loading rank detail…"}
            </h2>
          </div>
          <button autoFocus onClick={onClose} type="button">
            Close
          </button>
        </header>
        {loading ? (
          <p aria-live="polite" className="rank-detail-state">
            Loading the frozen storyline and rank calculation…
          </p>
        ) : null}
        {error ? (
          <p className="rank-detail-state rank-detail-error" role="alert">
            {error.message}
          </p>
        ) : null}
        {detail ? (
          <div className="rank-detail-grid">
            <main className="rank-story-pane">
              <p className="rank-detail-summary">
                {detail.storylineSnapshot.summary}
              </p>
              <p className="rank-detail-meta">
                {detail.storylineSnapshot.entryCount} sources ·{" "}
                {detail.storylineSnapshot.episodes.length} episodes ·{" "}
                {detail.storylineSnapshot.agencies.join(", ") || "no agency"}
              </p>
              <section>
                <h3>Timeline at this point</h3>
                {detail.storylineSnapshot.timeline.length === 0 ? (
                  <p className="rank-detail-empty">No overview timeline.</p>
                ) : (
                  <ol className="rank-detail-list">
                    {detail.storylineSnapshot.timeline.map((item, index) => (
                      <li key={`${String(item.date ?? "")}-${index}`}>
                        <time>{String(item.date ?? "")}</time>
                        <span>{String(item.text ?? "")}</span>
                      </li>
                    ))}
                  </ol>
                )}
              </section>
              <section>
                <h3>Episodes</h3>
                {detail.storylineSnapshot.episodes.length === 0 ? (
                  <p className="rank-detail-empty">No frozen episode detail.</p>
                ) : (
                  <ol className="rank-episode-list">
                    {detail.storylineSnapshot.episodes.map((episode) => (
                      <li key={episode.id}>
                        <time>{episode.firstEntryAt ?? "Unknown date"}</time>
                        <b>{episode.headline ?? "Untitled episode"}</b>
                        {episode.summary ? <p>{episode.summary}</p> : null}
                      </li>
                    ))}
                  </ol>
                )}
              </section>
              <section>
                <h3>Source records</h3>
                {detail.storylineSnapshot.sourceEntries.length === 0 ? (
                  <p className="rank-detail-empty">No frozen source detail.</p>
                ) : (
                  <ul className="rank-source-list">
                    {detail.storylineSnapshot.sourceEntries.map((source) => (
                      <li key={source.id}>
                        <a href={source.url} rel="noreferrer" target="_blank">
                          {source.title ?? source.url}
                        </a>
                        <small>
                          {source.agencies.join(", ") || "unknown agency"} ·{" "}
                          {source.publishedAt ?? "unknown date"}
                          {source.isSyndicated ? " · syndicated" : ""}
                        </small>
                      </li>
                    ))}
                  </ul>
                )}
              </section>
            </main>
            <aside className="rank-analysis-pane">
              <section className="rank-opinion-card">
                <h3>LLM category-position opinion</h3>
                {opinion == null ? (
                  <p>Position opinion has not been generated.</p>
                ) : (
                  <>
                    <strong>
                      {opinion.direction === "stay"
                        ? "Keep this position"
                        : opinion.status === "bounded"
                          ? `At least ${movement ?? "?"} positions ${opinion.direction}`
                          : `${opinion.direction} ${movement ?? "?"} positions`}
                    </strong>
                    <p>{opinion.reason ?? "No reason supplied."}</p>
                    <small>Status: {opinion.status.replaceAll("_", " ")}</small>
                  </>
                )}
              </section>
              <section>
                <h3>Category neighbors passed to the judge</h3>
                {detail.categoryNeighbors.length === 0 ? (
                  <p className="rank-detail-empty">No category neighbors.</p>
                ) : (
                  <ol className="rank-neighbor-list">
                    {detail.categoryNeighbors.map((neighbor) => (
                      <li
                        aria-current={
                          neighbor.relation === "target" ? "true" : undefined
                        }
                        key={neighbor.goldenEventCardId}
                      >
                        <span>#{neighbor.categoryPosition}</span>
                        <b>{neighbor.headline}</b>
                        <small>{neighbor.rankKey.toFixed(2)}</small>
                      </li>
                    ))}
                  </ol>
                )}
              </section>
              <section>
                <h3>Exact rank calculation</h3>
                <p className="rank-key-total">
                  {detail.calculation.rankKey.toFixed(4)}
                </p>
                <dl className="rank-term-list">
                  {detail.calculation.termBreakdown.map((term) => (
                    <div key={term.key}>
                      <dt>{term.label}</dt>
                      <dd>{term.value.toFixed(4)}</dd>
                    </div>
                  ))}
                </dl>
              </section>
              <section>
                <h3>Judge rubric</h3>
                <ul className="rank-rubric-list">
                  {detail.calculation.rubricDecisions.map((decision) => (
                    <li key={decision.key}>
                      <span>{decision.key.replaceAll("_", " ")}</span>
                      <b>{decision.value ? "yes" : "no"}</b>
                    </li>
                  ))}
                </ul>
              </section>
              <details>
                <summary>Frozen inputs and provenance</summary>
                <pre>
                  {JSON.stringify(detail.calculation.rankInput, null, 2)}
                </pre>
                <dl className="rank-provenance">
                  {Object.entries(detail.provenance).map(([key, value]) => (
                    <div key={key}>
                      <dt>{key}</dt>
                      <dd>{value ?? "—"}</dd>
                    </div>
                  ))}
                </dl>
              </details>
            </aside>
          </div>
        ) : null}
      </div>
    </dialog>
  );
}
