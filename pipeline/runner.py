"""Two-phase runner.

prepare: per-entry features (enrich concurrent, embed batched, extraction
backfill) persisted once — the expensive, experiment-invariant half.
cluster (Task 4): event-time replay over cached features — the cheap half
experiments iterate on.
"""

from __future__ import annotations

from concurrent.futures import ThreadPoolExecutor

from pipeline.config import Config
from pipeline.extraction import EXTRACTOR_VERSION, extract
from pipeline.vectors import pack_fp16


def _fallback_text(row: dict) -> str:
    return f"{row['title']}. {row.get('summary') or ''}".strip()


def prepare(store, models, cfg: Config, limit: int | None = None,
            concurrency: int = 8, embed_batch: int = 96) -> dict:
    rows = store.entries_needing_features(limit)
    if not rows:
        return {"prepared": 0, "failed": 0}

    # enrichment (concurrent; DB column is the cache — skip rows that have it)
    def enrich_one(row: dict) -> str | None:
        if not cfg.enrichment_enabled or row.get("enriched_text"):
            return None
        try:
            return models.enrich(row["title"], row.get("summary"))
        except Exception:
            return None  # fall back to raw text; never block the batch

    with ThreadPoolExecutor(max_workers=concurrency) as pool:
        new_enrichments = list(pool.map(enrich_one, rows))

    embed_texts = [
        new or row.get("enriched_text") or _fallback_text(row)
        for row, new in zip(rows, new_enrichments)
    ]

    prepared = failed = 0
    for start in range(0, len(rows), embed_batch):
        chunk = list(zip(rows[start:start + embed_batch],
                         new_enrichments[start:start + embed_batch],
                         embed_texts[start:start + embed_batch]))
        try:
            vectors = models.embed([text for _, _, text in chunk])
        except Exception:
            failed += len(chunk)
            continue
        for (row, new_enrichment, _), vec in zip(chunk, vectors):
            needs_anchors = not row["entity_set"] and not row["event_keys"]
            entities, keys = extract(row["title"], row.get("summary")) if needs_anchors else (None, None)
            store.update_entry_features(
                row["id"],
                new_enrichment,
                cfg.enricher_version if new_enrichment else None,
                pack_fp16(vec), cfg.embedding_model,
                entity_set=entities, event_keys=keys,
                extractor_version=EXTRACTOR_VERSION if needs_anchors else None)
            prepared += 1
    return {"prepared": prepared, "failed": failed}
