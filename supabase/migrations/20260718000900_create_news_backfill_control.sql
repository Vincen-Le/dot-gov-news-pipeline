begin;

alter table public.news_entries
    drop constraint news_entries_news_source_id_fkey,
    add constraint news_entries_news_source_id_fkey
        foreign key (news_source_id)
        references public.news_sources(id)
        on delete restrict;

create table public.news_backfill_runs (
    id uuid primary key default gen_random_uuid(),
    run_key text not null unique,
    cohort_id text not null,
    manifest_sha256 text not null,
    window_start timestamptz not null,
    window_end timestamptz not null,
    status text not null default 'pending',
    counters jsonb not null default '{}'::jsonb,
    started_at timestamptz not null default now(),
    completed_at timestamptz,
    created_at timestamptz not null default now(),
    updated_at timestamptz not null default now(),
    constraint news_backfill_runs_run_key_bounded
        check (length(run_key) between 1 and 256),
    constraint news_backfill_runs_cohort_id_bounded
        check (length(cohort_id) between 1 and 128),
    constraint news_backfill_runs_manifest_sha256_valid
        check (manifest_sha256 ~ '^[0-9a-f]{64}$'),
    constraint news_backfill_runs_window_valid
        check (window_start < window_end),
    constraint news_backfill_runs_status_valid
        check (status in (
            'pending', 'running', 'succeeded', 'partial', 'failed', 'cancelled'
        )),
    constraint news_backfill_runs_counters_valid
        check (
            jsonb_typeof(counters) = 'object'
            and pg_catalog.pg_column_size(counters) <= 32768
        ),
    constraint news_backfill_runs_completion_consistent
        check (
            (status in ('succeeded', 'partial', 'failed', 'cancelled')
                and completed_at is not null)
            or (status in ('pending', 'running') and completed_at is null)
        )
);

comment on table public.news_backfill_runs is
    'Immutable historical collection envelopes identified by a cohort manifest and fixed event-time window.';

create table public.news_backfill_targets (
    id uuid primary key default gen_random_uuid(),
    run_id uuid not null
        references public.news_backfill_runs(id) on delete cascade,
    publisher_key text not null,
    source_key text not null,
    news_source_id uuid not null
        references public.news_sources(id) on delete restrict,
    adapter text not null,
    status text not null default 'pending',
    cursor jsonb not null default '{}'::jsonb,
    candidates_seen integer not null default 0,
    inserted_count integer not null default 0,
    existing_count integer not null default 0,
    rejected_count integer not null default 0,
    conflict_count integer not null default 0,
    oldest_published_at timestamptz,
    newest_published_at timestamptz,
    coverage_reached_at timestamptz,
    stop_reason text,
    coverage_evidence_artifact_key text,
    last_error_code text,
    last_error_detail text,
    started_at timestamptz,
    completed_at timestamptz,
    created_at timestamptz not null default now(),
    updated_at timestamptz not null default now(),
    unique (run_id, publisher_key, source_key),
    constraint news_backfill_targets_publisher_key_bounded
        check (length(publisher_key) between 1 and 128),
    constraint news_backfill_targets_source_key_bounded
        check (length(source_key) between 1 and 128),
    constraint news_backfill_targets_adapter_valid
        check (adapter in (
            'syndication', 'wordpress', 'publisher_api', 'sitemap', 'html_archive'
        )),
    constraint news_backfill_targets_status_valid
        check (status in (
            'pending', 'running', 'succeeded', 'partial', 'failed', 'cancelled'
        )),
    constraint news_backfill_targets_cursor_valid
        check (
            jsonb_typeof(cursor) = 'object'
            and pg_catalog.pg_column_size(cursor) <= 32768
        ),
    constraint news_backfill_targets_counts_nonnegative
        check (
            candidates_seen >= 0
            and inserted_count >= 0
            and existing_count >= 0
            and rejected_count >= 0
            and conflict_count >= 0
        ),
    constraint news_backfill_targets_observation_window_valid
        check (
            oldest_published_at is null
            or newest_published_at is null
            or oldest_published_at <= newest_published_at
        ),
    constraint news_backfill_targets_stop_reason_bounded
        check (stop_reason is null or length(stop_reason) between 1 and 128),
    constraint news_backfill_targets_evidence_key_bounded
        check (
            coverage_evidence_artifact_key is null
            or length(coverage_evidence_artifact_key) between 1 and 2048
        ),
    constraint news_backfill_targets_error_code_bounded
        check (last_error_code is null or length(last_error_code) between 1 and 128),
    constraint news_backfill_targets_error_detail_bounded
        check (last_error_detail is null or length(last_error_detail) <= 4096),
    constraint news_backfill_targets_completion_consistent
        check (
            (status in ('succeeded', 'partial', 'failed', 'cancelled')
                and completed_at is not null)
            or (status in ('pending', 'running') and completed_at is null)
        )
);

comment on table public.news_backfill_targets is
    'Resumable per-publisher acquisition targets for a historical news backfill run.';
comment on column public.news_backfill_targets.coverage_reached_at is
    'Oldest event-time boundary the adapter proved it traversed; not merely the oldest accepted item.';

create table public.news_entry_origins (
    news_entry_id uuid not null
        references public.news_entries(id) on delete cascade,
    news_source_id uuid not null
        references public.news_sources(id) on delete restrict,
    external_item_id text,
    news_subtype text not null,
    first_observed_at timestamptz not null default now(),
    last_observed_at timestamptz not null default now(),
    primary key (news_entry_id, news_source_id),
    constraint news_entry_origins_external_id_bounded
        check (
            external_item_id is null
            or length(external_item_id) between 1 and 2048
        ),
    constraint news_entry_origins_subtype_valid
        check (news_subtype in (
            'press_release', 'agency_news', 'advisory', 'release'
        )),
    constraint news_entry_origins_observation_order_valid
        check (first_observed_at <= last_observed_at)
);

