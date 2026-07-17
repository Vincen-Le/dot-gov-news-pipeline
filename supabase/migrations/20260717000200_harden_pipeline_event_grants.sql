begin;

revoke all privileges on table public.pipeline_events
    from anon, authenticated, service_role;

grant select, insert, update on table public.pipeline_events
    to service_role;

commit;
