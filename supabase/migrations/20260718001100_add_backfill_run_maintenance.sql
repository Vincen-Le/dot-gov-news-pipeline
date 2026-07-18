begin;

create or replace function public.cancel_news_backfill_run(
    p_run_id uuid,
    p_reason text
)
returns boolean
language plpgsql
security definer
set search_path = ''
as $$
begin
    if p_run_id is null then
        raise exception using errcode = '22004', message = 'run ID is required';
    end if;
    if p_reason is null or length(pg_catalog.btrim(p_reason)) not between 1 and 4096 then
        raise exception using errcode = '22023', message = 'cancellation reason is invalid';
    end if;

    perform 1
    from public.news_backfill_runs
    where id = p_run_id and status in ('pending', 'running')
    for update;
    if not found then
        return false;
    end if;

    update public.news_backfill_targets
    set status = 'cancelled',
        stop_reason = 'run_cancelled',
        last_error_code = 'run_cancelled',
        last_error_detail = left(pg_catalog.btrim(p_reason), 4096),
        completed_at = pg_catalog.now(),
        updated_at = pg_catalog.now()
    where run_id = p_run_id and status in ('pending', 'running');

    update public.news_backfill_runs
    set status = 'cancelled',
        completed_at = pg_catalog.now(),
        updated_at = pg_catalog.now()
    where id = p_run_id;

    return true;
end;
$$;

create or replace function public.purge_cancelled_backfill_target_entries(
    p_target_id uuid
)
returns integer
language plpgsql
security definer
set search_path = ''
as $$
declare
    v_target public.news_backfill_targets%rowtype;
    v_entry_ids uuid[];
    v_deleted integer := 0;
begin
    if p_target_id is null then
        raise exception using errcode = '22004', message = 'target ID is required';
    end if;

    select * into strict v_target
    from public.news_backfill_targets
    where id = p_target_id
    for update;

    if v_target.status <> 'cancelled' then
        raise exception using errcode = '55000',
            message = 'only cancelled target entries can be purged';
    end if;

    select coalesce(pg_catalog.array_agg(candidate.news_entry_id), '{}'::uuid[])
    into v_entry_ids
    from (
        select distinct run_entry.news_entry_id
        from public.news_backfill_run_entries as run_entry
        join public.news_entries as entry
          on entry.id = run_entry.news_entry_id
        where run_entry.target_id = p_target_id
          and run_entry.disposition = 'inserted'
          and entry.news_source_id = v_target.news_source_id
          and not exists (
              select 1
              from public.news_backfill_run_entries as other
              where other.news_entry_id = run_entry.news_entry_id
                and other.target_id <> p_target_id
          )
    ) as candidate;

    delete from public.news_backfill_candidate_outcomes
    where target_id = p_target_id;
    delete from public.news_backfill_identity_conflicts
    where target_id = p_target_id;
    delete from public.news_backfill_run_entries
    where target_id = p_target_id;

    delete from public.news_entries
    where id = any(v_entry_ids);
    get diagnostics v_deleted = row_count;

    update public.news_backfill_targets
    set cursor = '{}'::jsonb,
        candidates_seen = 0,
        inserted_count = 0,
        existing_count = 0,
        rejected_count = 0,
        conflict_count = 0,
        oldest_published_at = null,
        newest_published_at = null,
        coverage_reached_at = null,
        coverage_evidence_artifact_key = null,
        last_error_code = 'corrective_purge',
        last_error_detail = 'Entries inserted by this cancelled target were purged before a corrected rerun.',
        updated_at = pg_catalog.now()
    where id = p_target_id;

    return v_deleted;
end;
$$;

comment on function public.cancel_news_backfill_run(uuid, text) is
    'Service-only terminal cancellation for an interrupted or superseded historical backfill run.';
comment on function public.purge_cancelled_backfill_target_entries(uuid) is
    'Service-only corrective purge of entries exclusively inserted by one cancelled target.';

revoke execute on function public.cancel_news_backfill_run(uuid, text)
    from public, anon, authenticated;
revoke execute on function public.purge_cancelled_backfill_target_entries(uuid)
    from public, anon, authenticated;
grant execute on function public.cancel_news_backfill_run(uuid, text)
    to service_role;
grant execute on function public.purge_cancelled_backfill_target_entries(uuid)
    to service_role;

commit;
