begin;

select plan(5);

select has_table('public', 'rank_snapshots', 'rank_snapshots exists');
select has_table('public', 'rank_audit_pairs', 'rank_audit_pairs exists');
select has_table('public', 'rank_audit_runs', 'rank_audit_runs exists');

insert into public.complex_v1_experiment_runs (id, name, started_at, finished_at)
values ('22222222-2222-4222-8222-222222222201', 'rank obs test',
        '2026-07-18T00:00:00Z', '2026-07-18T00:01:00Z');

insert into public.rank_snapshots
    (run_id, facet_type, facet_key, position, storyline_id, card_id,
     rank_key, terms, judged, headline, agencies, feeds, entry_count)
values
    ('22222222-2222-4222-8222-222222222201', 'global', '', 1,
     '22222222-2222-4222-8222-222222222202', '22222222-2222-4222-8222-222222222203',
     14000.5, '{"rubric_points": 4.0}'::jsonb, false, 'test headline', 1, 1, 1);

select is(
    (select count(*)::integer from public.rank_snapshots
     where run_id = '22222222-2222-4222-8222-222222222201'),
    1,
    'snapshot row round-trips'
);

select throws_ok(
    $$insert into public.rank_audit_pairs
        (run_id, facet_type, facet_key, position_a, position_b,
         storyline_a, storyline_b, llm_prefers)
      values ('22222222-2222-4222-8222-222222222201', 'global', '', 2, 1,
              '22222222-2222-4222-8222-222222222202',
              '22222222-2222-4222-8222-222222222202', 'a')$$,
    '23514',
    null,
    'position_a must precede position_b'
);

select * from finish();

rollback;
