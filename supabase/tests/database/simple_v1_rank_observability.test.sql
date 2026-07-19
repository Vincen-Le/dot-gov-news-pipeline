begin;

select plan(2);

select has_table('public', 'simple_v1_rank_snapshots', 'simple_v1_rank_snapshots exists');

insert into public.simple_v1_experiment_runs (id, name, started_at, finished_at)
values ('23222222-2222-4222-8222-222222222201', 'simple_v1 rank obs test',
        '2026-07-18T00:00:00Z', '2026-07-18T00:01:00Z');

insert into public.simple_v1_rank_snapshots
    (run_id, facet_type, facet_key, position, storyline_id, card_id,
     rank_key, terms, judged, headline, agencies, feeds, entry_count)
values
    ('23222222-2222-4222-8222-222222222201', 'global', '', 1,
     '23222222-2222-4222-8222-222222222202', '23222222-2222-4222-8222-222222222203',
     14000.5, '{"rubric_points": 4.0}'::jsonb, false, 'test headline', 1, 1, 1);

select is(
    (select count(*)::integer from public.simple_v1_rank_snapshots
     where run_id = '23222222-2222-4222-8222-222222222201'),
    1,
    'snapshot row round-trips'
);

select * from finish();

rollback;
