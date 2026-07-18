begin;

create table public.entity_stats (
    entity text primary key,
    first_seen_at timestamptz not null default now(),
    last_seen_at timestamptz not null default now(),
    total_count integer not null default 1,
    daily_ema real not null default 0,
    ema_updated_at timestamptz not null default now(),
    constraint entity_stats_entity_bounded
        check (length(entity) between 1 and 256),
    constraint entity_stats_total_count_positive
        check (total_count >= 1),
    constraint entity_stats_daily_ema_nonnegative
        check (daily_ema >= 0),
    constraint entity_stats_seen_window_valid
        check (first_seen_at <= last_seen_at)
);

comment on table public.entity_stats is
    'Per-entity running stats. first_seen_at = novelty signal; daily_ema = ambient-entity (promiscuity) signal, decayed lazily on touch using ema_updated_at.';
comment on column public.entity_stats.daily_ema is
    'Exponential moving average of daily mention count. Updated on ingest: decay by elapsed days since ema_updated_at, then increment. No sweep jobs.';

alter table public.entity_stats enable row level security;

revoke all privileges on table public.entity_stats
    from public, anon, authenticated, service_role;

grant select on table public.entity_stats to service_role;

commit;
