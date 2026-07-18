-- supabase/migrations/20260718100200_create_experiment_runs.sql
begin;

create table public.experiment_runs (
    id uuid primary key default gen_random_uuid(),
    name text not null,
    started_at timestamptz not null,
    finished_at timestamptz not null,
    config jsonb,
    cluster_report jsonb,
    summary jsonb,
    cache_hits integer not null default 0,
    cache_misses integer not null default 0,
    created_at timestamptz not null default now(),
    constraint experiment_runs_name_bounded
        check (length(name) between 1 and 128),
    constraint experiment_runs_window_valid
        check (started_at <= finished_at),
    constraint experiment_runs_config_valid
        check (config is null or (
            jsonb_typeof(config) = 'object'
            and pg_catalog.pg_column_size(config) <= 16384)),
    constraint experiment_runs_cluster_report_valid
        check (cluster_report is null or (
            jsonb_typeof(cluster_report) = 'object'
            and pg_catalog.pg_column_size(cluster_report) <= 16384)),
    constraint experiment_runs_summary_valid
        check (summary is null or (
            jsonb_typeof(summary) = 'object'
            and pg_catalog.pg_column_size(summary) <= 65536)),
    constraint experiment_runs_cache_counts_nonnegative
        check (cache_hits >= 0 and cache_misses >= 0)
);

comment on table public.experiment_runs is
    'One row per clustering experiment run: resolved config snapshot, cluster report, and summary stats. Clustering tables hold the latest run''s actual clusters; this table is the run history the dashboard lists.';

create index experiment_runs_created_idx
    on public.experiment_runs (created_at desc);

alter table public.experiment_runs enable row level security;

revoke all privileges on table public.experiment_runs
    from public, anon, authenticated, service_role;

grant select on table public.experiment_runs to service_role;

commit;
