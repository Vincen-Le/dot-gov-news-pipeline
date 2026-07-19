begin;

create table public.topology_label_sets (
    id uuid primary key default gen_random_uuid(),
    name text not null,
    labeling_method text not null,
    labeling_version integer not null,
    parameters jsonb not null default '{}'::jsonb,
    status text not null default 'building',
    entry_count integer not null default 0,
    created_at timestamptz not null default now(),
    completed_at timestamptz,
    constraint topology_label_sets_name_bounded
        check (length(name) between 1 and 128),
    constraint topology_label_sets_method_bounded
        check (length(labeling_method) between 1 and 128),
    constraint topology_label_sets_version_valid
        check (labeling_version >= 1),
    constraint topology_label_sets_parameters_valid
        check (
            jsonb_typeof(parameters) = 'object'
            and pg_catalog.pg_column_size(parameters) <= 16384
        ),
    constraint topology_label_sets_status_valid
        check (status in ('building', 'complete', 'superseded')),
    constraint topology_label_sets_entry_count_nonnegative
        check (entry_count >= 0),
    constraint topology_label_sets_completion_valid
        check (
            (status = 'building' and completed_at is null)
            or (status in ('complete', 'superseded') and completed_at is not null)
        )
);

comment on table public.topology_label_sets is
    'Versioned provenance for provisional corpus-topology labels. Only complete sets are eligible for experiment curation.';

create unique index topology_label_sets_name_version_idx
    on public.topology_label_sets (lower(name), labeling_version);
create index topology_label_sets_status_created_idx
    on public.topology_label_sets (status, created_at desc);

create table public.news_entry_topology_labels (
    label_set_id uuid not null
        references public.topology_label_sets(id) on delete cascade,
    news_entry_id uuid not null
        references public.news_entries(id) on delete cascade,
    content_hash_at_labeling text not null,
    proposed_storyline_key text not null,
    proposed_episode_key text not null,
    storyline_entry_count integer not null,
    storyline_episode_count integer not null,
    episode_entry_count integer not null,
    topic_category_id uuid references public.topic_categories(id),
    category_confidence text,
    topology_confidence real,
    evidence jsonb not null default '{}'::jsonb,
    topology_class text generated always as (
        case
            when storyline_episode_count >= 2
                then 'multi_episode_storyline'
            when storyline_entry_count >= 2
                then 'multi_entry_single_episode'
            else 'singleton_episode_storyline'
        end
    ) stored,
    is_multi_episode_storyline boolean generated always as
        (storyline_episode_count >= 2) stored,
    is_multi_entry_episode boolean generated always as
        (episode_entry_count >= 2) stored,
    created_at timestamptz not null default now(),
    primary key (label_set_id, news_entry_id),
    constraint news_entry_topology_labels_content_hash_valid
        check (content_hash_at_labeling ~ '^[0-9a-f]{64}$'),
    constraint news_entry_topology_labels_storyline_key_bounded
        check (length(proposed_storyline_key) between 1 and 256),
    constraint news_entry_topology_labels_episode_key_bounded
        check (length(proposed_episode_key) between 1 and 256),
    constraint news_entry_topology_labels_counts_valid
        check (
            storyline_entry_count >= 1
            and storyline_episode_count >= 1
            and storyline_episode_count <= storyline_entry_count
            and episode_entry_count >= 1
            and episode_entry_count <= storyline_entry_count
            and (
                storyline_episode_count <> 1
                or episode_entry_count = storyline_entry_count
            )
        ),
    constraint news_entry_topology_labels_category_confidence_valid
        check (
            category_confidence is null
            or category_confidence in ('low', 'medium', 'high')
        ),
    constraint news_entry_topology_labels_topology_confidence_valid
        check (
            topology_confidence is null
            or (topology_confidence >= 0 and topology_confidence <= 1)
        ),
    constraint news_entry_topology_labels_evidence_valid
        check (
            jsonb_typeof(evidence) = 'object'
            and pg_catalog.pg_column_size(evidence) <= 8192
        )
);

comment on table public.news_entry_topology_labels is
    'Sidecar labels for experiment curation. Counts preserve both orthogonal properties: continuing storyline membership and same-episode entry density.';
