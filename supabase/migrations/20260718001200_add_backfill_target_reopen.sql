begin;

create or replace function public.reopen_news_backfill_target(
    p_target_id uuid,
    p_reason text
)
returns boolean
language plpgsql
security definer
set search_path = ''
as $$
declare
    v_target public.news_backfill_targets%rowtype;
    v_run_status text;
begin
    if p_target_id is null then
        raise exception using errcode = '22004', message = 'target ID is required';
    end if;
    if p_reason is null or length(pg_catalog.btrim(p_reason)) not between 1 and 4096 then
        raise exception using errcode = '22023', message = 'reopen reason is invalid';
    end if;

    select target.* into strict v_target
    from public.news_backfill_targets as target
    where target.id = p_target_id
    for update;

    select run.status into strict v_run_status
    from public.news_backfill_runs as run
    where run.id = v_target.run_id
    for update;

    if v_run_status not in ('pending', 'running') then
        raise exception using errcode = '55000',
            message = 'target run is already terminal';
    end if;
    if v_target.status not in ('succeeded', 'partial', 'failed') then
        raise exception using errcode = '55000',
            message = 'only terminal non-cancelled targets can be reopened';
    end if;

    delete from public.news_backfill_candidate_outcomes
    where target_id = p_target_id;
    delete from public.news_backfill_identity_conflicts
    where target_id = p_target_id;
    delete from public.news_backfill_run_entries
    where target_id = p_target_id;

    update public.news_backfill_targets
    set status = 'running',
        cursor = '{}'::jsonb,
        candidates_seen = 0,
        inserted_count = 0,
        existing_count = 0,
        rejected_count = 0,
        conflict_count = 0,
        oldest_published_at = null,
        newest_published_at = null,
        coverage_reached_at = null,
        coverage_evidence_artifact_key = null,
        stop_reason = null,
        last_error_code = 'corrective_reopen',
        last_error_detail = left(pg_catalog.btrim(p_reason), 4096),
        completed_at = null,
        updated_at = pg_catalog.now()
    where id = p_target_id;

    return true;
end;
$$;

comment on function public.reopen_news_backfill_target(uuid, text) is
    'Service-only reset of one terminal target in an active run so corrected extraction code can replay it without changing the fixed manifest.';

revoke execute on function public.reopen_news_backfill_target(uuid, text)
    from public, anon, authenticated;
grant execute on function public.reopen_news_backfill_target(uuid, text)
    to service_role;

commit;
