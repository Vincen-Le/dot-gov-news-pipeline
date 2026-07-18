begin;

-- Shared entity_stats touch: lazy EMA decay (7-day half-life), then increment.
-- Definer-only helper; never granted, callable only from the definer RPCs below.
create or replace function public.touch_entity_stats(
    p_tokens text[],
    p_event_time timestamptz
) returns void
language plpgsql
security definer
set search_path = ''
as $fn$
declare
    v_token text;
begin
    if p_tokens is null then
        return;
    end if;
    foreach v_token in array p_tokens loop
        insert into public.entity_stats as es
            (entity, first_seen_at, last_seen_at, total_count, daily_ema, ema_updated_at)
        values (v_token, p_event_time, p_event_time, 1, 1.0, p_event_time)
        on conflict (entity) do update set
            first_seen_at = least(es.first_seen_at, excluded.first_seen_at),
            last_seen_at = greatest(es.last_seen_at, excluded.last_seen_at),
            total_count = es.total_count + 1,
            daily_ema = es.daily_ema
                * power(0.5, greatest(extract(epoch from (excluded.ema_updated_at - es.ema_updated_at)), 0) / (86400.0 * 7.0))
                + 1.0,
            ema_updated_at = greatest(es.ema_updated_at, excluded.ema_updated_at);
    end loop;
end
$fn$;

create or replace function public.upsert_news_source(
    p_canonical_url text,
    p_source_type text,
    p_title text default null
) returns uuid
language plpgsql
security definer
set search_path = ''
as $fn$
declare
    v_id uuid;
begin
    insert into public.news_sources (canonical_url, source_type, title)
    values (p_canonical_url, p_source_type, p_title)
    on conflict (canonical_url) do nothing
    returning id into v_id;
    if v_id is null then
        select id into v_id from public.news_sources
        where canonical_url = p_canonical_url;
    end if;
    return v_id;
end
$fn$;

create or replace function public.ingest_news_entry(
    p_news_source_id uuid,
    p_url text,
    p_url_canonical text,
    p_title text,
    p_summary text,
    p_published_at timestamptz,
    p_content_hash text,
    p_entity_set text[],
    p_event_keys text[],
    p_extractor_version integer
) returns uuid
language plpgsql
security definer
set search_path = ''
as $fn$
declare
    v_id uuid;
begin
    insert into public.news_entries
        (news_source_id, url, url_canonical, title, summary,
         published_at, content_hash, entity_set, event_keys, extractor_version)
    values
        (p_news_source_id, p_url, p_url_canonical, p_title, p_summary,
         p_published_at, p_content_hash, p_entity_set, p_event_keys, p_extractor_version)
    on conflict (url_canonical) do nothing
    returning id into v_id;

    if v_id is null then
        return null;
    end if;

    perform public.touch_entity_stats(
        p_entity_set || p_event_keys, coalesce(p_published_at, now()));

    return v_id;
end
$fn$;

-- p_entity_set/p_event_keys/p_extractor_version cover entries seeded by the
-- backfill workstream's ingest_news_entries, which leaves identity anchors
-- empty; the processing worker backfills them before clustering.
create or replace function public.update_entry_features(
    p_entry_id uuid,
    p_enriched_text text,
    p_enricher_version integer,
    p_embedding bytea,
    p_embedding_model text,
    p_entity_set text[] default null,
    p_event_keys text[] default null,
    p_extractor_version integer default null
) returns void
language plpgsql
security definer
set search_path = ''
as $fn$
declare
    v_published timestamptz;
begin
    update public.news_entries set
        enriched_text = coalesce(p_enriched_text, enriched_text),
        enricher_version = coalesce(p_enricher_version, enricher_version),
        embedding = coalesce(p_embedding, embedding),
        embedding_model = coalesce(p_embedding_model, embedding_model),
        entity_set = coalesce(p_entity_set, entity_set),
        event_keys = coalesce(p_event_keys, event_keys),
        extractor_version = coalesce(p_extractor_version, extractor_version)
    where id = p_entry_id
    returning published_at into v_published;

    if p_entity_set is not null or p_event_keys is not null then
        perform public.touch_entity_stats(
            coalesce(p_entity_set, '{}'::text[]) || coalesce(p_event_keys, '{}'::text[]),
            coalesce(v_published, now()));
    end if;
end
$fn$;

