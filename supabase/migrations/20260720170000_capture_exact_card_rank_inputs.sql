begin;

alter table public.event_card_contexts
    add column rank_input jsonb,
    add column rank_input_hash text,
    add column rank_terms jsonb,
    add column captured_rank_key float8;

alter table public.golden_event_card_contexts
    add column rank_input jsonb,
    add column rank_input_hash text,
    add column rank_terms jsonb,
    add column captured_rank_key float8;

alter table public.event_card_contexts
    add constraint event_card_contexts_rank_capture_consistent
    check (
        (rank_input is null and rank_input_hash is null
         and rank_terms is null and captured_rank_key is null)
        or
        (rank_input is not null and rank_input_hash is not null
         and rank_terms is not null and captured_rank_key is not null)
    ),
    add constraint event_card_contexts_rank_input_valid
    check (rank_input is null or (
        jsonb_typeof(rank_input) = 'object'
        and pg_catalog.pg_column_size(rank_input) <= 65536
    )),
    add constraint event_card_contexts_rank_input_hash_valid
    check (rank_input_hash is null or rank_input_hash ~ '^md5:[0-9a-f]{32}$'),
    add constraint event_card_contexts_rank_terms_valid
    check (rank_terms is null or (
        jsonb_typeof(rank_terms) = 'object'
        and pg_catalog.pg_column_size(rank_terms) <= 32768
    )),
    add constraint event_card_contexts_rank_key_finite
    check (captured_rank_key is null or (
        captured_rank_key > '-Infinity'::float8
        and captured_rank_key < 'Infinity'::float8
    ));

alter table public.golden_event_card_contexts
    add constraint golden_event_card_contexts_rank_capture_consistent
    check (
        (rank_input is null and rank_input_hash is null
         and rank_terms is null and captured_rank_key is null)
        or
        (rank_input is not null and rank_input_hash is not null
         and rank_terms is not null and captured_rank_key is not null)
    ),
    add constraint golden_event_card_contexts_rank_input_valid
    check (rank_input is null or (
        jsonb_typeof(rank_input) = 'object'
        and pg_catalog.pg_column_size(rank_input) <= 65536
    )),
    add constraint golden_event_card_contexts_rank_input_hash_valid
    check (rank_input_hash is null or rank_input_hash ~ '^md5:[0-9a-f]{32}$'),
    add constraint golden_event_card_contexts_rank_terms_valid
    check (rank_terms is null or (
        jsonb_typeof(rank_terms) = 'object'
        and pg_catalog.pg_column_size(rank_terms) <= 32768
    )),
    add constraint golden_event_card_contexts_rank_key_finite
    check (captured_rank_key is null or (
        captured_rank_key > '-Infinity'::float8
        and captured_rank_key < 'Infinity'::float8
    ));

comment on column public.event_card_contexts.rank_input is
    'Exact formula inputs used at card birth. These are distinct from the membership aggregates because episode cards historically rank from storyline-level aggregates.';
comment on column public.event_card_contexts.rank_terms is
    'Exact compute_rank_key_terms output produced in the card insertion transaction.';
comment on column public.event_card_contexts.captured_rank_key is
    'Copy of event_cards.rank_key checked against rank_terms before the card transaction commits.';

create or replace function public.reject_event_card_context_update()
returns trigger
language plpgsql
set search_path = ''
as $fn$
begin
    -- The migration/backfill path may complete a previously absent rank
    -- receipt exactly once. Every membership/provenance field remains fixed.
    if old.rank_input is null
       and new.rank_input is not null
       and (pg_catalog.to_jsonb(new)
            - 'rank_input' - 'rank_input_hash' - 'rank_terms' - 'captured_rank_key')
           = (pg_catalog.to_jsonb(old)
              - 'rank_input' - 'rank_input_hash' - 'rank_terms' - 'captured_rank_key') then
        return new;
    end if;
    raise exception 'event card contexts are immutable'
        using errcode = '55000';
end;
$fn$;

-- Preserve the already-tested membership/card transaction as a private base
-- and wrap it with exact formula capture. Adding the receipt after the base
-- call is still atomic because both functions share one transaction.
alter function public.insert_event_card(
    uuid, uuid, text, text, text, jsonb, jsonb, integer, text, uuid,
    text, integer, bytea, double precision, uuid, integer
) rename to insert_event_card_context_base;

