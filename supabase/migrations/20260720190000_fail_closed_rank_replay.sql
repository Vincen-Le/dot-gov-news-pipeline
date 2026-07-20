begin;

-- A missing historical membership context cannot be proven from mutable live
-- tables. This RPC may complete the rank receipt on an already-frozen overview
-- context, but it never invents or persists membership and never writes a
-- fallback row. Cards without contexts must be regenerated from their source
-- snapshot/reviewed corpus.
create or replace function public.backfill_event_card_context(
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
    v_context public.event_card_contexts%rowtype;
    v_rank_input jsonb;
    v_rank_terms jsonb;
    v_recomputed_key float8;
    v_delta float8;
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

    select * into v_card
    from public.event_cards
    where id = p_event_card_id;
    if not found then
        raise exception 'unknown event card %', p_event_card_id
            using errcode = 'P0002';
    end if;
    select * into v_context
    from public.event_card_contexts
    where event_card_id = p_event_card_id;
    if not found then
        return pg_catalog.jsonb_build_object(
            'card_id', p_event_card_id,
            'status', 'requires_source_replay',
            'exact', false,
            'written', false
        );
    end if;
    if v_context.rank_input is not null then
        return pg_catalog.jsonb_build_object(
            'card_id', p_event_card_id,
            'status', 'already_captured',
            'exact', true,
            'written', false
        );
    end if;
    if v_card.kind <> 'overview' then
        return pg_catalog.jsonb_build_object(
            'card_id', p_event_card_id,
            'status', 'insufficient_rank_scope',
            'exact', false,
            'written', false
        );
    end if;
    if v_context.publisher_weight_version <> p_publisher_weight_version then
        return pg_catalog.jsonb_build_object(
            'card_id', p_event_card_id,
            'status', 'publisher_version_mismatch',
            'exact', false,
            'written', false
        );
    end if;
    if p_source_run_id is not null
       and v_context.source_run_id is distinct from p_source_run_id then
        return pg_catalog.jsonb_build_object(
            'card_id', p_event_card_id,
            'status', 'source_run_mismatch',
            'exact', false,
            'written', false
        );
    end if;

    v_rank_input := pg_catalog.jsonb_build_object(
        'input_schema_version', 1,
        'rubric', v_card.rubric,
        'rubric_version', v_card.rubric_version,
        'distinct_agencies', cardinality(v_context.agency_ids),
        'distinct_feeds', v_context.distinct_feeds,
        'source_weight_max', v_context.source_weight_max,
        'newest_entry_at', v_card.newest_entry_at,
        'freshness_cutoff_at', v_card.generated_at,
        'tau_seconds', p_tau,
        'publisher_weight_version', p_publisher_weight_version
    );
    v_rank_terms := public.compute_rank_key_terms(
        v_card.rubric, v_card.rubric_version,
        cardinality(v_context.agency_ids), v_context.distinct_feeds,
        v_context.source_weight_max, v_card.newest_entry_at, p_tau
    );
    v_recomputed_key :=
        (v_rank_terms ->> 'rubric_points')::float8
        + (v_rank_terms ->> 'agency_term')::float8
        + (v_rank_terms ->> 'feed_term')::float8
        + (v_rank_terms ->> 'source_term')::float8
        + (v_rank_terms ->> 'freshness_term')::float8;
    v_delta := v_recomputed_key - v_card.rank_key;
    if abs(v_delta) > 0.000001 then
        return pg_catalog.jsonb_build_object(
            'card_id', p_event_card_id,
            'status', 'rank_mismatch',
            'exact', false,
            'rank_delta', v_delta,
            'written', false
        );
    end if;

    if p_write then
        update public.event_card_contexts
        set rank_input = v_rank_input,
            rank_input_hash = 'md5:' || pg_catalog.md5(v_rank_input::text),
            rank_terms = v_rank_terms,
            captured_rank_key = v_card.rank_key
        where event_card_id = p_event_card_id;
    end if;
    return pg_catalog.jsonb_build_object(
        'card_id', p_event_card_id,
        'status', 'exact',
        'exact', true,
        'rank_delta', v_delta,
        'written', p_write
    );
end
$fn$;

comment on function public.backfill_event_card_context is
    'Fail-closed upgrade for pre-receipt overview contexts. Missing membership is never reconstructed from mutable live state; source replay/regeneration is required.';

-- Version rows are advertised as immutable. Enforce that contract instead of
-- trusting callers not to rewrite the meaning of an old experiment config.
create function public.reject_rank_weight_mutation()
returns trigger
language plpgsql
set search_path = ''
as $fn$
begin
    raise exception 'versioned rank weights are immutable'
        using errcode = '55000';
end
$fn$;

create trigger publisher_weights_immutable
before update or delete on public.publisher_weights
for each row execute function public.reject_rank_weight_mutation();

create trigger rubric_weights_immutable
before update or delete on public.rubric_weights
for each row execute function public.reject_rank_weight_mutation();

revoke all on function public.reject_rank_weight_mutation()
    from public, anon, authenticated, service_role;

-- Freeze the expected cohort beside the experiment so validation can prove
-- completeness without consulting a golden mirror that may later be replaced.
alter table public.rank_experiments
    add column expected_row_count integer,
    add column cohort_card_ids uuid[],
    add column cohort_context_hashes text[],
    add constraint rank_experiments_expected_cohort_consistent check (
        (expected_row_count is null
         and cohort_card_ids is null
         and cohort_context_hashes is null)
        or
        (expected_row_count >= 1
         and expected_row_count = cardinality(cohort_card_ids)
         and expected_row_count = cardinality(cohort_context_hashes)
         and array_position(cohort_card_ids, null) is null
         and array_position(cohort_context_hashes, null) is null)
    );

create or replace function public.protect_rank_experiment_payload()
returns trigger
language plpgsql
set search_path = ''
as $fn$
begin
    if new.id is distinct from old.id
       or new.rank_system_version_id is distinct from old.rank_system_version_id
       or new.name is distinct from old.name
       or new.pipeline_namespace is distinct from old.pipeline_namespace
       or new.source_run_id is distinct from old.source_run_id
       or new.parent_experiment_id is distinct from old.parent_experiment_id
       or new.rerun_of_experiment_id is distinct from old.rerun_of_experiment_id
       or new.validation_profile is distinct from old.validation_profile
       or new.config is distinct from old.config
       or new.config_hash is distinct from old.config_hash
       or new.preprocessing_config is distinct from old.preprocessing_config
       or new.data_cutoff_at is distinct from old.data_cutoff_at
       or new.data_snapshot_hash is distinct from old.data_snapshot_hash
       or new.context_set_hash is distinct from old.context_set_hash
       or new.code_commit is distinct from old.code_commit
       or new.started_at is distinct from old.started_at
       or new.expected_row_count is distinct from old.expected_row_count
       or new.cohort_card_ids is distinct from old.cohort_card_ids
       or new.cohort_context_hashes is distinct from old.cohort_context_hashes
       or new.created_at is distinct from old.created_at then
        raise exception 'rank experiment inputs and provenance are immutable'
            using errcode = '55000';
    end if;
    return new;
end
$fn$;

-- Extend the existing validator in-place with a preflight helper. The main
-- function calls this helper through an appended migration below.
create function public.rank_experiment_cohort_errors(p_experiment_id uuid)
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
    if v_experiment.validation_profile = 'full' then
        if v_experiment.expected_row_count is null
           or v_experiment.cohort_card_ids is null
           or v_experiment.cohort_context_hashes is null then
            v_errors := v_errors
                || '"full validation requires a frozen cohort manifest"'::jsonb;
        else
            select count(*)::integer into v_rows
            from public.snapshot_rank_rows
            where experiment_id = v_experiment.id
              and rank_system_version_id = v_experiment.rank_system_version_id;
            if v_rows <> v_experiment.expected_row_count then
                v_errors := v_errors
                    || '"snapshot row count does not match frozen cohort"'::jsonb;
            end if;
            if exists (
                select 1
                from unnest(
                    v_experiment.cohort_card_ids,
                    v_experiment.cohort_context_hashes
                ) expected(card_id, context_hash)
                left join public.snapshot_rank_rows ranked
                  on ranked.experiment_id = v_experiment.id
                 and ranked.rank_system_version_id = v_experiment.rank_system_version_id
                 and ranked.golden_event_card_id = expected.card_id
                 and ranked.context_hash = expected.context_hash
                where ranked.golden_event_card_id is null
            ) then
                v_errors := v_errors
                    || '"snapshot rows do not match frozen cohort manifest"'::jsonb;
            end if;
            if exists (
                select 1
                from public.snapshot_rank_rows ranked
                where ranked.experiment_id = v_experiment.id
                  and ranked.rank_system_version_id = v_experiment.rank_system_version_id
                  and (
                      ranked.context_snapshot ->> 'capture_method'
                          not in ('card_birth', 'source_run_replay')
                      or ranked.context_snapshot ->> 'source_run_id'
                          is distinct from v_experiment.source_run_id::text
                  )
            ) then
                v_errors := v_errors
                    || '"snapshot rows require exact matching source-run contexts"'::jsonb;
            end if;
        end if;
    end if;
    return v_errors;
end
$fn$;

-- Keep the original detailed validator and append cohort errors at its single
-- public call site. Renaming preserves its implementation without duplication.
alter function public.rank_experiment_validation_errors(uuid)
    rename to rank_experiment_row_errors;

create function public.rank_experiment_validation_errors(p_experiment_id uuid)
returns jsonb
language sql
stable
security definer
set search_path = ''
as $fn$
    select public.rank_experiment_row_errors(p_experiment_id)
        || public.rank_experiment_cohort_errors(p_experiment_id)
$fn$;

revoke all on function public.rank_experiment_row_errors(uuid)
    from public, anon, authenticated, service_role;
revoke all on function public.rank_experiment_cohort_errors(uuid)
    from public, anon, authenticated, service_role;
revoke all on function public.rank_experiment_validation_errors(uuid)
    from public, anon, authenticated, service_role;

commit;
