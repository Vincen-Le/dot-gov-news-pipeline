begin;

create table public.event_cards (
    id uuid primary key default gen_random_uuid(),
    storyline_id uuid not null references public.storylines(id),
    episode_id uuid references public.episodes(id),
    kind text not null,
    version integer not null,
    headline text not null,
    summary text not null,
    timeline jsonb,
    rubric jsonb,
    rubric_version integer,
    interest_reason text,
    og jsonb,
    representative_entry_id uuid references public.news_entries(id),
    newest_entry_at timestamptz not null,
    rank_key float8 not null,
    superseded_by uuid references public.event_cards(id),
    judge_model text,
    prompt_version integer,
    generated_at timestamptz not null default now(),
    constraint event_cards_kind_valid
        check (kind in ('overview', 'episode')),
    constraint event_cards_kind_episode_consistent
        check (
            (kind = 'overview' and episode_id is null)
            or (kind = 'episode' and episode_id is not null)
        ),
    constraint event_cards_version_valid
        check (version >= 1),
    constraint event_cards_headline_bounded
        check (length(headline) between 1 and 512),
    constraint event_cards_summary_bounded
        check (length(summary) between 1 and 8192),
    constraint event_cards_timeline_valid
        check (
            timeline is null
            or (
                jsonb_typeof(timeline) = 'array'
                and pg_catalog.pg_column_size(timeline) <= 32768
            )
        ),
    constraint event_cards_rubric_valid
        check (
            rubric is null
            or (
                jsonb_typeof(rubric) = 'object'
                and pg_catalog.pg_column_size(rubric) <= 8192
            )
        ),
    constraint event_cards_rubric_version_valid
        check (rubric_version is null or rubric_version >= 1),
    constraint event_cards_interest_reason_bounded
        check (interest_reason is null or length(interest_reason) <= 2048),
    constraint event_cards_og_valid
        check (
            og is null
            or (
                jsonb_typeof(og) = 'object'
                and pg_catalog.pg_column_size(og) <= 8192
            )
        ),
    constraint event_cards_judge_model_bounded
        check (judge_model is null or length(judge_model) <= 256),
    constraint event_cards_prompt_version_valid
        check (prompt_version is null or prompt_version >= 1)
);

comment on table public.event_cards is
    'Write-once serving surface. Overview cards compress the chain-so-far and are superseded on regeneration; episode cards are immutable 1:1 with episodes. rank_key is computed exactly once at birth — rank refresh happens by supersession, never UPDATE.';
comment on column public.event_cards.superseded_by is
    'Newer overview card that replaced this one. Serving filters on IS NULL.';

create index event_cards_serving_idx
    on public.event_cards (rank_key desc)
    where superseded_by is null;
create index event_cards_storyline_version_idx
    on public.event_cards (storyline_id, version);
create unique index event_cards_episode_unique_idx
    on public.event_cards (episode_id)
    where episode_id is not null;

alter table public.storylines
    add constraint storylines_latest_card_fk
        foreign key (latest_card_id) references public.event_cards(id);

alter table public.event_cards enable row level security;

revoke all privileges on table public.event_cards
    from public, anon, authenticated, service_role;

grant select on table public.event_cards to service_role;

commit;
