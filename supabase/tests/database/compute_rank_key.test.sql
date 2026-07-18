begin;

select plan(7);

select has_function(
    'public', 'compute_rank_key',
    array['jsonb', 'integer', 'integer', 'integer', 'real', 'timestamptz', 'double precision'],
    'compute_rank_key exists with expected signature'
);

select is(
    (select count(*)::integer from public.rubric_weights where rubric_version = 1),
    8,
    'rubric v1 seeds eight criteria'
);

-- prior for unjudged = half the total weight (8 * 1.0 / 2 = 4.0)
select ok(
    abs(
        public.compute_rank_key(null, null, 0, 0, 1.0, '2026-01-01T00:00:00Z'::timestamptz)
        - (4.0 + extract(epoch from '2026-01-01T00:00:00Z'::timestamptz) / 124600.0)
    ) < 1e-6,
    'null rubric scores the prior'
);

-- all-ones rubric beats the prior by the other half of the weights
select ok(
    public.compute_rank_key(
        '{"mass_impact":1,"health_safety":1,"economic":1,"policy_change":1,
          "rights_legal":1,"national_scope":1,"urgency":1,"novelty":1}'::jsonb,
        1, 0, 0, 1.0, '2026-01-01T00:00:00Z'::timestamptz)
    > public.compute_rank_key(null, null, 0, 0, 1.0, '2026-01-01T00:00:00Z'::timestamptz),
    'fully judged rubric outranks the prior'
);

select ok(
    public.compute_rank_key(null, null, 5, 5, 1.0, '2026-01-01T00:00:00Z'::timestamptz)
    > public.compute_rank_key(null, null, 0, 0, 1.0, '2026-01-01T00:00:00Z'::timestamptz),
    'corroboration terms increase the key'
);

select ok(
    public.compute_rank_key(null, null, 0, 0, 1.0, '2026-01-02T00:00:00Z'::timestamptz)
    > public.compute_rank_key(null, null, 0, 0, 1.0, '2026-01-01T00:00:00Z'::timestamptz),
    'fresher newest_entry_at increases the key'
);

-- boolean-typed bits also count
select ok(
    public.compute_rank_key('{"urgency":true}'::jsonb, 1, 0, 0, 1.0, '2026-01-01T00:00:00Z'::timestamptz)
    > public.compute_rank_key('{}'::jsonb, 1, 0, 0, 1.0, '2026-01-01T00:00:00Z'::timestamptz),
    'jsonb true counts as a set bit'
);

select * from finish();

rollback;
