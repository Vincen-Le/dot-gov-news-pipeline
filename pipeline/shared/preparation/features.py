"""Prepare semantic text, embeddings, and deterministic extraction anchors.

This package is the stable seam between raw corpus entries and every
clustering algorithm. Preparation is persisted once because it is expensive
and invariant across replay experiments.
"""

from __future__ import annotations

from concurrent.futures import ThreadPoolExecutor

from pipeline.shared.config import Config
from pipeline.shared.extraction import EXTRACTOR_VERSION, extract
from pipeline.shared.vectors import pack_fp16

# DB constraint news_entries_enriched_text_bounded caps enriched_text here.
_MAX_ENRICHED_LEN = 16384

# A real enrichment is 2-3 dense sentences; longer output means the model
# regurgitated the article body instead of condensing it.
_MAX_VALID_ENRICHMENT = 600
_BOILERPLATE_MARKERS = (
    "contact us", "site index", "stay connected", "subscribe |",
    "mailing address:", "park footer", "last updated:", "what is rss",
)


def valid_enrichment(text: str | None) -> bool:
    """Reject non-semantic model output before it poisons vector space."""
    if not text:
        return False
    words = [token for token in text.split() if any(ch.isalnum() for ch in token)]
    alphanumeric = sum(ch.isalnum() for ch in text)
    if not words or alphanumeric < 8:
        return False
    if len(text) > _MAX_VALID_ENRICHMENT:
        return False
    lowered = text.lower()
    return not any(marker in lowered for marker in _BOILERPLATE_MARKERS)


def _semantic_content(row: dict) -> str | None:
    # Summary first: it is a human-condensed description of the event, so
    # title+summary embeds nearer related events than full article body,
    # which drowns the signal in quotes and boilerplate. Scraped body text
    # is capped: the event is in the lede, the tail is page chrome.
    body = row.get("body_text")
    return row.get("summary") or (body[:4000] if body else None)


def _fallback_text(row: dict) -> str:
    return f"{row['title']}. {_semantic_content(row) or ''}".strip()[:_MAX_ENRICHED_LEN]


def prepare(store, models, cfg: Config, limit: int | None = None,
            concurrency: int = 8, embed_batch: int = 96,
            per_agency: int | None = None,
            agencies: list[str] | None = None) -> dict:
    rows = store.entries_needing_features(
        limit, per_agency=per_agency, agencies=agencies)
    if not rows:
        return {"prepared": 0, "failed": 0}

    # Enrichment is concurrent; the DB column is the cache, so valid existing
    # enrichments are skipped.
    def enrich_one(row: dict) -> str | None:
        if not cfg.enrichment_enabled or valid_enrichment(row.get("enriched_text")):
            return None
        try:
            enriched = models.enrich(
                row["title"], _semantic_content(row))[:_MAX_ENRICHED_LEN]
            return enriched if valid_enrichment(enriched) else None
        except Exception:
            return None  # fall back to raw text; never block the batch

    with ThreadPoolExecutor(max_workers=concurrency) as pool:
        new_enrichments = list(pool.map(enrich_one, rows))

    embed_texts = [
        new or (row.get("enriched_text")
                if valid_enrichment(row.get("enriched_text")) else None)
        or _fallback_text(row)
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
            entities, keys = (extract(row["title"], row.get("summary"),
                                      row.get("body_text"))
                              if needs_anchors else (None, None))
            store.update_entry_features(
                row["id"],
                new_enrichment,
                cfg.enricher_version if new_enrichment else None,
                pack_fp16(vec), models.embedding_tag,
                entity_set=entities, event_keys=keys,
                extractor_version=EXTRACTOR_VERSION if needs_anchors else None)
            prepared += 1
    return {"prepared": prepared, "failed": failed}
