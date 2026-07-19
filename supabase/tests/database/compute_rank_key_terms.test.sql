begin;

select plan(4);

select has_function(
    'public', 'compute_rank_key_terms',
    array['jsonb', 'integer', 'integer', 'integer', 'real', 'timestamptz', 'double precision'],
    'compute_rank_key_terms exists with expected signature'
);

-- terms sum to the key: unjudged input
select ok(
    abs(
        (select ((t ->> 'rubric_points')::float8 + (t ->> 'agency_term')::float8
               + (t ->> 'feed_term')::float8 + (t ->> 'source_term')::float8
               + (t ->> 'freshness_term')::float8)
         from public.compute_rank_key_terms(
             null, null, 3, 5, 2.0, '2026-01-01T00:00:00Z'::timestamptz) as t)
        - public.compute_rank_key(null, null, 3, 5, 2.0, '2026-01-01T00:00:00Z'::timestamptz)
    ) < 1e-9,
    'terms sum equals compute_rank_key for unjudged input'
);

-- terms sum to the key: judged input
select ok(
    abs(
        (select ((t ->> 'rubric_points')::float8 + (t ->> 'agency_term')::float8
               + (t ->> 'feed_term')::float8 + (t ->> 'source_term')::float8
               + (t ->> 'freshness_term')::float8)
         from public.compute_rank_key_terms(
             '{"mass_impact":1,"health_safety":1}'::jsonb,
             1, 2, 2, 1.5, '2026-03-01T00:00:00Z'::timestamptz) as t)
        - public.compute_rank_key(
             '{"mass_impact":1,"health_safety":1}'::jsonb,
             1, 2, 2, 1.5, '2026-03-01T00:00:00Z'::timestamptz)
    ) < 1e-9,
    'terms sum equals compute_rank_key for judged input'
);

select is(
    (select (public.compute_rank_key_terms(
        null, null, 0, 0, 1.0, '2026-01-01T00:00:00Z'::timestamptz) ->> 'prior_used')::boolean),
    true,
    'null rubric flags prior_used'
);

select * from finish();

rollback;
