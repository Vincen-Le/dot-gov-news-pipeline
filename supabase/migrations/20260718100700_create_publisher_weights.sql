begin;

create table public.publisher_weights (
    weight_version integer not null,
    publisher_key text not null,
    tier text not null,
    weight real not null,
    created_at timestamptz not null default now(),
    primary key (weight_version, publisher_key),
    constraint publisher_weights_key_bounded
        check (length(publisher_key) between 1 and 128),
    constraint publisher_weights_tier_valid
        check (tier in ('cabinet', 'independent', 'sub_office', 'default')),
    constraint publisher_weights_weight_bounded
        check (weight >= 1.0 and weight <= 10.0)
);

comment on table public.publisher_weights is
    'Versioned source-authority tiers keyed by curated publisher identity (news_source_publishers.publisher_key). Versions are immutable — edits create a new version. Publishers absent from a version read as weight 1.0. Feeds the ln(source_weight_max) rank term.';

insert into public.publisher_weights (weight_version, publisher_key, tier, weight) values
    (1, 'doj',             'cabinet',     3.0),
    (1, 'state',           'cabinet',     3.0),
    (1, 'treasury',        'cabinet',     3.0),
    (1, 'usda',            'cabinet',     3.0),
    (1, 'va',              'cabinet',     3.0),
    (1, 'cdc',             'independent', 2.0),
    (1, 'cftc',            'independent', 2.0),
    (1, 'cisa',            'independent', 2.0),
    (1, 'eeoc',            'independent', 2.0),
    (1, 'epa',             'independent', 2.0),
    (1, 'fda',             'independent', 2.0),
    (1, 'fema',            'independent', 2.0),
    (1, 'ftc',             'independent', 2.0),
    (1, 'nasa',            'independent', 2.0),
    (1, 'noaa',            'independent', 2.0),
    (1, 'sec',             'independent', 2.0),
    (1, 'ssa',             'independent', 2.0),
    (1, 'uscis',           'independent', 2.0),
    (1, 'bls',             'sub_office',  1.5),
    (1, 'csb',             'sub_office',  1.5),
    (1, 'fsa',             'sub_office',  1.5),
    (1, 'irs',             'sub_office',  1.5),
    (1, 'ncbi',            'sub_office',  1.5),
    (1, 'nps',             'sub_office',  1.5),
    (1, 'ntsb',            'sub_office',  1.5),
    (1, 'nws',             'sub_office',  1.5),
    (1, 'osha',            'sub_office',  1.5),
    (1, 'sec-enforcement', 'sub_office',  1.5),
    (1, 'usgs',            'sub_office',  1.5),
    (1, 'usps',            'sub_office',  1.5);

alter table public.publisher_weights enable row level security;

revoke all privileges on table public.publisher_weights
    from public, anon, authenticated, service_role;

grant select on table public.publisher_weights to service_role;

-- attach_entry_to_episode gains p_publisher_weight_version. Postgres would
-- treat create-or-replace with an extra arg as an overload, so drop first.
drop function public.attach_entry_to_episode(
    uuid, uuid, text, boolean, text, real, uuid, real, text, bytea, timestamptz);

create function public.attach_entry_to_episode(
    p_entry_id uuid,
    p_episode_id uuid,
    p_agency text,
    p_is_syndicated boolean,
    p_attach_method text,
    p_similarity real,
    p_matched_entry_id uuid,
    p_threshold_used real,
    p_embedding_model text,
    p_episode_centroid bytea,
    p_published_at timestamptz,
    p_publisher_weight_version integer default 1
) returns void
language plpgsql
security definer
set search_path = ''
as $fn$
declare
    v_storyline uuid;
