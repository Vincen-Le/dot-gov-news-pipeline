begin;

create table public.storylines (
    id uuid primary key default gen_random_uuid(),
    entity_set text[] not null default '{}'::text[],
    event_keys text[] not null default '{}'::text[],
    centroid bytea,
    topic text,
    cluster_topic text,
    agency_ids text[] not null default '{}'::text[],
    distinct_feeds integer not null default 0,
    entry_count integer not null default 0,
    episode_count integer not null default 0,
    source_weight_max real not null default 1.0,
    first_entry_at timestamptz not null,
    newest_entry_at timestamptz not null,
    latest_card_id uuid,
    merged_into uuid references public.storylines(id),
    created_at timestamptz not null default now(),
    constraint storylines_entity_set_valid
        check (
            cardinality(entity_set) <= 256
            and array_position(entity_set, null) is null
        ),
    constraint storylines_event_keys_valid
        check (
            cardinality(event_keys) <= 64
            and array_position(event_keys, null) is null
        ),
    constraint storylines_centroid_bounded
        check (centroid is null or octet_length(centroid) between 2 and 4096),
    constraint storylines_topic_bounded
        check (topic is null or length(topic) <= 128),
    constraint storylines_cluster_topic_bounded
        check (cluster_topic is null or length(cluster_topic) <= 256),
    constraint storylines_agency_ids_valid
        check (
            cardinality(agency_ids) <= 128
            and array_position(agency_ids, null) is null
        ),
    constraint storylines_counts_nonnegative
        check (
            distinct_feeds >= 0
            and entry_count >= 0
            and episode_count >= 0
        ),
    constraint storylines_source_weight_valid
        check (source_weight_max >= 0),
    constraint storylines_entry_window_valid
        check (first_entry_at <= newest_entry_at)
);

comment on table public.storylines is
    'Unbounded chains of episodes about one historical event. Candidate generation via entity/event-key GIN indexes — no scan ever depends on corpus age.';
comment on column public.storylines.entity_set is
    'Union of member episodes'' salient discriminators; the identity anchor and candidate index.';
comment on column public.storylines.event_keys is
    'Union of member episodes'' hard event identifiers; strongest storyline-attach tier.';
comment on column public.storylines.latest_card_id is
    'Current overview event_cards row. FK added in the event_cards migration (circular reference).';
comment on column public.storylines.merged_into is
    'Set by nightly consolidation; excluded from serving, permalink 301s to the winner.';

create index storylines_entity_set_idx
    on public.storylines using gin (entity_set);
create index storylines_event_keys_idx
    on public.storylines using gin (event_keys);
create index storylines_newest_entry_idx
    on public.storylines (newest_entry_at);

create table public.episodes (
    id uuid primary key default gen_random_uuid(),
    storyline_id uuid not null references public.storylines(id),
    status text not null default 'open',
    centroid bytea,
    entity_set text[] not null default '{}'::text[],
    event_keys text[] not null default '{}'::text[],
    entry_count integer not null default 0,
    first_entry_at timestamptz not null,
    newest_entry_at timestamptz not null,
    attach_method text not null,
    attach_similarity real,
    attach_reason text,
    adjudicator_model text,
    created_at timestamptz not null default now(),
    constraint episodes_status_valid
        check (status in ('open', 'dormant')),
    constraint episodes_centroid_bounded
        check (centroid is null or octet_length(centroid) between 2 and 4096),
    constraint episodes_entity_set_valid
        check (
            cardinality(entity_set) <= 128
            and array_position(entity_set, null) is null
        ),
    constraint episodes_event_keys_valid
        check (
            cardinality(event_keys) <= 32
            and array_position(event_keys, null) is null
        ),
    constraint episodes_entry_count_nonnegative
        check (entry_count >= 0),
    constraint episodes_entry_window_valid
        check (first_entry_at <= newest_entry_at),
    constraint episodes_attach_method_valid
        check (attach_method in (
            'event_key',
            'entity_candidate',
            'adjudicated_join',
            'new_storyline',
            'consolidation_merge'
        )),
    constraint episodes_attach_similarity_valid
        check (
            attach_similarity is null
            or (attach_similarity >= -1.0 and attach_similarity <= 1.0)
        ),
    constraint episodes_attach_reason_bounded
        check (attach_reason is null or length(attach_reason) <= 2048),
    constraint episodes_adjudicator_model_bounded
        check (adjudicator_model is null or length(adjudicator_model) <= 256)
);

comment on table public.episodes is
    'One development pulse: tight cluster from the v1 pipeline, closes after 4 h rolling quiet (EPISODE_DORMANCY). attach_* columns audit the episode-to-storyline decision.';

create index episodes_storyline_idx
    on public.episodes (storyline_id);
create index episodes_open_idx
    on public.episodes (newest_entry_at)
    where status = 'open';

create table public.episode_entries (
    episode_id uuid not null references public.episodes(id),
    entry_id uuid not null references public.news_entries(id),
    is_syndicated boolean not null default false,
    attach_method text not null,
    similarity real,
    matched_entry_id uuid references public.news_entries(id),
    threshold_used real,
    embedding_model text,
    attached_at timestamptz not null default now(),
    primary key (episode_id, entry_id),
    constraint episode_entries_attach_method_valid
        check (attach_method in (
            'exact_url',
            'content_hash',
            'near_dup',
            'event_key',
            'centroid_join',
            'entity_community',
            'adjudicated_join',
            'adjudicated_new',
            'new_cluster',
            'consolidation_merge',
            'consolidation_split'
        )),
    constraint episode_entries_similarity_valid
        check (similarity is null or (similarity >= -1.0 and similarity <= 1.0)),
    constraint episode_entries_threshold_valid
        check (threshold_used is null or (threshold_used >= -1.0 and threshold_used <= 1.0)),
    constraint episode_entries_embedding_model_bounded
        check (embedding_model is null or length(embedding_model) <= 256)
);

comment on table public.episode_entries is
    'Membership junction and audit record: every attach stores the method, similarity, matched entry, threshold, and model in force at decision time. Clustering QA is plain SQL.';

create index episode_entries_entry_idx
    on public.episode_entries (entry_id);

alter table public.news_entries
    add column episode_id uuid references public.episodes(id);

comment on column public.news_entries.episode_id is
    'Denormalized current episode (set by the attach RPC) so entry-to-episode is one hop; episode-to-entries goes through the junction.';

create index news_entries_episode_idx
    on public.news_entries (episode_id);

alter table public.storylines enable row level security;
alter table public.episodes enable row level security;
alter table public.episode_entries enable row level security;

revoke all privileges on table public.storylines
    from public, anon, authenticated, service_role;
revoke all privileges on table public.episodes
    from public, anon, authenticated, service_role;
revoke all privileges on table public.episode_entries
    from public, anon, authenticated, service_role;

grant select on table public.storylines,
    public.episodes,
    public.episode_entries
    to service_role;

commit;