revoke all on function public.insert_event_card_context_base(
    uuid, uuid, text, text, text, jsonb, jsonb, integer, text, uuid,
    text, integer, bytea, double precision, uuid, integer
) from public, anon, authenticated, service_role;

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
    v_card_id uuid;
    v_card public.event_cards%rowtype;
    v_storyline public.storylines%rowtype;
    v_rank_input jsonb;
    v_rank_terms jsonb;
    v_term_sum float8;
begin
    v_card_id := public.insert_event_card_context_base(
        p_storyline_id, p_episode_id, p_kind, p_headline, p_summary,
        p_timeline, p_rubric, p_rubric_version, p_interest_reason,
        p_representative_entry_id, p_judge_model, p_prompt_version,
        p_overview_embedding, p_tau, p_source_run_id,
        p_publisher_weight_version
    );

    select * into strict v_card
    from public.event_cards
    where id = v_card_id;
    select * into strict v_storyline
    from public.storylines
    where id = p_storyline_id;

    v_rank_input := pg_catalog.jsonb_build_object(
        'input_schema_version', 1,
        'rubric', p_rubric,
        'rubric_version', p_rubric_version,
        'distinct_agencies', cardinality(v_storyline.agency_ids),
        'distinct_feeds', v_storyline.distinct_feeds,
        'source_weight_max', v_storyline.source_weight_max,
        'newest_entry_at', v_storyline.newest_entry_at,
        'freshness_cutoff_at', v_card.generated_at,
        'tau_seconds', p_tau,
        'publisher_weight_version', p_publisher_weight_version
    );
    v_rank_terms := public.compute_rank_key_terms(
        p_rubric, p_rubric_version,
        cardinality(v_storyline.agency_ids), v_storyline.distinct_feeds,
        v_storyline.source_weight_max, v_storyline.newest_entry_at, p_tau
    );
    v_term_sum :=
        (v_rank_terms ->> 'rubric_points')::float8
        + (v_rank_terms ->> 'agency_term')::float8
        + (v_rank_terms ->> 'feed_term')::float8
        + (v_rank_terms ->> 'source_term')::float8
        + (v_rank_terms ->> 'freshness_term')::float8;
    if abs(v_term_sum - v_card.rank_key) > 0.000001 then
        raise exception 'captured rank terms do not reproduce card rank key'
            using errcode = '23514';
    end if;

    update public.event_card_contexts
    set rank_input = v_rank_input,
        rank_input_hash = 'md5:' || pg_catalog.md5(v_rank_input::text),
        rank_terms = v_rank_terms,
        captured_rank_key = v_card.rank_key
    where event_card_id = v_card_id;

    return v_card_id;
end
$fn$;

comment on function public.insert_event_card is
    'Sole public card write path. Atomically captures complete membership plus the exact v1 formula inputs, terms, and rank key used at birth.';

revoke execute on function public.insert_event_card(
    uuid, uuid, text, text, text, jsonb, jsonb, integer, text, uuid,
    text, integer, bytea, double precision, uuid, integer
) from public, anon, authenticated;
grant execute on function public.insert_event_card(
    uuid, uuid, text, text, text, jsonb, jsonb, integer, text, uuid,
    text, integer, bytea, double precision, uuid, integer
) to service_role;

create function public.build_current_cluster_snapshot_v3()
returns jsonb
language sql
stable
security definer
set search_path = ''
as $fn$
    select (public.build_current_cluster_snapshot_v2() - 'event_card_contexts')
        || pg_catalog.jsonb_build_object(
            'event_card_contexts', coalesce((
                select pg_catalog.jsonb_agg(
                    pg_catalog.to_jsonb(context) order by context.event_card_id
                )
                from public.event_card_contexts context
            ), '[]'::jsonb)
        )
$fn$;

create function public.assert_cluster_snapshot_v3_complete(p_snapshot jsonb)
returns void
language plpgsql
set search_path = ''
as $fn$
declare
    v_cards integer;
    v_contexts integer;
