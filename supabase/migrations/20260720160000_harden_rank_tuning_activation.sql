begin;

create function public.assert_cluster_snapshot_v2_complete(p_snapshot jsonb)
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
            'schema-v2 snapshot requires one context per card: % cards, % contexts',
            v_cards, v_contexts
            using errcode = '23514';
    end if;
end
$fn$;

comment on function public.assert_cluster_snapshot_v2_complete(jsonb) is
    'Prevents upgraded databases with unbackfilled cards from claiming a replay-complete schema-v2 experiment snapshot.';

create function public.capture_cluster_snapshot_v2(
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

    v_snapshot := public.build_current_cluster_snapshot_v2();
    perform public.assert_cluster_snapshot_v2_complete(v_snapshot);
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
        ) values (p_run_id, 2, v_snapshot, v_counts);
    else
        insert into public.simple_v1_experiment_cluster_snapshots (
            run_id, schema_version, snapshot, row_counts
        ) values (p_run_id, 2, v_snapshot, v_counts);
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
    select public.capture_cluster_snapshot_v2('complex_v1', p_run_id)
$fn$;

create or replace function public.simple_v1_capture_experiment_cluster_snapshot(
    p_run_id uuid
) returns jsonb
language sql
security definer
set search_path = ''
as $fn$
    select public.capture_cluster_snapshot_v2('simple_v1', p_run_id)
$fn$;

revoke all on function public.assert_cluster_snapshot_v2_complete(jsonb)
    from public, anon, authenticated, service_role;
revoke all on function public.capture_cluster_snapshot_v2(text, uuid)
    from public, anon, authenticated, service_role;
revoke all on function public.complex_v1_capture_experiment_cluster_snapshot(uuid)
    from public, anon, authenticated, service_role;
revoke all on function public.simple_v1_capture_experiment_cluster_snapshot(uuid)
    from public, anon, authenticated, service_role;

-- Opinions must describe the category position frozen on the referenced row,
-- not caller-supplied coordinates that merely share its card ID.
alter table public.snapshot_rank_rows
    add constraint snapshot_rank_rows_card_category_position_unique
    unique (
        experiment_id, rank_system_version_id, golden_event_card_id,
        category_id, category_position
    );

alter table public.rank_position_opinions
    add constraint rank_position_opinions_snapshot_position_fk
    foreign key (
        experiment_id, rank_system_version_id, golden_event_card_id,
        category_id, current_category_position
    ) references public.snapshot_rank_rows (
        experiment_id, rank_system_version_id, golden_event_card_id,
        category_id, category_position
    );

create function public.rank_experiment_validation_errors(p_experiment_id uuid)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $fn$
declare
    v_experiment public.rank_experiments%rowtype;
    v_errors jsonb := '[]'::jsonb;
    v_rows integer;
begin
    select * into v_experiment
    from public.rank_experiments
    where id = p_experiment_id;
    if not found then
        return pg_catalog.jsonb_build_array('unknown rank experiment');
    end if;

    select count(*)::integer into v_rows
    from public.snapshot_rank_rows
    where experiment_id = v_experiment.id
      and rank_system_version_id = v_experiment.rank_system_version_id;
    if v_rows = 0 then
        v_errors := v_errors || '"rank experiment has no snapshot rows"'::jsonb;
    end if;

    if v_experiment.validation_profile = 'legacy_import' then
        if v_experiment.pipeline_namespace <> 'legacy_import'
           or v_experiment.name <> 'legacy-import-v1' then
            v_errors := v_errors
                || '"legacy validation is reserved for legacy-import-v1"'::jsonb;
        end if;
    else
        if v_experiment.source_run_id is null
           or v_experiment.data_cutoff_at is null
           or v_experiment.data_snapshot_hash is null
           or v_experiment.context_set_hash is null
           or v_experiment.code_commit is null
           or v_experiment.started_at is null
           or v_experiment.finished_at is null then
            v_errors := v_errors
                || '"full validation requires complete experiment provenance"'::jsonb;
        end if;
        if exists (
            select 1
            from public.snapshot_rank_rows ranked
            where ranked.experiment_id = v_experiment.id
              and ranked.rank_system_version_id = v_experiment.rank_system_version_id
              and (
                  ranked.rank_input is null
                  or ranked.rank_input_hash is null
                  or ranked.rank_terms is null
                  or ranked.formula_trace is null
                  or ranked.context_snapshot is null
              )
        ) then
            v_errors := v_errors
                || '"full validation requires replayable inputs for every row"'::jsonb;
        end if;
    end if;

    if v_rows > 0 and exists (
        select 1
        from (
            select min(global_position) as minimum,
                   max(global_position) as maximum,
                   count(distinct global_position)::integer as positions
            from public.snapshot_rank_rows
            where experiment_id = v_experiment.id
              and rank_system_version_id = v_experiment.rank_system_version_id
        ) ranked
        where ranked.minimum <> 1
           or ranked.maximum <> v_rows
           or ranked.positions <> v_rows
    ) then
        v_errors := v_errors || '"global positions are not contiguous"'::jsonb;
    end if;

    if v_experiment.validation_profile = 'full' and exists (
        select 1
        from public.snapshot_rank_rows ranked
        where ranked.experiment_id = v_experiment.id
          and ranked.rank_system_version_id = v_experiment.rank_system_version_id
          and (
              not (ranked.rank_terms ?& array[
                  'rubric_points', 'agency_term', 'feed_term',
                  'source_term', 'freshness_term'
              ])
              or abs(
                  ranked.primary_rank_key
                  - (
                      (ranked.rank_terms ->> 'rubric_points')::float8
                      + (ranked.rank_terms ->> 'agency_term')::float8
                      + (ranked.rank_terms ->> 'feed_term')::float8
                      + (ranked.rank_terms ->> 'source_term')::float8
                      + (ranked.rank_terms ->> 'freshness_term')::float8
                  )
              ) > 0.000001
          )
    ) then
        v_errors := v_errors || '"rank terms do not reproduce stored keys"'::jsonb;
    end if;

    return v_errors;