comment on column public.news_entry_topology_labels.proposed_storyline_key is
    'Stable, label-set-local identity for keeping a complete estimated storyline together in an evaluation corpus.';
comment on column public.news_entry_topology_labels.proposed_episode_key is
    'Stable, label-set-local identity for keeping a complete estimated episode together in an evaluation corpus.';
comment on column public.news_entry_topology_labels.topology_class is
    'Generated storyline-level class: multi-episode, multi-entry single-episode, or singleton.';
comment on column public.news_entry_topology_labels.is_multi_entry_episode is
    'Orthogonal episode-level flag; it may be true inside either a single-episode or multi-episode storyline.';

create index news_entry_topology_labels_entry_idx
    on public.news_entry_topology_labels (news_entry_id, label_set_id);
create index news_entry_topology_labels_storyline_pool_idx
    on public.news_entry_topology_labels
        (label_set_id, topology_class, proposed_storyline_key);
create index news_entry_topology_labels_episode_pool_idx
    on public.news_entry_topology_labels
        (label_set_id, is_multi_entry_episode, proposed_episode_key);
create index news_entry_topology_labels_category_pool_idx
    on public.news_entry_topology_labels
        (label_set_id, topic_category_id, topology_class);

create or replace function public.begin_topology_label_set(
    p_name text,
    p_labeling_method text,
    p_labeling_version integer,
    p_parameters jsonb default '{}'::jsonb
) returns uuid
language plpgsql
security definer
set search_path = ''
as $fn$
declare
    v_label_set_id uuid;
begin
    insert into public.topology_label_sets
        (name, labeling_method, labeling_version, parameters)
    values
        (p_name, p_labeling_method, p_labeling_version,
         coalesce(p_parameters, '{}'::jsonb))
    returning id into v_label_set_id;

    return v_label_set_id;
end
$fn$;

create or replace function public.upsert_news_entry_topology_labels(
    p_label_set_id uuid,
    p_labels jsonb
) returns integer
language plpgsql
security definer
set search_path = ''
as $fn$
declare
    v_row_count integer;
begin
    if not exists (
        select 1
        from public.topology_label_sets
        where id = p_label_set_id and status = 'building'
        for update
    ) then
        raise exception 'topology label set % is missing or not building',
            p_label_set_id;
    end if;

    if p_labels is null
       or jsonb_typeof(p_labels) <> 'array'
       or jsonb_array_length(p_labels) not between 1 and 1000 then
        raise exception 'p_labels must be a JSON array containing 1 to 1000 labels';
    end if;

    insert into public.news_entry_topology_labels (
        label_set_id,
        news_entry_id,
        content_hash_at_labeling,
        proposed_storyline_key,
        proposed_episode_key,
        storyline_entry_count,
        storyline_episode_count,
        episode_entry_count,
        topic_category_id,
        category_confidence,
        topology_confidence,
        evidence
    )
    select
        p_label_set_id,
        (label ->> 'news_entry_id')::uuid,
        label ->> 'content_hash_at_labeling',
        label ->> 'proposed_storyline_key',
        label ->> 'proposed_episode_key',
        (label ->> 'storyline_entry_count')::integer,
        (label ->> 'storyline_episode_count')::integer,
        (label ->> 'episode_entry_count')::integer,
        nullif(label ->> 'topic_category_id', '')::uuid,
        nullif(label ->> 'category_confidence', ''),
        nullif(label ->> 'topology_confidence', '')::real,
        coalesce(label -> 'evidence', '{}'::jsonb)
    from jsonb_array_elements(p_labels) as labels(label)
    on conflict (label_set_id, news_entry_id) do update set
        content_hash_at_labeling = excluded.content_hash_at_labeling,
        proposed_storyline_key = excluded.proposed_storyline_key,
        proposed_episode_key = excluded.proposed_episode_key,
        storyline_entry_count = excluded.storyline_entry_count,
        storyline_episode_count = excluded.storyline_episode_count,
        episode_entry_count = excluded.episode_entry_count,
        topic_category_id = excluded.topic_category_id,
        category_confidence = excluded.category_confidence,
        topology_confidence = excluded.topology_confidence,
        evidence = excluded.evidence;

    get diagnostics v_row_count = row_count;
    return v_row_count;
end
$fn$;

