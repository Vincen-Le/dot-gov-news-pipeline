begin;

create table public.pipeline_events (
    id uuid primary key,
    schema_version smallint not null,
    event_type text not null,
    idempotency_key text not null unique,
    occurred_at timestamptz not null,
    payload jsonb not null default '{}'::jsonb,
    artifact_key text,
    created_at timestamptz not null default now(),
    constraint pipeline_events_schema_version_positive
        check (schema_version > 0),
    constraint pipeline_events_event_type_not_empty
        check (length(btrim(event_type)) > 0),
    constraint pipeline_events_idempotency_key_not_empty
        check (length(btrim(idempotency_key)) > 0),
    constraint pipeline_events_payload_is_object
        check (jsonb_typeof(payload) = 'object'),
    constraint pipeline_events_artifact_key_not_empty
        check (artifact_key is null or length(btrim(artifact_key)) > 0)
);

comment on table public.pipeline_events is
    'Versioned, idempotent transport events persisted by the pipeline worker.';

create index pipeline_events_type_occurred_at_idx
    on public.pipeline_events (event_type, occurred_at desc);

create index pipeline_events_created_at_idx
    on public.pipeline_events (created_at);

alter table public.pipeline_events enable row level security;

revoke all privileges on table public.pipeline_events from anon, authenticated;
grant select, insert, update on table public.pipeline_events to service_role;

commit;
