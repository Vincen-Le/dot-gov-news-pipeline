begin;

-- Exact replay requires the complete state supplied to card generation, not
-- the LLM-selected overview timeline. Capture that state in the same
-- transaction that inserts each immutable card.
create table public.event_card_contexts (
    event_card_id uuid primary key
        references public.event_cards(id) on delete cascade,
    storyline_id uuid not null,
    snapshot_schema_version integer not null default 1,
    knowledge_cutoff_at timestamptz not null,
    source_run_id uuid,
    capture_method text not null default 'card_birth',
    source_entry_ids uuid[] not null,
    source_content_hashes text[] not null,
    episode_ids uuid[] not null,
    first_entry_at timestamptz not null,
    newest_entry_at timestamptz not null,
    entry_count integer not null,
    original_entry_count integer not null,
    syndicated_entry_count integer not null,
    episode_count integer not null,
    agency_ids text[] not null,
    news_source_ids uuid[] not null,
    distinct_feeds integer not null,
    source_weight_max real not null,
    publisher_weight_version integer not null,
    entity_set text[] not null,
    event_keys text[] not null,
    category_id uuid,
    theme_id uuid,
    taxonomy_basis text not null,
    context_hash text not null,
    captured_at timestamptz not null default now(),
    constraint event_card_contexts_schema_version_valid
        check (snapshot_schema_version >= 1),
    constraint event_card_contexts_capture_method_valid
        check (capture_method in (
            'card_birth', 'source_run_replay', 'reviewed_cutoff_fallback'
        )),
    constraint event_card_contexts_source_hash_alignment
        check (cardinality(source_entry_ids) = cardinality(source_content_hashes)),
    constraint event_card_contexts_counts_nonnegative
        check (
            entry_count >= 0
            and original_entry_count >= 0
            and syndicated_entry_count >= 0
            and episode_count >= 0
            and distinct_feeds >= 0
        ),
    constraint event_card_contexts_counts_consistent
        check (
            entry_count = cardinality(source_entry_ids)
            and episode_count = cardinality(episode_ids)
            and entry_count = original_entry_count + syndicated_entry_count
            and distinct_feeds = cardinality(news_source_ids)
        ),
    constraint event_card_contexts_time_valid
        check (first_entry_at <= newest_entry_at
               and newest_entry_at <= knowledge_cutoff_at),
    constraint event_card_contexts_source_weight_valid
        check (source_weight_max >= 0),
    constraint event_card_contexts_publisher_version_valid
        check (publisher_weight_version >= 1),
    constraint event_card_contexts_taxonomy_basis_bounded
        check (length(taxonomy_basis) between 1 and 128),
    constraint event_card_contexts_hash_valid
        check (context_hash ~ '^md5:[0-9a-f]{32}$')
);

comment on table public.event_card_contexts is
    'Immutable point-in-time storyline membership and rank inputs captured atomically at event-card birth. The overview timeline is presentation-only and is not treated as complete membership.';
comment on column public.event_card_contexts.source_run_id is
    'Preallocated experiment/source-run UUID. Deliberately no FK because the run receipt is published only after replay completes.';
comment on column public.event_card_contexts.context_hash is
    'Deterministic integrity receipt over the normalized context payload. md5 is used as a corruption/drift checksum, not as a security primitive.';

create index event_card_contexts_storyline_cutoff_idx
    on public.event_card_contexts (storyline_id, knowledge_cutoff_at, event_card_id);
create index event_card_contexts_source_run_idx
    on public.event_card_contexts (source_run_id, event_card_id)
    where source_run_id is not null;

alter table public.event_card_contexts enable row level security;
revoke all privileges on table public.event_card_contexts
    from public, anon, authenticated, service_role;
grant select on table public.event_card_contexts to service_role;

create function public.reject_event_card_context_update()
returns trigger
language plpgsql
set search_path = ''
as $fn$
begin
    raise exception 'event card contexts are immutable'
        using errcode = '55000';
end;
$fn$;

create trigger event_card_contexts_immutable
before update on public.event_card_contexts
for each row execute function public.reject_event_card_context_update();

revoke all on function public.reject_event_card_context_update()
    from public, anon, authenticated, service_role;

-- Adding arguments creates an overload, so remove the prior RPC signature.
drop function public.insert_event_card(
    uuid, uuid, text, text, text, jsonb, jsonb, integer, text, uuid,
    text, integer, bytea, double precision
);