create or replace function public.complete_topology_label_set(
    p_label_set_id uuid,
    p_expected_entry_count integer
) returns integer
language plpgsql
security definer
set search_path = ''
as $fn$
declare
    v_actual_entry_count integer;
begin
    if p_expected_entry_count < 1 then
        raise exception 'p_expected_entry_count must be positive';
    end if;

    if not exists (
        select 1
        from public.topology_label_sets
        where id = p_label_set_id and status = 'building'
        for update
    ) then
        raise exception 'topology label set % is missing or not building',
            p_label_set_id;
    end if;

    select count(*)::integer
    into v_actual_entry_count
    from public.news_entry_topology_labels
    where label_set_id = p_label_set_id;

    if v_actual_entry_count <> p_expected_entry_count then
        raise exception 'topology label set % has % labels; expected %',
            p_label_set_id, v_actual_entry_count, p_expected_entry_count;
    end if;

    if exists (
        with storyline_counts as (
            select
                proposed_storyline_key,
                count(*)::integer as actual_entry_count,
                count(distinct proposed_episode_key)::integer as actual_episode_count
            from public.news_entry_topology_labels
            where label_set_id = p_label_set_id
            group by proposed_storyline_key
        ),
        episode_counts as (
            select
                proposed_episode_key,
                count(*)::integer as actual_entry_count
            from public.news_entry_topology_labels
            where label_set_id = p_label_set_id
            group by proposed_episode_key
        )
        select 1
        from public.news_entry_topology_labels labels
        join storyline_counts
          on storyline_counts.proposed_storyline_key = labels.proposed_storyline_key
        join episode_counts
          on episode_counts.proposed_episode_key = labels.proposed_episode_key
        where labels.label_set_id = p_label_set_id
          and (
              labels.storyline_entry_count <> storyline_counts.actual_entry_count
              or labels.storyline_episode_count <> storyline_counts.actual_episode_count
              or labels.episode_entry_count <> episode_counts.actual_entry_count
          )
    ) then
        raise exception 'topology label set % contains inconsistent group counts',
            p_label_set_id;
    end if;

    update public.topology_label_sets
    set status = 'complete',
        entry_count = v_actual_entry_count,
        completed_at = now()
    where id = p_label_set_id;

    return v_actual_entry_count;
end
$fn$;

create or replace function public.curate_news_entry_dataset_by_storyline_topology(
    p_label_set_id uuid,
    p_total_entries integer,
    p_multi_episode_percent numeric,
    p_multi_entry_single_episode_percent numeric default 0,
    p_seed text default 'default',
    p_topic_category_ids uuid[] default null,
    p_require_prepared boolean default false,
    p_require_unclustered boolean default false,
    p_published_before timestamptz default null
) returns table (
    news_entry_id uuid,
    topology_class text,
    proposed_storyline_key text,
    proposed_episode_key text,
    storyline_entry_count integer,
    storyline_episode_count integer,
    episode_entry_count integer,
    topic_category_id uuid,
    is_multi_entry_episode boolean
)
language plpgsql
security definer
set search_path = ''
as $fn$
declare
    v_multi_episode_target integer;
    v_multi_entry_target integer;
    v_singleton_target integer;
    v_multi_episode_selected integer := 0;
    v_multi_entry_selected integer := 0;
    v_available integer;
    v_group record;
    v_multi_episode_storylines text[] := '{}'::text[];
    v_multi_entry_storylines text[] := '{}'::text[];
