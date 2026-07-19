begin;

select plan(6);

select has_table('public', 'publisher_weights', 'publisher_weights exists');

select is(
    (select count(*)::integer from public.publisher_weights where weight_version = 1),
    30,
    'v1 seeds thirty tiered publishers'
);

select is(
    (select weight::numeric from public.publisher_weights
     where weight_version = 1 and publisher_key = 'doj'),
    3.0::numeric,
    'cabinet tier weighs 3.0'
);

select has_function(
    'public', 'attach_entry_to_episode',
    array['uuid', 'uuid', 'text', 'boolean', 'text', 'real', 'uuid', 'real',
          'text', 'bytea', 'timestamptz', 'integer'],
    'attach_entry_to_episode carries p_publisher_weight_version'
);

-- fixture: one fda-published source + entry, attach, weight recomputed
select lives_ok($setup$
    do $body$
    declare
        v_source uuid;
        v_entry uuid;
        v_episode uuid;
        v_storyline uuid;
    begin
        v_source := public.upsert_news_source(
            'https://pwtest.example.gov/rss.xml', 'rss', 'PW Test');
        insert into public.news_source_publishers (news_source_id, publisher_key)
        values (v_source, 'fda')
        on conflict (news_source_id) do update set publisher_key = 'fda';
        v_entry := public.ingest_news_entry(
            v_source,
            'https://pwtest.example.gov/a', 'https://pwtest.example.gov/a',
            'pw test entry', 'weight fixture',
            '2026-05-14T14:00:00Z', repeat('cd', 32),
            array['pwtest'], array[]::text[], 1);
        select t.episode_id, t.storyline_id into v_episode, v_storyline
        from public.create_episode_with_storyline(
            null, 'new_storyline', null, null, null, '2026-05-14T14:00:00Z') t;
        perform public.attach_entry_to_episode(
            v_entry, v_episode, 'fda', false, 'new_cluster',
            null, null, null, 'stub-bow-256', null,
            '2026-05-14T14:00:00Z', 1);
    end
    $body$;
$setup$, 'attach with publisher weight version executes');

select ok(
    abs((select s.source_weight_max from public.storylines s
         where s.id = (select ep.storyline_id from public.episodes ep
                       where ep.id = (select ee.episode_id from public.episode_entries ee
                                      join public.news_entries ne on ne.id = ee.entry_id
                                      where ne.url_canonical = 'https://pwtest.example.gov/a'))
        ) - 2.0) < 1e-6,
    'attach recomputes source_weight_max from the fda independent tier'
);

select * from finish();

rollback;