create or replace function public.create_episode_with_storyline(
    p_storyline_id uuid,
    p_attach_method text,
    p_attach_similarity real,
    p_attach_reason text,
    p_adjudicator_model text,
    p_event_time timestamptz
) returns table (episode_id uuid, storyline_id uuid)
language plpgsql
security definer
set search_path = ''
as $fn$
declare
    v_storyline uuid := p_storyline_id;
    v_episode uuid;
begin
    if v_storyline is null then
        if p_attach_method <> 'new_storyline' then
            raise exception 'null storyline requires attach_method new_storyline, got %',
                p_attach_method;
        end if;
        insert into public.storylines (first_entry_at, newest_entry_at)
        values (p_event_time, p_event_time)
        returning id into v_storyline;
    end if;

    insert into public.episodes
        (storyline_id, first_entry_at, newest_entry_at,
         attach_method, attach_similarity, attach_reason, adjudicator_model)
    values
        (v_storyline, p_event_time, p_event_time,
         p_attach_method, p_attach_similarity, p_attach_reason, p_adjudicator_model)
    returning id into v_episode;

    update public.storylines s
    set episode_count = (select count(*) from public.episodes e where e.storyline_id = s.id)
    where s.id = v_storyline;

    return query select v_episode, v_storyline;
end
$fn$;

create or replace function public.attach_entry_to_episode(
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
    p_published_at timestamptz
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
        first_entry_at = least(s.first_entry_at, coalesce(p_published_at, s.first_entry_at)),
        newest_entry_at = greatest(s.newest_entry_at, coalesce(p_published_at, s.newest_entry_at))
    where s.id = v_storyline;
end
$fn$;

create or replace function public.close_episode(
    p_episode_id uuid
) returns boolean
language plpgsql
security definer
set search_path = ''
as $fn$
begin
    update public.episodes
    set status = 'dormant'
    where id = p_episode_id and status = 'open';
    return found;
end
$fn$;

create or replace function public.insert_event_card(
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
    p_tau double precision default 124600.0
) returns uuid
language plpgsql
security definer
set search_path = ''
as $fn$
declare
    v_card uuid;
    v_version integer;
    s public.storylines%rowtype;
begin
    select * into s from public.storylines where id = p_storyline_id;

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
         s.newest_entry_at,
         public.compute_rank_key(
             p_rubric, p_rubric_version,
             cardinality(s.agency_ids), s.distinct_feeds,
             s.source_weight_max, s.newest_entry_at, p_tau),
         p_judge_model, p_prompt_version)
    returning id into v_card;

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
    elsif p_kind = 'episode' and s.latest_card_id is null then
        -- single-episode collapse: the episode card doubles as the overview
        update public.storylines set latest_card_id = v_card where id = p_storyline_id;
    end if;

    return v_card;
end
$fn$;

comment on function public.attach_entry_to_episode is
    'Sole entry->episode write path. Junction insert is the idempotency guard; every aggregate recomputes from junction rows, so replays converge.';
comment on function public.insert_event_card is
    'Write-once card insert: rank_key computed at birth; overview kind supersedes the previous overview and refreshes storylines.latest_card_id + centroid (overview embedding).';
comment on function public.update_entry_features is
    'Processing-side feature writes: enrichment, embedding, and identity anchors (entity_set/event_keys) for entries seeded without extraction.';

do $grants$
declare
    v_sig text;
begin
    foreach v_sig in array array[
        'public.touch_entity_stats(text[], timestamptz)',
        'public.upsert_news_source(text, text, text)',
        'public.ingest_news_entry(uuid, text, text, text, text, timestamptz, text, text[], text[], integer)',
        'public.update_entry_features(uuid, text, integer, bytea, text, text[], text[], integer)',
        'public.create_episode_with_storyline(uuid, text, real, text, text, timestamptz)',
        'public.attach_entry_to_episode(uuid, uuid, text, boolean, text, real, uuid, real, text, bytea, timestamptz)',
        'public.close_episode(uuid)',
        'public.insert_event_card(uuid, uuid, text, text, text, jsonb, jsonb, integer, text, uuid, text, integer, bytea, double precision)'
    ] loop
        execute format('revoke execute on function %s from public, anon, authenticated', v_sig);
        execute format('grant execute on function %s to service_role', v_sig);
    end loop;
    -- helper stays definer-internal
    execute 'revoke execute on function public.touch_entity_stats(text[], timestamptz) from service_role';
end
$grants$;

commit;