begin
    if p_total_entries < 1 then
        raise exception 'p_total_entries must be positive';
    end if;
    if p_multi_episode_percent < 0
       or p_multi_entry_single_episode_percent < 0
       or p_multi_episode_percent + p_multi_entry_single_episode_percent > 100 then
        raise exception 'topology percentages must be nonnegative and sum to at most 100';
    end if;
    if p_seed is null or length(p_seed) not between 1 and 256 then
        raise exception 'p_seed must contain 1 to 256 characters';
    end if;
    if not exists (
        select 1
        from public.topology_label_sets
        where id = p_label_set_id and status = 'complete'
    ) then
        raise exception 'topology label set % is missing or incomplete', p_label_set_id;
    end if;

    v_multi_episode_target := round(
        p_total_entries * p_multi_episode_percent / 100.0)::integer;
    v_multi_entry_target := round(
        p_total_entries * p_multi_entry_single_episode_percent / 100.0)::integer;

    select coalesce(sum(grouped.entry_count), 0)::integer
    into v_available
    from (
        select count(*)::integer as entry_count
        from public.news_entry_topology_labels labels
        join public.news_entries entries on entries.id = labels.news_entry_id
        where labels.label_set_id = p_label_set_id
          and labels.topology_class = 'multi_episode_storyline'
          and (p_topic_category_ids is null
               or labels.topic_category_id = any(p_topic_category_ids))
        group by labels.proposed_storyline_key
        having count(*) = max(labels.storyline_entry_count)
           and bool_and(labels.content_hash_at_labeling = entries.content_hash)
           and bool_and(not p_require_prepared or entries.embedding is not null)
           and bool_and(not p_require_unclustered or entries.episode_id is null)
           and bool_and(p_published_before is null
                        or entries.published_at <= p_published_before)
    ) grouped;
    if v_available < v_multi_episode_target then
        raise exception 'requested % multi-episode entries, but only % are eligible',
            v_multi_episode_target, v_available;
    end if;

    for v_group in
        select
            labels.proposed_storyline_key,
            count(*)::integer as entry_count
        from public.news_entry_topology_labels labels
        join public.news_entries entries on entries.id = labels.news_entry_id
        where labels.label_set_id = p_label_set_id
          and labels.topology_class = 'multi_episode_storyline'
          and (p_topic_category_ids is null
               or labels.topic_category_id = any(p_topic_category_ids))
        group by labels.proposed_storyline_key
        having count(*) = max(labels.storyline_entry_count)
           and bool_and(labels.content_hash_at_labeling = entries.content_hash)
           and bool_and(not p_require_prepared or entries.embedding is not null)
           and bool_and(not p_require_unclustered or entries.episode_id is null)
           and bool_and(p_published_before is null
                        or entries.published_at <= p_published_before)
        order by md5(p_seed || ':multi_episode:' || labels.proposed_storyline_key)
    loop
        if v_multi_episode_selected + v_group.entry_count <= v_multi_episode_target then
            v_multi_episode_storylines := array_append(
                v_multi_episode_storylines, v_group.proposed_storyline_key);
            v_multi_episode_selected := v_multi_episode_selected + v_group.entry_count;
        end if;
        exit when v_multi_episode_selected = v_multi_episode_target;
    end loop;

    select coalesce(sum(grouped.entry_count), 0)::integer
    into v_available
    from (
        select count(*)::integer as entry_count
        from public.news_entry_topology_labels labels
        join public.news_entries entries on entries.id = labels.news_entry_id
        where labels.label_set_id = p_label_set_id
          and labels.topology_class = 'multi_entry_single_episode'
          and (p_topic_category_ids is null
               or labels.topic_category_id = any(p_topic_category_ids))
        group by labels.proposed_storyline_key
        having count(*) = max(labels.storyline_entry_count)
           and bool_and(labels.content_hash_at_labeling = entries.content_hash)
           and bool_and(not p_require_prepared or entries.embedding is not null)
           and bool_and(not p_require_unclustered or entries.episode_id is null)
           and bool_and(p_published_before is null
                        or entries.published_at <= p_published_before)
    ) grouped;
    if v_available < v_multi_entry_target then
        raise exception 'requested % multi-entry single-episode entries, but only % are eligible',
            v_multi_entry_target, v_available;
    end if;

    for v_group in
        select
            labels.proposed_storyline_key,
            count(*)::integer as entry_count
        from public.news_entry_topology_labels labels
        join public.news_entries entries on entries.id = labels.news_entry_id
        where labels.label_set_id = p_label_set_id
          and labels.topology_class = 'multi_entry_single_episode'
          and (p_topic_category_ids is null
               or labels.topic_category_id = any(p_topic_category_ids))
        group by labels.proposed_storyline_key
        having count(*) = max(labels.storyline_entry_count)
           and bool_and(labels.content_hash_at_labeling = entries.content_hash)
           and bool_and(not p_require_prepared or entries.embedding is not null)
           and bool_and(not p_require_unclustered or entries.episode_id is null)
           and bool_and(p_published_before is null
                        or entries.published_at <= p_published_before)
        order by md5(p_seed || ':multi_entry:' || labels.proposed_storyline_key)
    loop
        if v_multi_entry_selected + v_group.entry_count <= v_multi_entry_target then
            v_multi_entry_storylines := array_append(
                v_multi_entry_storylines, v_group.proposed_storyline_key);
            v_multi_entry_selected := v_multi_entry_selected + v_group.entry_count;
        end if;
        exit when v_multi_entry_selected = v_multi_entry_target;
    end loop;

    -- Whole storylines are never truncated. Any small packing shortfall in a
    -- requested non-singleton stratum is filled with singleton entries so the
    -- returned dataset still contains exactly p_total_entries rows.
    v_singleton_target := p_total_entries
        - v_multi_episode_selected
        - v_multi_entry_selected;

    select count(*)::integer
    into v_available
    from public.news_entry_topology_labels labels
    join public.news_entries entries on entries.id = labels.news_entry_id
    where labels.label_set_id = p_label_set_id
      and labels.topology_class = 'singleton_episode_storyline'
      and (p_topic_category_ids is null
           or labels.topic_category_id = any(p_topic_category_ids))
      and labels.content_hash_at_labeling = entries.content_hash
      and (not p_require_prepared or entries.embedding is not null)
      and (not p_require_unclustered or entries.episode_id is null)
      and (p_published_before is null or entries.published_at <= p_published_before);
    if v_available < v_singleton_target then
        raise exception 'dataset needs % singleton entries after whole-storyline packing, but only % are eligible',
            v_singleton_target, v_available;
    end if;

    return query
    with selected as (
        select labels.*
        from public.news_entry_topology_labels labels
        where labels.label_set_id = p_label_set_id
          and (
              labels.proposed_storyline_key = any(v_multi_episode_storylines)
              or labels.proposed_storyline_key = any(v_multi_entry_storylines)
          )
        union all
        select singleton_labels.*
        from (
            select labels.*
            from public.news_entry_topology_labels labels
            join public.news_entries entries on entries.id = labels.news_entry_id
            where labels.label_set_id = p_label_set_id
              and labels.topology_class = 'singleton_episode_storyline'
              and (p_topic_category_ids is null
                   or labels.topic_category_id = any(p_topic_category_ids))
              and labels.content_hash_at_labeling = entries.content_hash
              and (not p_require_prepared or entries.embedding is not null)
              and (not p_require_unclustered or entries.episode_id is null)
              and (p_published_before is null
                   or entries.published_at <= p_published_before)
            order by md5(p_seed || ':singleton:' || labels.news_entry_id::text)
            limit v_singleton_target
        ) singleton_labels
    )
    select
        selected.news_entry_id,
        selected.topology_class,
        selected.proposed_storyline_key,
        selected.proposed_episode_key,
        selected.storyline_entry_count,
        selected.storyline_episode_count,
        selected.episode_entry_count,
        selected.topic_category_id,
        selected.is_multi_entry_episode
    from selected
    order by selected.proposed_storyline_key,
             selected.proposed_episode_key,
             selected.news_entry_id;