comment on table public.news_entry_origins is
    'Persistent many-source provenance and publisher item identity for canonical news entries.';

create unique index news_entry_origins_source_external_id_idx
    on public.news_entry_origins (news_source_id, external_item_id)
    where external_item_id is not null;

create table public.news_backfill_run_entries (
    target_id uuid not null
        references public.news_backfill_targets(id) on delete cascade,
    candidate_key text not null,
    news_entry_id uuid not null
        references public.news_entries(id) on delete restrict,
    disposition text not null,
    raw_artifact_key text not null,
    extractor_version integer not null,
    observed_at timestamptz not null default now(),
    primary key (target_id, candidate_key),
    constraint news_backfill_run_entries_candidate_key_valid
        check (candidate_key ~ '^[0-9a-f]{64}$'),
    constraint news_backfill_run_entries_disposition_valid
        check (disposition in (
            'inserted', 'existing_url', 'existing_external_id'
        )),
    constraint news_backfill_run_entries_artifact_key_bounded
        check (length(raw_artifact_key) between 1 and 2048),
    constraint news_backfill_run_entries_extractor_version_valid
        check (extractor_version >= 1)
);

comment on table public.news_backfill_run_entries is
    'Exact accepted corpus membership and original ingest disposition for an immutable backfill candidate.';

create index news_backfill_run_entries_entry_idx
    on public.news_backfill_run_entries (news_entry_id, target_id);

create table public.news_backfill_candidate_outcomes (
    target_id uuid not null
        references public.news_backfill_targets(id) on delete cascade,
    candidate_key text not null,
    disposition text not null,
    news_entry_id uuid
        references public.news_entries(id) on delete restrict,
    error_code text,
    raw_artifact_key text not null,
    created_at timestamptz not null default now(),
    primary key (target_id, candidate_key),
    constraint news_backfill_candidate_outcomes_candidate_key_valid
        check (candidate_key ~ '^[0-9a-f]{64}$'),
    constraint news_backfill_candidate_outcomes_disposition_valid
        check (disposition in (
            'inserted', 'existing_url', 'existing_external_id',
            'identity_conflict', 'rejected'
        )),
    constraint news_backfill_candidate_outcomes_error_code_bounded
        check (error_code is null or length(error_code) between 1 and 128),
    constraint news_backfill_candidate_outcomes_artifact_key_bounded
        check (length(raw_artifact_key) between 1 and 2048),
    constraint news_backfill_candidate_outcomes_entry_consistent
        check (
            (disposition in ('inserted', 'existing_url', 'existing_external_id')
                and news_entry_id is not null and error_code is null)
            or (disposition in ('identity_conflict', 'rejected')
                and news_entry_id is null and error_code is not null)
        )
);

comment on table public.news_backfill_candidate_outcomes is
    'Idempotent terminal ledger for every enumerated historical-news candidate.';

create table public.news_backfill_identity_conflicts (
    target_id uuid not null
        references public.news_backfill_targets(id) on delete cascade,
    candidate_key text not null,
    url_news_entry_id uuid not null
        references public.news_entries(id) on delete restrict,
    external_news_entry_id uuid not null
        references public.news_entries(id) on delete restrict,
    raw_artifact_key text not null,
    created_at timestamptz not null default now(),
    resolved_at timestamptz,
    resolution text,
    primary key (target_id, candidate_key),
    constraint news_backfill_identity_conflicts_candidate_key_valid
        check (candidate_key ~ '^[0-9a-f]{64}$'),
    constraint news_backfill_identity_conflicts_distinct_entries
        check (url_news_entry_id <> external_news_entry_id),
    constraint news_backfill_identity_conflicts_artifact_key_bounded
        check (length(raw_artifact_key) between 1 and 2048),
    constraint news_backfill_identity_conflicts_resolution_bounded
        check (resolution is null or length(resolution) between 1 and 4096),
    constraint news_backfill_identity_conflicts_resolution_consistent
        check (
            (resolved_at is null and resolution is null)
            or (resolved_at is not null and resolution is not null)
        )
);

comment on table public.news_backfill_identity_conflicts is
    'Quarantine for canonical-URL and publisher-item identities that resolve to different entries.';

create index news_backfill_targets_run_status_idx
    on public.news_backfill_targets (run_id, status, updated_at);
create index news_backfill_targets_source_idx
    on public.news_backfill_targets (news_source_id, run_id);

alter table public.news_backfill_runs enable row level security;
alter table public.news_backfill_targets enable row level security;
alter table public.news_entry_origins enable row level security;
alter table public.news_backfill_run_entries enable row level security;
alter table public.news_backfill_candidate_outcomes enable row level security;
alter table public.news_backfill_identity_conflicts enable row level security;

revoke all privileges on table public.news_backfill_runs,
    public.news_backfill_targets,
    public.news_entry_origins,
    public.news_backfill_run_entries,
    public.news_backfill_candidate_outcomes,
    public.news_backfill_identity_conflicts
    from public, anon, authenticated, service_role;

grant select on table public.news_backfill_runs,
    public.news_backfill_targets,
    public.news_entry_origins,
    public.news_backfill_run_entries,
    public.news_backfill_candidate_outcomes,
    public.news_backfill_identity_conflicts
    to service_role;

commit;
