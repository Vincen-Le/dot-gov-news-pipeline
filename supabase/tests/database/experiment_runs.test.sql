-- supabase/tests/database/experiment_runs.test.sql
begin;

select plan(4);

select has_table('public', 'complex_v1_experiment_runs', 'complex_v1 experiment runs table exists');

select ok(
    (
        select relrowsecurity
        from pg_catalog.pg_class
        join pg_catalog.pg_namespace
          on pg_namespace.oid = pg_class.relnamespace
        where pg_namespace.nspname = 'public'
          and pg_class.relname = 'complex_v1_experiment_runs'
    ),
    'RLS enabled on complex_v1_experiment_runs'
);

select ok(
    not has_table_privilege('anon', 'public.complex_v1_experiment_runs', 'select')
    and has_table_privilege('service_role', 'public.complex_v1_experiment_runs', 'select')
    and not has_table_privilege('service_role', 'public.complex_v1_experiment_runs', 'insert'),
    'grants: service_role read-only, anon nothing'
);

select throws_ok(
    $$insert into public.complex_v1_experiment_runs (name, started_at, finished_at)
      values ('', now(), now())$$,
    '23514',
    null,
    'empty name rejected'
);

select * from finish();

rollback;
