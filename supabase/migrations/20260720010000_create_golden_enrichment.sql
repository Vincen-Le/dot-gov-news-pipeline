begin;

-- Golden event-card rows are reconstructed and their UUIDs can therefore
-- disappear or churn. These serving artifacts deliberately retain the UUID
-- as their card-scoped identity without a foreign key back to the mirror.
create table public.golden_event_card_thumbnails (
    event_card_id uuid primary key,
    input_hash text not null,
    enrichment_version integer not null,
    source_card_version integer not null,
    source_entry_ids uuid[] not null,
    image_concept jsonb not null,
    r2_master_key text not null,
    r2_card_key text not null,
    r2_social_key text not null,
    master_sha256 text not null,
    card_sha256 text not null,
    social_sha256 text not null,
    master_mime_type text not null,
    card_mime_type text not null,
    social_mime_type text not null,
    master_width integer not null,
    master_height integer not null,
    card_width integer not null,
    card_height integer not null,
    social_width integer not null,
    social_height integer not null,
    alt_text text not null,
    focal_x numeric(6, 5) not null,
    focal_y numeric(6, 5) not null,
    model text not null,
    prompt_version integer not null,
    prompt_hash text not null,
    generated_at timestamptz not null,
    created_at timestamptz not null default now(),
    updated_at timestamptz not null default now(),
    constraint golden_event_card_thumbnails_input_hash_valid
        check (input_hash ~ '^[0-9a-f]{64}$'),
    constraint golden_event_card_thumbnails_versions_positive
        check (enrichment_version >= 1 and source_card_version >= 1 and prompt_version >= 1),
    constraint golden_event_card_thumbnails_sources_valid
        check (
            cardinality(source_entry_ids) between 1 and 256
            and array_position(source_entry_ids, null) is null
        ),
    constraint golden_event_card_thumbnails_concept_valid
        check (
            jsonb_typeof(image_concept) = 'object'
            and pg_catalog.pg_column_size(image_concept) <= 16384
        ),
    constraint golden_event_card_thumbnails_r2_keys_bounded
        check (
            length(r2_master_key) between 1 and 1024
            and length(r2_card_key) between 1 and 1024
            and length(r2_social_key) between 1 and 1024
        ),
    constraint golden_event_card_thumbnails_hashes_valid
        check (
            master_sha256 ~ '^[0-9a-f]{64}$'
            and card_sha256 ~ '^[0-9a-f]{64}$'
            and social_sha256 ~ '^[0-9a-f]{64}$'
            and prompt_hash ~ '^[0-9a-f]{64}$'
        ),
    constraint golden_event_card_thumbnails_mime_types_valid
        check (
            master_mime_type in ('image/avif', 'image/jpeg', 'image/png', 'image/webp')
            and card_mime_type in ('image/avif', 'image/jpeg', 'image/png', 'image/webp')
            and social_mime_type in ('image/avif', 'image/jpeg', 'image/png', 'image/webp')
        ),
    constraint golden_event_card_thumbnails_dimensions_valid
        check (
            master_width between 1 and 16384
            and master_height between 1 and 16384
            and card_width between 1 and 16384
            and card_height between 1 and 16384
            and social_width between 1 and 16384
            and social_height between 1 and 16384
        ),
    constraint golden_event_card_thumbnails_alt_bounded
        check (length(alt_text) between 1 and 512),
    constraint golden_event_card_thumbnails_focal_valid
        check (focal_x between 0 and 1 and focal_y between 0 and 1),
    constraint golden_event_card_thumbnails_model_bounded
        check (length(model) between 1 and 256),
    constraint golden_event_card_thumbnails_timestamps_ordered
        check (updated_at >= created_at)
);

comment on table public.golden_event_card_thumbnails is
    'Generated editorial thumbnails and R2 asset provenance for one golden event card. event_card_id intentionally has no foreign key because mirror reconstruction can delete or replace card rows.';
comment on column public.golden_event_card_thumbnails.input_hash is
    'sha256 of normalized reviewed inputs; indexed for idempotency checks even though event_card_id is the serving identity.';
comment on column public.golden_event_card_thumbnails.image_concept is
    'Bounded source-grounded illustration concept used to build the final image prompt.';

create index golden_event_card_thumbnails_input_idx
    on public.golden_event_card_thumbnails (input_hash, enrichment_version);

create table public.golden_event_card_article_overviews (
    event_card_id uuid primary key,
    input_hash text not null,
    enrichment_version integer not null,
    source_card_version integer not null,
    source_entry_ids uuid[] not null,
    source_content_hashes text[] not null,
    article_overview jsonb not null,
    model text not null,
    prompt_version integer not null,
    prompt_hash text not null,
    generated_at timestamptz not null,
    created_at timestamptz not null default now(),
    updated_at timestamptz not null default now(),
    constraint golden_event_card_article_overviews_input_hash_valid
        check (input_hash ~ '^[0-9a-f]{64}$'),
    constraint golden_event_card_article_overviews_versions_positive
        check (enrichment_version >= 1 and source_card_version >= 1 and prompt_version >= 1),
    constraint golden_event_card_article_overviews_sources_valid
        check (
            cardinality(source_entry_ids) between 1 and 256
            and cardinality(source_content_hashes) = cardinality(source_entry_ids)
            and array_position(source_entry_ids, null) is null
            and array_position(source_content_hashes, null) is null
            and array_to_string(source_content_hashes, ',')
                ~ '^([0-9a-f]{64})(,[0-9a-f]{64})*$'
        ),
    constraint golden_event_card_article_overviews_payload_valid
        check (
            jsonb_typeof(article_overview) = 'object'
            and pg_catalog.pg_column_size(article_overview) <= 65536
        ),
    constraint golden_event_card_article_overviews_model_bounded
        check (length(model) between 1 and 256),
    constraint golden_event_card_article_overviews_prompt_hash_valid
        check (prompt_hash ~ '^[0-9a-f]{64}$'),
    constraint golden_event_card_article_overviews_timestamps_ordered
        check (updated_at >= created_at)
);

comment on table public.golden_event_card_article_overviews is
    'Structured source-grounded article synthesis for one golden event card. event_card_id intentionally has no foreign key so hosted artifacts survive mirror-card deletion and churn.';
comment on column public.golden_event_card_article_overviews.input_hash is
    'sha256 of the ordered source IDs, source content hashes, card cutoff, and prompt inputs; indexed for idempotent backfill lookup.';
comment on column public.golden_event_card_article_overviews.source_content_hashes is
    'Content hashes positionally aligned with source_entry_ids, preserving the exact reviewed source versions used by this synthesis.';
comment on column public.golden_event_card_article_overviews.article_overview is
    'Bounded aggregate payload containing the sourced lead, key details, changes, and optional unresolved items.';

create index golden_event_card_article_overviews_input_idx
    on public.golden_event_card_article_overviews (input_hash, enrichment_version);

alter table public.golden_event_card_thumbnails enable row level security;
alter table public.golden_event_card_article_overviews enable row level security;

revoke all privileges on table
    public.golden_event_card_thumbnails,
    public.golden_event_card_article_overviews
    from public, anon, authenticated, service_role;
grant select, insert, update on table
    public.golden_event_card_thumbnails,
    public.golden_event_card_article_overviews
    to service_role;

commit;