begin
    insert into public.episode_entries
        (episode_id, entry_id, is_syndicated, attach_method, similarity,
         matched_entry_id, threshold_used, embedding_model)
    values
        (p_episode_id, p_entry_id, p_is_syndicated, p_attach_method, p_similarity,
         p_matched_entry_id, p_threshold_used, p_embedding_model)
    on conflict do nothing;

    if not found then
        return;  -- replay: junction row already exists, aggregates already counted
    end if;

    select e.storyline_id into v_storyline from public.episodes e where e.id = p_episode_id;

    update public.news_entries
    set episode_id = p_episode_id
    where id = p_entry_id and episode_id is null;

    update public.episodes e set
        entry_count = (select count(*) from public.episode_entries ee where ee.episode_id = e.id),
        first_entry_at = least(e.first_entry_at, coalesce(p_published_at, e.first_entry_at)),
        newest_entry_at = greatest(e.newest_entry_at, coalesce(p_published_at, e.newest_entry_at)),
        centroid = coalesce(p_episode_centroid, e.centroid),
        entity_set = (
            select coalesce(array_agg(x order by x), '{}'::text[]) from (
                select distinct unnest(ne.entity_set) as x
                from public.episode_entries ee
                join public.news_entries ne on ne.id = ee.entry_id
                where ee.episode_id = e.id
                limit 128
            ) t
        ),
        event_keys = (
            select coalesce(array_agg(x order by x), '{}'::text[]) from (
                select distinct unnest(ne.event_keys) as x
                from public.episode_entries ee
                join public.news_entries ne on ne.id = ee.entry_id
                where ee.episode_id = e.id
                limit 32
            ) t
        )
    where e.id = p_episode_id;

    update public.storylines s set
        entry_count = (
            select count(*) from public.episode_entries ee
            join public.episodes ep on ep.id = ee.episode_id
            where ep.storyline_id = s.id
        ),
        distinct_feeds = (
            select count(distinct ne.news_source_id) from public.episode_entries ee
            join public.episodes ep on ep.id = ee.episode_id
            join public.news_entries ne on ne.id = ee.entry_id
            where ep.storyline_id = s.id
        ),
        agency_ids = (
            select coalesce(array_agg(x order by x), '{}'::text[]) from (
                select distinct x from unnest(s.agency_ids || array[p_agency]) as t(x)
                where x is not null
                limit 128
            ) t
        ),
        entity_set = (
            select coalesce(array_agg(x order by x), '{}'::text[]) from (
                select distinct unnest(ep.entity_set) as x
                from public.episodes ep where ep.storyline_id = s.id
                limit 256
            ) t
        ),
        event_keys = (
            select coalesce(array_agg(x order by x), '{}'::text[]) from (
                select distinct unnest(ep.event_keys) as x
                from public.episodes ep where ep.storyline_id = s.id
                limit 64
            ) t
        ),
        source_weight_max = greatest(1.0, coalesce((
            select max(pw.weight)
            from public.episode_entries ee
            join public.episodes ep on ep.id = ee.episode_id
            join public.news_entries ne on ne.id = ee.entry_id
            join public.news_source_publishers nsp
              on nsp.news_source_id = ne.news_source_id
            join public.publisher_weights pw
              on pw.publisher_key = nsp.publisher_key
             and pw.weight_version = p_publisher_weight_version
            where ep.storyline_id = s.id
        ), 1.0)),
        first_entry_at = least(s.first_entry_at, coalesce(p_published_at, s.first_entry_at)),
        newest_entry_at = greatest(s.newest_entry_at, coalesce(p_published_at, s.newest_entry_at))
    where s.id = v_storyline;
end
$fn$;

comment on function public.attach_entry_to_episode is
    'Sole entry->episode write path. Junction insert is the idempotency guard; every aggregate recomputes from junction rows, so replays converge. source_weight_max recomputes from publisher_weights at p_publisher_weight_version (absent publishers weigh 1.0).';

revoke execute on function public.attach_entry_to_episode(
    uuid, uuid, text, boolean, text, real, uuid, real, text, bytea, timestamptz, integer)
    from public, anon, authenticated;
grant execute on function public.attach_entry_to_episode(
    uuid, uuid, text, boolean, text, real, uuid, real, text, bytea, timestamptz, integer)
    to service_role;

commit;