end
$fn$;

comment on function public.curate_news_entry_dataset_by_storyline_topology is
    'Deterministically curates an exact-size evaluation corpus with requested entry shares. Whole estimated storylines stay intact; packing shortfalls are filled with singleton entries.';

alter table public.topology_label_sets enable row level security;
alter table public.news_entry_topology_labels enable row level security;

revoke all privileges on table public.topology_label_sets
    from public, anon, authenticated, service_role;
revoke all privileges on table public.news_entry_topology_labels
    from public, anon, authenticated, service_role;

grant select on table public.topology_label_sets,
    public.news_entry_topology_labels
    to service_role;

do $grants$
declare
    v_signature text;
begin
    foreach v_signature in array array[
        'public.begin_topology_label_set(text, text, integer, jsonb)',
        'public.upsert_news_entry_topology_labels(uuid, jsonb)',
        'public.complete_topology_label_set(uuid, integer)',
        'public.curate_news_entry_dataset_by_storyline_topology(uuid, integer, numeric, numeric, text, uuid[], boolean, boolean, timestamptz)'
    ] loop
        execute format(
            'revoke execute on function %s from public, anon, authenticated',
            v_signature
        );
        execute format('grant execute on function %s to service_role', v_signature);
    end loop;
end
$grants$;

commit;
