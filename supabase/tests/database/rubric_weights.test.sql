begin;

select plan(5);

select has_table('public', 'rubric_weights', 'rubric_weights table exists');

select ok(
    (
        select relrowsecurity
        from pg_catalog.pg_class
        join pg_catalog.pg_namespace
          on pg_namespace.oid = pg_class.relnamespace
        where pg_namespace.nspname = 'public'
          and pg_class.relname = 'rubric_weights'
    ),
    'RLS enabled on rubric_weights'
);

select lives_ok(
    $$insert into public.rubric_weights (rubric_version, criterion, weight)
      values (1, 'public_safety_impact', 2.0)$$,
    'weight row inserts'
);

select throws_ok(
    $$insert into public.rubric_weights (rubric_version, criterion, weight)
      values (1, 'public_safety_impact', 3.0)$$,
    '23505',
    null,
    'duplicate (version, criterion) rejected'
);

select throws_ok(
    $$insert into public.rubric_weights (rubric_version, criterion, weight)
      values (0, 'x', 1.0)$$,
    '23514',
    null,
    'rubric_version below 1 rejected'
);

select * from finish();

rollback;