exception
    when invalid_text_representation then
        return v_errors || '"rank terms contain non-numeric values"'::jsonb;
end
$fn$;

create function public.validate_rank_experiment(p_experiment_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $fn$
declare
    v_errors jsonb;
    v_valid boolean;
begin
    perform 1
    from public.rank_experiments
    where id = p_experiment_id
    for update;
    if not found then
        raise exception 'unknown rank experiment %', p_experiment_id
            using errcode = 'P0002';
    end if;

    v_errors := public.rank_experiment_validation_errors(p_experiment_id);
    v_valid := pg_catalog.jsonb_array_length(v_errors) = 0;
    update public.rank_experiments
    set status = case when v_valid then 'validated' else 'rejected' end,
        failure_reason = case
            when v_valid then null
            else left(v_errors::text, 4096)
        end,
        metrics = coalesce(metrics, '{}'::jsonb)
            || pg_catalog.jsonb_build_object(
                'validation', pg_catalog.jsonb_build_object(
                    'valid', v_valid,
                    'errors', v_errors,
                    'validated_at', pg_catalog.now()
                )
            )
    where id = p_experiment_id;

    return pg_catalog.jsonb_build_object('valid', v_valid, 'errors', v_errors);
end
$fn$;

create function public.promote_golden_rank(
    p_experiment_id uuid,
    p_rank_system_version_id uuid,
    p_activated_by text default null
) returns jsonb
language plpgsql
security definer
set search_path = ''
as $fn$
declare
    v_experiment public.rank_experiments%rowtype;
    v_errors jsonb;
    v_rows integer;
begin
    select * into v_experiment
    from public.rank_experiments
    where id = p_experiment_id
    for update;
    if not found then
        raise exception 'unknown rank experiment %', p_experiment_id
            using errcode = 'P0002';
    end if;
    if v_experiment.rank_system_version_id <> p_rank_system_version_id then
        raise exception 'rank experiment/version mismatch'
            using errcode = '23503';
    end if;
    if v_experiment.status not in ('validated', 'promoted') then
        raise exception 'rank experiment % must be validated before promotion',
            p_experiment_id using errcode = '23514';
    end if;

    v_errors := public.rank_experiment_validation_errors(p_experiment_id);
    if pg_catalog.jsonb_array_length(v_errors) <> 0 then
        raise exception 'rank experiment % failed promotion validation: %',
            p_experiment_id, v_errors using errcode = '23514';
    end if;

    select count(*)::integer into v_rows
    from public.snapshot_rank_rows
    where experiment_id = p_experiment_id
      and rank_system_version_id = p_rank_system_version_id;

    update public.rank_experiments
    set status = 'promoted'
    where id = p_experiment_id;

    insert into public.golden_rank_state (
        id, active_experiment_id, active_rank_system_version_id,
        activated_at, activated_by
    ) values (
        'primary', p_experiment_id, p_rank_system_version_id,
        pg_catalog.now(), coalesce(p_activated_by, current_user)
    )
    on conflict (id) do update
    set active_experiment_id = excluded.active_experiment_id,
        active_rank_system_version_id = excluded.active_rank_system_version_id,
        activated_at = excluded.activated_at,
        activated_by = excluded.activated_by;

    return pg_catalog.jsonb_build_object(
        'experiment_id', p_experiment_id,
        'rank_system_version_id', p_rank_system_version_id,
        'rows', v_rows
    );
end
$fn$;

comment on function public.validate_rank_experiment(uuid) is
    'Validates replay provenance, complete immutable rows, contiguous cohort positions, and term/key parity without activating the experiment.';
comment on function public.promote_golden_rank(uuid, uuid, text) is
    'Locks and revalidates a validated experiment, then atomically switches the singleton active ranking pointer. The same RPC performs rollback to an older validated experiment.';

revoke all on function public.rank_experiment_validation_errors(uuid)
    from public, anon, authenticated, service_role;
revoke all on function public.validate_rank_experiment(uuid)
    from public, anon, authenticated;
revoke all on function public.promote_golden_rank(uuid, uuid, text)
    from public, anon, authenticated;
grant execute on function public.validate_rank_experiment(uuid)
    to service_role;
grant execute on function public.promote_golden_rank(uuid, uuid, text)
    to service_role;

commit;
