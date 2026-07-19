begin;

create table public.rank_snapshots (
    run_id uuid not null references public.experiment_runs(id) on delete cascade,
    facet_type text not null,
    facet_key text not null default '',
    position integer not null,
    storyline_id uuid not null,
    card_id uuid not null,
    rank_key float8 not null,
    terms jsonb not null,
    judged boolean not null,
    headline text,
    summary text,
    rubric jsonb,
    interest_reason text,
    agencies integer not null default 0,
    feeds integer not null default 0,
    entry_count integer not null default 0,
    newest_entry_at timestamptz,
    created_at timestamptz not null default now(),
    primary key (run_id, facet_type, facet_key, position),
    constraint rank_snapshots_facet_type_valid
        check (facet_type in ('global', 'category', 'theme', 'agency')),
    constraint rank_snapshots_facet_key_bounded check (length(facet_key) <= 128),
    constraint rank_snapshots_position_positive check (position >= 1),
    constraint rank_snapshots_headline_bounded
        check (headline is null or length(headline) <= 512),
    constraint rank_snapshots_summary_bounded
        check (summary is null or length(summary) <= 8192),
    constraint rank_snapshots_reason_bounded
        check (interest_reason is null or length(interest_reason) <= 2048),
    constraint rank_snapshots_counts_nonnegative
        check (agencies >= 0 and feeds >= 0 and entry_count >= 0)
);

comment on table public.rank_snapshots is
    'Per-run, per-facet frozen ranking with term decomposition. storyline_id/card_id deliberately have no FK: experiment resets wipe the clustering tables, and old runs'' snapshots must render standalone (hence the denormalized display fields).';

create index rank_snapshots_storyline_idx on public.rank_snapshots (run_id, storyline_id);

create table public.rank_audit_pairs (
    id uuid primary key default gen_random_uuid(),
    run_id uuid not null references public.experiment_runs(id) on delete cascade,
    facet_type text not null,
    facet_key text not null default '',
    position_a integer not null,
    position_b integer not null,
    storyline_a uuid not null,
    storyline_b uuid not null,
    formula_prefers text not null default 'a',
    llm_prefers text not null,
    llm_reason text,
    judge_model text,
    prompt_version integer,
    sampled_at timestamptz not null default now(),
    constraint rank_audit_pairs_formula_valid check (formula_prefers = 'a'),
    constraint rank_audit_pairs_llm_valid check (llm_prefers in ('a', 'b', 'inconsistent')),
    constraint rank_audit_pairs_order_valid check (position_a < position_b),
    constraint rank_audit_pairs_reason_bounded
        check (llm_reason is null or length(llm_reason) <= 2048),
    constraint rank_audit_pairs_unique unique (run_id, facet_type, facet_key, position_a, position_b)
);

comment on table public.rank_audit_pairs is
    'Read-only LLM rank audit verdicts over neighboring snapshot rows. a = the side the formula ranked higher, so llm_prefers = ''b'' is a disagreement. Never feeds back into rank_key; consumed by metrics and weight fitting.';

create table public.rank_audit_runs (
    id uuid primary key default gen_random_uuid(),
    run_id uuid not null references public.experiment_runs(id) on delete cascade,
    config jsonb,
    metrics jsonb,
    created_at timestamptz not null default now(),
    constraint rank_audit_runs_config_valid
        check (config is null or (jsonb_typeof(config) = 'object'
            and pg_catalog.pg_column_size(config) <= 16384)),
    constraint rank_audit_runs_metrics_valid
        check (metrics is null or (jsonb_typeof(metrics) = 'object'
            and pg_catalog.pg_column_size(metrics) <= 65536))
);

comment on table public.rank_audit_runs is
    'One row per rank-audit invocation: audit config snapshot and aggregate metrics (agreement rate, inconsistency rate, disagreement term attribution).';

alter table public.rank_snapshots enable row level security;
alter table public.rank_audit_pairs enable row level security;
alter table public.rank_audit_runs enable row level security;

revoke all privileges on table public.rank_snapshots from public, anon, authenticated, service_role;
revoke all privileges on table public.rank_audit_pairs from public, anon, authenticated, service_role;
revoke all privileges on table public.rank_audit_runs from public, anon, authenticated, service_role;

grant select on table public.rank_snapshots to service_role;
grant select on table public.rank_audit_pairs to service_role;
grant select on table public.rank_audit_runs to service_role;

commit;