begin
    v_cards := pg_catalog.jsonb_array_length(p_snapshot -> 'event_cards');
    v_contexts := pg_catalog.jsonb_array_length(p_snapshot -> 'event_card_contexts');
    if v_cards <> v_contexts then
        raise exception
            'schema-v3 snapshot requires one context per card: % cards, % contexts',
            v_cards, v_contexts using errcode = '23514';
    end if;
    if exists (
        select 1
        from pg_catalog.jsonb_array_elements(
            p_snapshot -> 'event_card_contexts'
        ) context
        where context -> 'rank_input' = 'null'::jsonb
           or context -> 'rank_terms' = 'null'::jsonb
           or context ->> 'rank_input_hash' is null
           or context ->> 'captured_rank_key' is null
    ) then
        raise exception 'schema-v3 snapshot requires exact rank receipts for every card'
            using errcode = '23514';
    end if;
end
$fn$;

create function public.capture_cluster_snapshot_v3(
    p_pipeline_namespace text,
    p_run_id uuid
) returns jsonb
language plpgsql
security definer
set search_path = ''
as $fn$
declare
    v_snapshot jsonb;
    v_counts jsonb;
begin
    if p_pipeline_namespace = 'complex_v1' then
        if not exists (
            select 1 from public.complex_v1_experiment_runs where id = p_run_id
        ) then
            raise exception 'unknown complex_v1 experiment run %', p_run_id
                using errcode = '23503';
        end if;
    elsif p_pipeline_namespace = 'simple_v1' then
        if not exists (
            select 1 from public.simple_v1_experiment_runs where id = p_run_id
        ) then
            raise exception 'unknown simple_v1 experiment run %', p_run_id
                using errcode = '23503';
        end if;
    else
        raise exception 'unknown pipeline namespace %', p_pipeline_namespace
            using errcode = '22023';
    end if;

    v_snapshot := public.build_current_cluster_snapshot_v3();
    perform public.assert_cluster_snapshot_v3_complete(v_snapshot);
    v_counts := pg_catalog.jsonb_build_object(
        'storylines', pg_catalog.jsonb_array_length(v_snapshot -> 'storylines'),
        'episodes', pg_catalog.jsonb_array_length(v_snapshot -> 'episodes'),
        'episode_entries', pg_catalog.jsonb_array_length(v_snapshot -> 'episode_entries'),
        'news_entries', pg_catalog.jsonb_array_length(v_snapshot -> 'news_entries'),
        'event_cards', pg_catalog.jsonb_array_length(v_snapshot -> 'event_cards'),
        'event_card_contexts',
            pg_catalog.jsonb_array_length(v_snapshot -> 'event_card_contexts'),
        'topic_themes', pg_catalog.jsonb_array_length(v_snapshot -> 'topic_themes'),
        'topic_categories', pg_catalog.jsonb_array_length(v_snapshot -> 'topic_categories')
    );

    if p_pipeline_namespace = 'complex_v1' then
        insert into public.complex_v1_experiment_cluster_snapshots (
            run_id, schema_version, snapshot, row_counts
        ) values (p_run_id, 3, v_snapshot, v_counts);
    else
        insert into public.simple_v1_experiment_cluster_snapshots (
            run_id, schema_version, snapshot, row_counts
        ) values (p_run_id, 3, v_snapshot, v_counts);
    end if;
    return v_counts;
end
$fn$;

create or replace function public.complex_v1_capture_experiment_cluster_snapshot(
    p_run_id uuid
) returns jsonb
language sql
security definer
set search_path = ''
as $fn$
    select public.capture_cluster_snapshot_v3('complex_v1', p_run_id)
$fn$;

create or replace function public.simple_v1_capture_experiment_cluster_snapshot(
    p_run_id uuid
) returns jsonb
language sql
security definer
set search_path = ''
as $fn$
    select public.capture_cluster_snapshot_v3('simple_v1', p_run_id)
$fn$;

comment on function public.capture_cluster_snapshot_v3(text, uuid) is
    'Captures replay-complete schema-v3 clustering state and refuses missing card contexts or exact formula receipts.';

revoke all on function public.build_current_cluster_snapshot_v3()
    from public, anon, authenticated, service_role;
revoke all on function public.assert_cluster_snapshot_v3_complete(jsonb)
    from public, anon, authenticated, service_role;
revoke all on function public.capture_cluster_snapshot_v3(text, uuid)
    from public, anon, authenticated, service_role;
revoke all on function public.complex_v1_capture_experiment_cluster_snapshot(uuid)
    from public, anon, authenticated, service_role;
revoke all on function public.simple_v1_capture_experiment_cluster_snapshot(uuid)
    from public, anon, authenticated, service_role;

commit;
