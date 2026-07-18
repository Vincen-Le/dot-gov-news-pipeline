begin;

create table public.news_entries (
    id uuid primary key default gen_random_uuid(),
    news_source_id uuid not null
        references public.news_sources(id) on delete cascade,
    url text not null,
    url_canonical text not null unique,
    title text,
    summary text,
    published_at timestamptz,
    fetched_at timestamptz not null default now(),
    content_hash text not null,
    embedding bytea,
    embedding_model text,
    enriched_text text,
    enricher_version integer,
    entity_set text[] not null default '{}'::text[],
    event_keys text[] not null default '{}'::text[],
    extractor_version integer,
    created_at timestamptz not null default now(),
    constraint news_entries_url_bounded
        check (length(url) between 1 and 2048),
    constraint news_entries_url_canonical_bounded
        check (length(url_canonical) between 1 and 2048),
    constraint news_entries_title_bounded
        check (title is null or length(title) <= 1024),
    constraint news_entries_summary_bounded
        check (summary is null or length(summary) <= 16384),
    constraint news_entries_content_hash_valid
        check (content_hash ~ '^[0-9a-f]{64}$'),
    constraint news_entries_embedding_bounded
        check (embedding is null or octet_length(embedding) between 2 and 4096),
    constraint news_entries_embedding_model_present
        check (embedding is null or embedding_model is not null),
    constraint news_entries_embedding_model_bounded
        check (embedding_model is null or length(embedding_model) <= 256),
    constraint news_entries_enriched_text_bounded
        check (enriched_text is null or length(enriched_text) <= 16384),
    constraint news_entries_enricher_version_valid
        check (enricher_version is null or enricher_version >= 1),
    constraint news_entries_entity_set_valid
        check (
            cardinality(entity_set) <= 64
            and array_position(entity_set, null) is null
        ),
    constraint news_entries_event_keys_valid
        check (
            cardinality(event_keys) <= 16
            and array_position(event_keys, null) is null
        ),
    constraint news_entries_extractor_version_valid
        check (extractor_version is null or extractor_version >= 1)
);

comment on table public.news_entries is
    'Normalized feed items; the atomic clustering unit. Dedupe keys, embedding, enrichment, and deterministic identity anchors live here.';
comment on column public.news_entries.content_hash is
    'sha256 hex of normalized(title)||normalized(summary); dedupe layer 2 and enrichment cache key.';
comment on column public.news_entries.embedding is
    'fp16 vector bytes; always computed from enriched_text when present, else raw title+summary. embedding_model records provenance.';
comment on column public.news_entries.entity_set is
    'Salient discriminator entities extracted from RAW title/summary only (never enriched text). Versioned by extractor_version.';
comment on column public.news_entries.event_keys is
    'Hard deterministic event identifiers (FR doc numbers, docket IDs, recall numbers, CVEs) from RAW text. Strongest attach tier.';

create index news_entries_content_hash_idx
    on public.news_entries (content_hash);
create index news_entries_published_at_idx
    on public.news_entries (published_at);
create index news_entries_fetched_at_idx
    on public.news_entries (fetched_at);
create index news_entries_source_idx
    on public.news_entries (news_source_id, fetched_at);
create index news_entries_entity_set_idx
    on public.news_entries using gin (entity_set);
create index news_entries_event_keys_idx
    on public.news_entries using gin (event_keys);

alter table public.news_entries enable row level security;

revoke all privileges on table public.news_entries
    from public, anon, authenticated, service_role;

grant select on table public.news_entries to service_role;

commit;
