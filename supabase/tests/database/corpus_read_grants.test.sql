begin;

select plan(9);

set local role anon;

select lives_ok(
    'select id from public.news_sources limit 1',
    'anon can select news_sources');
select lives_ok(
    'select news_source_id from public.news_source_publishers limit 1',
    'anon can select news_source_publishers');
select lives_ok(
    'select id from public.news_entries limit 1',
    'anon can select news_entries');

select throws_ok(
    'select id from public.pipeline_events limit 1',
    '42501', null, 'anon cannot select pipeline_events');
select throws_ok(
    'select id from public.experiment_runs limit 1',
    '42501', null, 'anon cannot select experiment_runs');
select throws_ok(
    'select id from public.storylines limit 1',
    '42501', null, 'anon cannot select storylines');
select throws_ok(
    'insert into public.news_entries (id) values (null)',
    '42501', null, 'anon cannot insert news_entries');

reset role;
set local role corpus_reader;

select lives_ok(
    'select id from public.news_entries limit 1',
    'corpus_reader can select news_entries');
select throws_ok(
    'select id from public.pipeline_events limit 1',
    '42501', null, 'corpus_reader cannot select pipeline_events');

reset role;
select * from finish();
rollback;
