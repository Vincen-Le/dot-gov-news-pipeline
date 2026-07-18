begin;

create table public.rubric_weights (
    rubric_version integer not null,
    criterion text not null,
    weight real not null,
    updated_at timestamptz not null default now(),
    primary key (rubric_version, criterion),
    constraint rubric_weights_version_valid
        check (rubric_version >= 1),
    constraint rubric_weights_criterion_bounded
        check (length(criterion) between 1 and 128)
);

comment on table public.rubric_weights is
    'Ranking dials. Judge-produced rubric bits are facts on cards; weights live here so retuning is one UPDATE recomputing rank_key from stored bits — zero LLM re-calls. Changing criteria bumps rubric_version.';

alter table public.rubric_weights enable row level security;

revoke all privileges on table public.rubric_weights
    from public, anon, authenticated, service_role;

grant select on table public.rubric_weights to service_role;

commit;
