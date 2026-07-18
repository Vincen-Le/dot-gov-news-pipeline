begin;

create or replace function public.resume_news_backfill_run(
    p_run_id uuid,
    p_reason text
)
returns boolean
language plpgsql
security definer
set search_path = ''
as $$
declare
    v_status text;
begin
    if p_run_id is null then
        raise exception using errcode = '22004', message = 'run ID is required';
    end if;
    if p_reason is null or length(pg_catalog.btrim(p_reason)) not between 1 and 4096 then
        raise exception using errcode = '22023', message = 'resume reason is invalid';
    end if;

    select status into strict v_status
    from public.news_backfill_runs
    where id = p_run_id
    for update;

    if v_status not in ('succeeded', 'partial', 'failed') then
        raise exception using errcode = '55000',
            message = 'only terminal non-cancelled runs can be resumed';
    end if;
    if exists (
        select 1
        from public.news_backfill_targets
        where run_id = p_run_id and status in ('pending', 'running')
    ) then
        raise exception using errcode = '55000',
            message = 'terminal run unexpectedly has active targets';
    end if;

    update public.news_backfill_runs
    set status = 'running',
        counters = counters || pg_catalog.jsonb_build_object(
            'corrective_resume_reason',
            left(pg_catalog.btrim(p_reason), 4096)
        ),
        completed_at = null,
        updated_at = pg_catalog.now()
    where id = p_run_id;

    return true;
end;
$$;

comment on function public.resume_news_backfill_run(uuid, text) is
    'Service-only transition of one non-cancelled terminal run back to running so a corrected terminal target can be reopened and replayed.';

revoke execute on function public.resume_news_backfill_run(uuid, text)
    from public, anon, authenticated;
grant execute on function public.resume_news_backfill_run(uuid, text)
    to service_role;

commit;
