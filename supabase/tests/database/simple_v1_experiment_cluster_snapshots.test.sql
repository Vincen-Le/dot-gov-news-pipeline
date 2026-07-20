-- supabase/tests/database/simple_v1_experiment_cluster_snapshots.test.sql
begin;

select plan(10);

select has_table(
    'public',
    'simple_v1_experiment_cluster_snapshots',
    'simple_v1 experiment cluster snapshots table exists'
);

select ok(
    (
        select relrowsecurity
        from pg_catalog.pg_class
        join pg_catalog.pg_namespace
          on pg_namespace.oid = pg_class.relnamespace
        where pg_namespace.nspname = 'public'
          and pg_class.relname = 'simple_v1_experiment_cluster_snapshots'
    ),
    'RLS enabled on experiment cluster snapshots'
);

select ok(
    not has_table_privilege('anon', 'public.simple_v1_experiment_cluster_snapshots', 'select')
    and has_table_privilege('service_role', 'public.simple_v1_experiment_cluster_snapshots', 'select')
    and has_table_privilege('service_role', 'public.simple_v1_experiment_cluster_snapshots', 'insert')
    and has_table_privilege('service_role', 'public.simple_v1_experiment_cluster_snapshots', 'update')
    and has_table_privilege('service_role', 'public.simple_v1_experiment_cluster_snapshots', 'delete'),
    'grants: service_role mirror writes, anon nothing'
);

insert into public.simple_v1_experiment_runs (id, name, started_at, finished_at)
values
    ('93000000-0000-4000-8000-000000000001', 'snapshot-one', now(), now()),
    ('93000000-0000-4000-8000-000000000002', 'snapshot-two', now(), now());

insert into public.storylines (
    id, first_entry_at, newest_entry_at, entry_count, episode_count
) values (
    '94000000-0000-4000-8000-000000000001', now(), now(), 0, 0
);

select lives_ok(
    $$select public.simple_v1_capture_experiment_cluster_snapshot(
        '93000000-0000-4000-8000-000000000001'
    )$$,
    'current clustering state can be captured once'
);

select is(
    (
        select (row_counts ->> 'storylines')::integer
        from public.simple_v1_experiment_cluster_snapshots
        where run_id = '93000000-0000-4000-8000-000000000001'
    ),
    1,
    'capture records auditable table counts'
);

select is(
    (
        select snapshot -> 'storylines' -> 0 ->> 'id'
        from public.simple_v1_experiment_cluster_snapshots
        where run_id = '93000000-0000-4000-8000-000000000001'
    ),
    '94000000-0000-4000-8000-000000000001',
    'capture stores the run-tagged clustering payload'
);

select throws_ok(
    $$select public.simple_v1_capture_experiment_cluster_snapshot(
        '93000000-0000-4000-8000-000000000001'
    )$$,
    '23505',
    null,
    'a run snapshot cannot be overwritten'
);

select throws_ok(
    $$update public.simple_v1_experiment_cluster_snapshots
      set snapshot = '{}'::jsonb
      where run_id = '93000000-0000-4000-8000-000000000001'$$,
    '55000',
    'simple_v1 experiment snapshot payloads are immutable',
    'captured clustering payload is immutable'
);

select public.simple_v1_capture_experiment_cluster_snapshot(
    '93000000-0000-4000-8000-000000000002'
);
select public.simple_v1_annotate_experiment_cluster_snapshot(
    '93000000-0000-4000-8000-000000000001',
    'incumbent configuration',
    '{"score": 0.68, "formula": "fixed-v1"}'::jsonb,
    true
);
select public.simple_v1_annotate_experiment_cluster_snapshot(
    '93000000-0000-4000-8000-000000000002',
    'challenger configuration',
    '{"score": 0.61, "formula": "fixed-v1"}'::jsonb,
    true
);

select is(
    (
        select count(*)::integer
        from public.simple_v1_experiment_cluster_snapshots
        where is_best
    ),
    1,
    'exactly one captured run is promoted as best'
);

select is(
    (
        select note || ':' || (reward ->> 'score')
        from public.simple_v1_experiment_cluster_snapshots
        where is_best
    ),
    'challenger configuration:0.61',
    'annotation stores note and reward metadata without changing the payload'
);

select * from finish();

rollback;
