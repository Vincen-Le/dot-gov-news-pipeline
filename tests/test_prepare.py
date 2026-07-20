from datetime import datetime, timezone

import numpy as np

from pipeline.shared.config import Config
from pipeline.shared.extraction import EXTRACTOR_VERSION
from pipeline.runner import prepare

T0 = datetime(2026, 5, 14, 14, 0, tzinfo=timezone.utc)
CFG = Config(database_url="x", cf_account_id="a", cf_api_token="t")


class PrepFakeStore:
    def __init__(self, rows):
        self.rows = rows
        self.features: dict[str, dict] = {}
        self.seen_per_agency = "unset"
        self.seen_agencies = "unset"

    def entries_needing_features(self, limit=None, per_agency=None, agencies=None):
        self.seen_per_agency = per_agency
        self.seen_agencies = agencies
        return self.rows[:limit] if limit else self.rows

    def update_entry_features(self, entry_id, enriched_text, enricher_version,
                              embedding, embedding_model,
                              entity_set=None, event_keys=None, extractor_version=None):
        self.features[entry_id] = {
            "enriched_text": enriched_text, "embedding": embedding,
            "embedding_model": embedding_model, "entity_set": entity_set,
            "event_keys": event_keys, "extractor_version": extractor_version,
        }


class PrepModels:
    embedding_tag = "fake-embedder"

    def __init__(self, fail_enrich_for=()):
        self.embed_batches = []
        self.embed_texts = []
        self.enrich_inputs = []
        self.fail_enrich_for = fail_enrich_for

    def enrich(self, title, summary):
        self.enrich_inputs.append((title, summary))
        if title in self.fail_enrich_for:
            raise RuntimeError("enrich boom")
        return f"ENRICHED {title}"

    def embed(self, texts):
        self.embed_batches.append(len(texts))
        self.embed_texts.extend(texts)
        return [np.ones(4, dtype=np.float32) for _ in texts]


def row(i, **kw):
    return {"id": f"n{i}", "title": f"FDA Recalls Valsatrex Lot {i}",
            "summary": "Sundexo Pharmaceuticals recall.", "body_text": None,
            "published_at": T0,
            "enriched_text": None, "enricher_version": None,
            "entity_set": [], "event_keys": [], **kw}


def test_prepare_enriches_embeds_and_backfills_extraction():
    store = PrepFakeStore([row(1), row(2)])
    models = PrepModels()
    report = prepare(store, models, CFG, concurrency=2, embed_batch=96)
    assert report == {"prepared": 2, "failed": 0}
    feat = store.features["n1"]
    assert feat["enriched_text"].startswith("ENRICHED")
    assert feat["embedding"] is not None
    assert feat["embedding_model"] == "fake-embedder"  # the producing client's tag, never cfg
    assert "valsatrex" in feat["entity_set"]          # extraction backfilled from RAW text
    assert feat["extractor_version"] == EXTRACTOR_VERSION


def test_prepare_respects_existing_enrichment_and_anchors():
    store = PrepFakeStore([row(1, enriched_text="already enriched",
                               entity_set=["kept"], event_keys=["z-2026-1"])])
    models = PrepModels()
    prepare(store, models, CFG)
    feat = store.features["n1"]
    assert feat["enriched_text"] is None              # not re-enriched, not re-written
    assert feat["entity_set"] is None                 # anchors untouched when present
    assert feat["embedding"] is not None


def test_prepare_enrichment_disabled_embeds_raw():
    cfg = Config(database_url="x", cf_account_id="a", cf_api_token="t",
                 enrichment_enabled=False)
    store = PrepFakeStore([row(1)])
    models = PrepModels()
    prepare(store, models, cfg)
    assert store.features["n1"]["enriched_text"] is None


def test_prepare_prefers_human_feed_summary_over_article_body():
    # summary is a human-condensed event description: title+summary embeds
    # nearer related events than full body text (quotes/boilerplate noise)
    store = PrepFakeStore([row(1, summary="Short feed summary.",
                               body_text="Complete cleaned article report.")])
    models = PrepModels()
    prepare(store, models, CFG)
    assert models.enrich_inputs[0][1] == "Short feed summary."


def test_prepare_falls_back_to_body_when_no_summary():
    store = PrepFakeStore([row(1, summary=None,
                               body_text="Complete cleaned article report.")])
    models = PrepModels()
    prepare(store, models, CFG)
    assert models.enrich_inputs[0][1] == "Complete cleaned article report."


def test_prepare_enrich_failure_falls_back_to_raw_text():
    store = PrepFakeStore([row(1, title="BOOM"), row(2)])
    models = PrepModels(fail_enrich_for=("BOOM",))
    report = prepare(store, models, CFG)
    assert report == {"prepared": 2, "failed": 0}     # fallback, not failure
    assert store.features["BOOM" and "n1"]["embedding"] is not None


def test_prepare_records_stub_tag_not_config_model():
    """Regression: --stub prepare used to label 256-dim stub vectors with the
    real cfg.embedding_model, so a later real-model run crashed on a
    256-vs-1024 dim mismatch instead of failing loudly at prepare time."""
    from pipeline.shared.stub import StubModels

    store = PrepFakeStore([row(1)])
    prepare(store, StubModels(), CFG)
    feat = store.features["n1"]
    assert feat["embedding_model"] == StubModels.embedding_tag
    assert feat["embedding_model"] != CFG.embedding_model


def test_prepare_passes_per_agency_sampling_to_store():
    store = PrepFakeStore([row(1)])
    prepare(store, PrepModels(), CFG, per_agency=75)
    assert store.seen_per_agency == 75
    store2 = PrepFakeStore([row(1)])
    prepare(store2, PrepModels(), CFG)
    assert store2.seen_per_agency is None


def test_prepare_passes_curated_agency_filter_to_store():
    store = PrepFakeStore([row(1)])
    prepare(store, PrepModels(), CFG, agencies=["csb", "ntsb"])
    assert store.seen_agencies == ["csb", "ntsb"]


def test_prepare_batches_embeddings():
    store = PrepFakeStore([row(i) for i in range(10)])
    models = PrepModels()
    prepare(store, models, CFG, embed_batch=4)
    assert models.embed_batches == [4, 4, 2]


class StubStyleModels(PrepModels):
    """Mimics StubModels.enrich: title + '. ' + summary, no truncation."""

    def enrich(self, title, summary):
        return f"{title}. {summary or ''}"


def test_prepare_rejects_oversized_enrichment_as_regurgitation():
    # a real enrichment is 2-3 sentences; output past the validity ceiling
    # means the model echoed the article body — rejected, entry still
    # prepared via the raw-text fallback embed (clamped to the db bound)
    long_summary = "x" * 16380
    store = PrepFakeStore([row(1, summary=long_summary)])
    models = StubStyleModels()
    report = prepare(store, models, CFG)
    assert report == {"prepared": 1, "failed": 0}
    feat = store.features["n1"]
    assert feat["enriched_text"] is None
    assert len(models.embed_texts[0]) <= 16384


class PunctuationModels(PrepModels):
    def enrich(self, title, summary):
        return "!" * 256


def test_prepare_rejects_punctuation_only_enrichment_before_embedding():
    store = PrepFakeStore([row(1, enriched_text="!" * 256)])
    models = PunctuationModels()

    report = prepare(store, models, CFG)

    assert report == {"prepared": 1, "failed": 0}
    assert store.features["n1"]["enriched_text"] is None
    assert models.embed_texts == [
        "FDA Recalls Valsatrex Lot 1. Sundexo Pharmaceuticals recall."
    ]