create function public.insert_event_card(
    p_storyline_id uuid,
    p_episode_id uuid,
    p_kind text,
    p_headline text,
    p_summary text,
    p_timeline jsonb,
    p_rubric jsonb,
    p_rubric_version integer,
    p_interest_reason text,
    p_representative_entry_id uuid,
    p_judge_model text,
    p_prompt_version integer,
    p_overview_embedding bytea,
    p_tau double precision default 124600.0,
    p_source_run_id uuid default null,
    p_publisher_weight_version integer default 1
) returns uuid
language plpgsql
security definer
set search_path = ''
as $fn$
declare
    v_card uuid;
    v_card_newest_at timestamptz;
    v_version integer;
    v_dropped integer;
    v_episode_ids uuid[];
    v_source_entry_ids uuid[];
    v_source_content_hashes text[];
    v_agency_ids text[];
    v_news_source_ids uuid[];
    v_entry_count integer;
    v_original_entry_count integer;
    v_syndicated_entry_count integer;
    v_first_entry_at timestamptz;
    v_newest_entry_at timestamptz;
    v_context_source_weight_max real;
    v_context_payload jsonb;
    s public.storylines%rowtype;
begin
    if p_publisher_weight_version < 1 then
        raise exception 'publisher weight version must be positive';
    end if;

    select * into strict s
    from public.storylines
    where id = p_storyline_id;

    if p_kind = 'episode' then
        select e.newest_entry_at into v_card_newest_at
        from public.episodes e
        where e.id = p_episode_id and e.storyline_id = p_storyline_id;
        if v_card_newest_at is null then
            raise exception 'episode card requires an episode in the supplied storyline';
        end if;
    else
        v_card_newest_at := s.newest_entry_at;
    end if;

    select coalesce(array_agg(e.id order by e.first_entry_at, e.id), '{}'::uuid[])
    into v_episode_ids
    from public.episodes e
    where e.storyline_id = p_storyline_id
      and (p_kind = 'overview' or e.id = p_episode_id);

    select
        coalesce(array_agg(ne.id order by ne.published_at, ne.id), '{}'::uuid[]),
        coalesce(array_agg(ne.content_hash order by ne.published_at, ne.id), '{}'::text[]),
        count(*)::integer,
        count(*) filter (where not ee.is_syndicated)::integer,
        count(*) filter (where ee.is_syndicated)::integer,
        min(ne.published_at),
        max(ne.published_at)
    into
        v_source_entry_ids,
        v_source_content_hashes,
        v_entry_count,
        v_original_entry_count,
        v_syndicated_entry_count,
        v_first_entry_at,
        v_newest_entry_at
    from public.episodes e
    join public.episode_entries ee on ee.episode_id = e.id
    join public.news_entries ne on ne.id = ee.entry_id
    where e.storyline_id = p_storyline_id
      and (p_kind = 'overview' or e.id = p_episode_id);

    if v_entry_count = 0 then
        raise exception 'event card context requires at least one source entry';
    end if;

    select coalesce(array_agg(row_data.publisher_key order by row_data.publisher_key),
                              '{}'::text[])
    into v_agency_ids
    from (
        select distinct nsp.publisher_key
        from public.episodes e
        join public.episode_entries ee on ee.episode_id = e.id
        join public.news_entries ne on ne.id = ee.entry_id
        join public.news_source_publishers nsp
          on nsp.news_source_id = ne.news_source_id
        where e.storyline_id = p_storyline_id
          and (p_kind = 'overview' or e.id = p_episode_id)
    ) row_data;

    select coalesce(array_agg(row_data.news_source_id order by row_data.news_source_id),
                              '{}'::uuid[])
    into v_news_source_ids
    from (
        select distinct ne.news_source_id
        from public.episodes e
        join public.episode_entries ee on ee.episode_id = e.id
        join public.news_entries ne on ne.id = ee.entry_id
        where e.storyline_id = p_storyline_id
          and (p_kind = 'overview' or e.id = p_episode_id)
    ) row_data;

    select coalesce(max(pw.weight), 1.0)
    into v_context_source_weight_max
    from unnest(v_agency_ids) agency_id
    left join public.publisher_weights pw
      on pw.publisher_key = agency_id
     and pw.weight_version = p_publisher_weight_version;

    v_context_payload := pg_catalog.jsonb_build_object(
        'snapshot_schema_version', 1,
        'knowledge_cutoff_at', v_card_newest_at,
        'source_run_id', p_source_run_id,
        'capture_method', 'card_birth',
        'source_entry_ids', v_source_entry_ids,
        'source_content_hashes', v_source_content_hashes,
        'episode_ids', v_episode_ids,
        'first_entry_at', v_first_entry_at,
        'newest_entry_at', v_newest_entry_at,
        'entry_count', v_entry_count,
        'original_entry_count', v_original_entry_count,
        'syndicated_entry_count', v_syndicated_entry_count,
        'episode_count', cardinality(v_episode_ids),
        'agency_ids', v_agency_ids,
        'news_source_ids', v_news_source_ids,
        'distinct_feeds', cardinality(v_news_source_ids),
        'source_weight_max', v_context_source_weight_max,
        'publisher_weight_version', p_publisher_weight_version,
        'entity_set', s.entity_set,
        'event_keys', s.event_keys,
        'category_id', s.category_id,
        'theme_id', s.theme_id,
        'taxonomy_basis', coalesce(s.category_method, s.theme_attach_method, 'unassigned')
    );

    select coalesce(max(version), 0) + 1 into v_version
    from public.event_cards
    where storyline_id = p_storyline_id and kind = p_kind;

    insert into public.event_cards
        (storyline_id, episode_id, kind, version, headline, summary, timeline,
         rubric, rubric_version, interest_reason, representative_entry_id,
         newest_entry_at, rank_key, judge_model, prompt_version)
    values
        (p_storyline_id, p_episode_id, p_kind, v_version, p_headline, p_summary, p_timeline,
         p_rubric, p_rubric_version, p_interest_reason, p_representative_entry_id,
         v_card_newest_at,
         public.compute_rank_key(
             p_rubric, p_rubric_version,
             cardinality(s.agency_ids), s.distinct_feeds,
             s.source_weight_max, s.newest_entry_at, p_tau),
         p_judge_model, p_prompt_version)
    returning id into v_card;

    insert into public.event_card_contexts (
        event_card_id, storyline_id, knowledge_cutoff_at, source_run_id,
        source_entry_ids, source_content_hashes, episode_ids,
        first_entry_at, newest_entry_at, entry_count, original_entry_count,
        syndicated_entry_count, episode_count, agency_ids, news_source_ids,
        distinct_feeds, source_weight_max, publisher_weight_version,
        entity_set, event_keys, category_id, theme_id, taxonomy_basis,
        context_hash
    ) values (
        v_card, p_storyline_id, v_card_newest_at, p_source_run_id,
        v_source_entry_ids, v_source_content_hashes, v_episode_ids,
        v_first_entry_at, v_newest_entry_at, v_entry_count, v_original_entry_count,
        v_syndicated_entry_count, cardinality(v_episode_ids), v_agency_ids,
        v_news_source_ids, cardinality(v_news_source_ids), v_context_source_weight_max,
        p_publisher_weight_version, s.entity_set, s.event_keys, s.category_id,
        s.theme_id, coalesce(s.category_method, s.theme_attach_method, 'unassigned'),
        'md5:' || pg_catalog.md5(v_context_payload::text)
    );

    if p_kind = 'overview' then
        update public.event_cards
        set superseded_by = v_card
        where storyline_id = p_storyline_id
          and kind = 'overview'
          and superseded_by is null
          and id <> v_card;
        update public.storylines
        set latest_card_id = v_card,
            centroid = coalesce(p_overview_embedding, centroid)
        where id = p_storyline_id;
        delete from public.event_cards dead
        where dead.storyline_id = p_storyline_id
          and dead.kind = 'overview'
          and dead.superseded_by = v_card
          and dead.interest_reason = 'spine_initial_overview'
          and not exists (select 1 from public.event_cards ref
                          where ref.superseded_by = dead.id)
          and not exists (select 1 from public.storylines sl
                          where sl.latest_card_id = dead.id);
        get diagnostics v_dropped = row_count;
        if v_dropped > 0 then
            update public.event_cards
            set version = v_version - v_dropped
            where id = v_card;
        end if;
    elsif p_kind = 'episode' and s.latest_card_id is null then
        update public.storylines set latest_card_id = v_card where id = p_storyline_id;
    end if;

    return v_card;
end
$fn$;

comment on function public.insert_event_card is
    'Sole card write path. Inserts the immutable card and its complete point-in-time replay context atomically; source_run_id is preallocated before replay publication.';

revoke execute on function public.insert_event_card(
    uuid, uuid, text, text, text, jsonb, jsonb, integer, text, uuid,
    text, integer, bytea, double precision, uuid, integer
) from public, anon, authenticated;
grant execute on function public.insert_event_card(
    uuid, uuid, text, text, text, jsonb, jsonb, integer, text, uuid,
    text, integer, bytea, double precision, uuid, integer
) to service_role;

commit;
