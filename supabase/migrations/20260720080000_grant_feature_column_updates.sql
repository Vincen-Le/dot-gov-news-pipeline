-- Allow the corpus-features mirror (scripts/eval/mirror_corpus_features_hosted.mjs)
-- to patch locally computed feature columns onto hosted news_entries so the
-- hosted corpus stays a complete restore source. Column-scoped: service_role
-- gains UPDATE on the derived-feature columns only — ingest-owned content
-- (title, url, summary, body, published_at, ...) stays locked down.
begin;

grant update (embedding, embedding_model, enriched_text, enricher_version,
              entity_set, event_keys, extractor_version)
    on table public.news_entries to service_role;

commit;
