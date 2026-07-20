begin;

create function public.backfill_event_card_context(
    p_event_card_id uuid,
    p_source_run_id uuid,
    p_publisher_weight_version integer,
    p_tau double precision,
    p_write boolean default false,
    p_allow_fallback boolean default false
) returns jsonb
language plpgsql
security definer
set search_path = ''
as $fn$
declare
    v_card public.event_cards%rowtype;
    v_storyline public.storylines%rowtype;
    v_episode_ids uuid[];
    v_rank_episode_ids uuid[];
    v_source_entry_ids uuid[];
    v_source_content_hashes text[];
    v_agency_ids text[];
    v_news_source_ids uuid[];
    v_entity_set text[];
    v_event_keys text[];
    v_entry_count integer;
    v_original_entry_count integer;
    v_syndicated_entry_count integer;
    v_first_entry_at timestamptz;
    v_newest_entry_at timestamptz;
    v_context_source_weight_max real;
    v_rank_agencies integer;
    v_rank_feeds integer;
    v_rank_source_weight_max real;
    v_rank_input jsonb;
    v_rank_terms jsonb;
    v_recomputed_key float8;
    v_delta float8;
    v_exact boolean;
    v_capture_method text;
    v_context_payload jsonb;
begin
    if p_publisher_weight_version < 1 then
        raise exception 'publisher weight version must be positive'
            using errcode = '22023';
    end if;
    if p_tau <= 0 or p_tau in ('Infinity'::float8, '-Infinity'::float8)
       or p_tau <> p_tau then
        raise exception 'tau must be finite and positive'
            using errcode = '22023';
    end if;
    if exists (
        select 1 from public.event_card_contexts
        where event_card_id = p_event_card_id
    ) then
        return pg_catalog.jsonb_build_object(
            'card_id', p_event_card_id,
            'status', 'already_captured',
            'written', false
        );
    end if;

    select * into v_card
    from public.event_cards
    where id = p_event_card_id;
    if not found then
        raise exception 'unknown event card %', p_event_card_id
            using errcode = 'P0002';
    end if;
    select * into strict v_storyline
    from public.storylines
    where id = v_card.storyline_id;

    if v_card.kind = 'episode' then
        v_episode_ids := array[v_card.episode_id];
    else
        select coalesce(array_agg(card.episode_id order by card.version), '{}'::uuid[])
        into v_episode_ids
        from public.event_cards card
        where card.storyline_id = v_card.storyline_id
          and card.kind = 'episode'
          and card.version <= v_card.version;
    end if;

    -- The rank formula historically used storyline aggregates, including all
    -- episodes closed up to the target card's chain position. Keep this scope
    -- separate from an episode card's presentation membership.
    select coalesce(array_agg(card.episode_id order by card.version), '{}'::uuid[])
    into v_rank_episode_ids
    from public.event_cards card
    where card.storyline_id = v_card.storyline_id
      and card.kind = 'episode'
      and card.version <= case
          when v_card.kind = 'episode' then v_card.version
          else v_card.version
      end;

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
    from public.episode_entries ee
    join public.news_entries ne on ne.id = ee.entry_id
    where ee.episode_id = any(v_episode_ids)
      and ee.attached_at <= v_card.generated_at;

    if v_entry_count = 0 then
        return pg_catalog.jsonb_build_object(
            'card_id', p_event_card_id,
            'status', 'missing_membership',
            'exact', false,
            'written', false
        );
    end if;

    select coalesce(array_agg(row_data.publisher_key order by row_data.publisher_key),
                              '{}'::text[])
    into v_agency_ids
    from (
        select distinct nsp.publisher_key
        from public.episode_entries ee
        join public.news_entries ne on ne.id = ee.entry_id
        join public.news_source_publishers nsp
          on nsp.news_source_id = ne.news_source_id
        where ee.episode_id = any(v_episode_ids)
          and ee.attached_at <= v_card.generated_at
    ) row_data;

    select coalesce(array_agg(row_data.news_source_id order by row_data.news_source_id),
                              '{}'::uuid[])
    into v_news_source_ids
    from (
        select distinct ne.news_source_id
        from public.episode_entries ee
        join public.news_entries ne on ne.id = ee.entry_id
        where ee.episode_id = any(v_episode_ids)
          and ee.attached_at <= v_card.generated_at
    ) row_data;

    select coalesce(array_agg(row_data.value order by row_data.value), '{}'::text[])
    into v_entity_set
    from (
        select distinct unnest(ne.entity_set) as value
        from public.episode_entries ee
        join public.news_entries ne on ne.id = ee.entry_id
        where ee.episode_id = any(v_episode_ids)
          and ee.attached_at <= v_card.generated_at
    ) row_data;

    select coalesce(array_agg(row_data.value order by row_data.value), '{}'::text[])
    into v_event_keys
    from (
        select distinct unnest(ne.event_keys) as value
        from public.episode_entries ee
        join public.news_entries ne on ne.id = ee.entry_id
        where ee.episode_id = any(v_episode_ids)
          and ee.attached_at <= v_card.generated_at
    ) row_data;

    select coalesce(max(weight.weight), 1.0)
    into v_context_source_weight_max
    from unnest(v_agency_ids) agency_id
    left join public.publisher_weights weight
      on weight.publisher_key = agency_id
     and weight.weight_version = p_publisher_weight_version;

    select count(distinct nsp.publisher_key)::integer,
           count(distinct ne.news_source_id)::integer,
           coalesce(max(weight.weight), 1.0)
    into v_rank_agencies, v_rank_feeds, v_rank_source_weight_max
    from public.episode_entries ee
    join public.news_entries ne on ne.id = ee.entry_id
    left join public.news_source_publishers nsp
      on nsp.news_source_id = ne.news_source_id
    left join public.publisher_weights weight
      on weight.publisher_key = nsp.publisher_key
     and weight.weight_version = p_publisher_weight_version
    where ee.episode_id = any(v_rank_episode_ids)
      and ee.attached_at <= v_card.generated_at;

    v_rank_input := pg_catalog.jsonb_build_object(
        'input_schema_version', 1,
        'rubric', v_card.rubric,
        'rubric_version', v_card.rubric_version,
        'distinct_agencies', v_rank_agencies,
        'distinct_feeds', v_rank_feeds,
        'source_weight_max', v_rank_source_weight_max,
        'newest_entry_at', v_card.newest_entry_at,
        'freshness_cutoff_at', v_card.generated_at,
        'tau_seconds', p_tau,
        'publisher_weight_version', p_publisher_weight_version
    );
    v_rank_terms := public.compute_rank_key_terms(
        v_card.rubric, v_card.rubric_version,
        v_rank_agencies, v_rank_feeds, v_rank_source_weight_max,
        v_card.newest_entry_at, p_tau
    );
    v_recomputed_key :=
        (v_rank_terms ->> 'rubric_points')::float8
        + (v_rank_terms ->> 'agency_term')::float8
        + (v_rank_terms ->> 'feed_term')::float8
        + (v_rank_terms ->> 'source_term')::float8
        + (v_rank_terms ->> 'freshness_term')::float8;
    v_delta := v_recomputed_key - v_card.rank_key;
    v_exact := abs(v_delta) <= 0.000001;
    v_capture_method := case
        when v_exact and p_source_run_id is not null then 'source_run_replay'
        else 'reviewed_cutoff_fallback'
    end;

    if not v_exact and not p_allow_fallback then
        return pg_catalog.jsonb_build_object(
            'card_id', p_event_card_id,
            'status', 'rank_mismatch',
            'exact', false,
            'rank_delta', v_delta,
            'entry_count', v_entry_count,
            'episode_count', cardinality(v_episode_ids),
            'written', false
        );
    end if;

    v_context_payload := pg_catalog.jsonb_build_object(
        'snapshot_schema_version', 1,
        'knowledge_cutoff_at', v_card.newest_entry_at,
        'source_run_id', p_source_run_id,
        'capture_method', v_capture_method,
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
        'entity_set', v_entity_set,
        'event_keys', v_event_keys,
        'category_id', v_storyline.category_id,
        'theme_id', v_storyline.theme_id,
        'taxonomy_basis', case
            when p_source_run_id is not null then 'source_run_final'
            else 'reviewed_cutoff_reconstruction'
        end
    );

    if p_write then
        insert into public.event_card_contexts (
            event_card_id, storyline_id, knowledge_cutoff_at, source_run_id,
            capture_method, source_entry_ids, source_content_hashes, episode_ids,
            first_entry_at, newest_entry_at, entry_count, original_entry_count,
            syndicated_entry_count, episode_count, agency_ids, news_source_ids,
            distinct_feeds, source_weight_max, publisher_weight_version,
            entity_set, event_keys, category_id, theme_id, taxonomy_basis,
            context_hash, rank_input, rank_input_hash, rank_terms,
            captured_rank_key
        ) values (
            v_card.id, v_card.storyline_id, v_card.newest_entry_at,
            p_source_run_id, v_capture_method, v_source_entry_ids,
            v_source_content_hashes, v_episode_ids, v_first_entry_at,
            v_newest_entry_at, v_entry_count, v_original_entry_count,
            v_syndicated_entry_count, cardinality(v_episode_ids), v_agency_ids,
            v_news_source_ids, cardinality(v_news_source_ids),
            v_context_source_weight_max, p_publisher_weight_version,
            v_entity_set, v_event_keys, v_storyline.category_id,
            v_storyline.theme_id,
            v_context_payload ->> 'taxonomy_basis',
            'md5:' || pg_catalog.md5(v_context_payload::text),
            case when v_exact then v_rank_input end,
            case when v_exact then 'md5:' || pg_catalog.md5(v_rank_input::text) end,
            case when v_exact then v_rank_terms end,
            case when v_exact then v_card.rank_key end
        );
    end if;

    return pg_catalog.jsonb_build_object(
        'card_id', p_event_card_id,
        'status', case when v_exact then 'exact' else 'fallback' end,
        'capture_method', v_capture_method,
        'exact', v_exact,
        'rank_delta', v_delta,
        'entry_count', v_entry_count,
        'episode_count', cardinality(v_episode_ids),
        'written', p_write
    );
end
$fn$;

comment on function public.backfill_event_card_context is
    'Reconstructs one pre-context card from immutable card versions plus attachment history, proves v1 rank parity, and writes only exact rows unless fallback is explicitly allowed. Direct service-role execution is intentionally denied.';

revoke all on function public.backfill_event_card_context(
    uuid, uuid, integer, double precision, boolean, boolean
) from public, anon, authenticated, service_role;

commit;
