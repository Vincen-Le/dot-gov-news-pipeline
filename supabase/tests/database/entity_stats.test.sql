begin;

select plan(6);

select has_table('public', 'entity_stats', 'entity_stats table exists');

select ok(
    (
        select relrowsecurity
        from pg_catalog.pg_class
        join pg_catalog.pg_namespace
          on pg_namespace.oid = pg_class.relnamespace
        where pg_namespace.nspname = 'public'
          and pg_class.relname = 'entity_stats'
    ),
    'RLS enabled on entity_stats'
);

select ok(
    not has_table_privilege('anon', 'public.entity_stats', 'select')
    and has_table_privilege('service_role', 'public.entity_stats', 'select')
    and not has_table_privilege('service_role', 'public.entity_stats', 'insert'),
    'grants: service_role read-only, anon nothing'
);

select lives_ok(
    $$insert into public.entity_stats (entity) values ('valsatrex')$$,
    'minimal insert works with defaults'
);

select throws_ok(
    $$insert into public.entity_stats (entity) values ('')$$,
    '23514',
    null,
    'empty entity rejected'
);

select throws_ok(
    $$insert into public.entity_stats (entity, daily_ema) values ('fda', -1.0)$$,
    '23514',
    null,
    'negative daily_ema rejected'
);

select * from finish();

rollback;
