begin;

select plan(12);

select has_function('public', 'upsert_news_source', array['text', 'text', 'text'],
    'upsert_news_source exists');
select has_function('public', 'ingest_news_entry',
    array['uuid', 'text', 'text', 'text', 'text', 'timestamptz', 'text', 'text[]', 'text[]', 'integer'],
    'ingest_news_entry exists');
select has_function('public', 'attach_entry_to_episode',
    array['uuid', 'uuid', 'text', 'boolean', 'text', 'real', 'uuid', 'real', 'text', 'bytea', 'timestamptz', 'integer'],
    'attach_entry_to_episode exists');

-- happy path: source -> entry -> episode+storyline -> attach -> card
select lives_ok($setup$
    do $body$
    declare
        v_source uuid;
        v_entry uuid;
        v_episode uuid;
        v_storyline uuid;
        v_card uuid;
    begin
        v_source := public.upsert_news_source('https://example.gov/feed.xml', 'rss', 'Example');
        v_entry := public.ingest_news_entry(
            v_source,
            'https://example.gov/a?utm=1', 'https://example.gov/a',
            'FDA recalls Valsatrex', 'Sundexo Pharmaceuticals recall.',
            '2026-05-14T14:30:00Z', repeat('ab', 32),
            array['valsatrex', 'sundexo'], array['z-2026-0143'], 1);
        select t.episode_id, t.storyline_id into v_episode, v_storyline
        from public.create_episode_with_storyline(
            null, 'new_storyline', null, null, null, '2026-05-14T14:30:00Z') t;
        perform public.attach_entry_to_episode(
            v_entry, v_episode, 'fda.gov', false, 'new_cluster',
            null, null, null, 'stub', null, '2026-05-14T14:30:00Z');
        v_card := public.insert_event_card(
            v_storyline, v_episode, 'episode',
            'FDA recalls Valsatrex', 'Recall pulse.', null,
            null, null, null, v_entry, 'stub-judge', 1, null);
        if v_card is null then raise exception 'card not created'; end if;
    end
    $body$;
$setup$, 'full write path executes');

select is(
    (select count(*)::integer from public.news_entries where url_canonical = 'https://example.gov/a'),
    1, 'entry landed');

-- scope every lookup to the fixture rows: the local bench db may hold a live
-- corpus, so "limit 1" over a whole table picks an arbitrary non-fixture row
select ok(
    (select entry_count = 1 and cardinality(entity_set) = 2 and 'z-2026-0143' = any(event_keys)
     from public.episodes
     where id = (select ee.episode_id from public.episode_entries ee
                 join public.news_entries ne on ne.id = ee.entry_id
                 where ne.url_canonical = 'https://example.gov/a')),
    'episode aggregates recomputed from junction');

select ok(
    (select entry_count = 1 and episode_count = 1 and distinct_feeds = 1
        and 'fda.gov' = any(agency_ids) and 'valsatrex' = any(entity_set)
     from public.storylines
     where id = (select ep.storyline_id from public.episodes ep
                 where ep.id = (select ee.episode_id from public.episode_entries ee
                                join public.news_entries ne on ne.id = ee.entry_id
                                where ne.url_canonical = 'https://example.gov/a'))),
    'storyline aggregates recomputed');

select ok(
    (select daily_ema > 0 and total_count = 1 from public.entity_stats where entity = 'valsatrex'),
    'entity_stats upserted on ingest');

select is(
    public.ingest_news_entry(
        (select id from public.news_sources
         where canonical_url = 'https://example.gov/feed.xml'),
        'https://example.gov/a', 'https://example.gov/a', 'dup', 'dup',
        '2026-05-14T15:00:00Z', repeat('cd', 32), '{}', '{}', 1),
    null, 'duplicate url_canonical returns null');

-- replay safety: same attach twice does not double-count
select lives_ok($replay$
    select public.attach_entry_to_episode(
        (select id from public.news_entries where url_canonical = 'https://example.gov/a'),
        (select ee.episode_id from public.episode_entries ee
         join public.news_entries ne on ne.id = ee.entry_id
         where ne.url_canonical = 'https://example.gov/a'),
        'fda.gov', false, 'new_cluster', null, null, null, 'stub', null,
        '2026-05-14T14:30:00Z')
$replay$, 'replayed attach is a no-op');

select ok(
    (select entry_count = 1 from public.episodes
     where id = (select ee.episode_id from public.episode_entries ee
                 join public.news_entries ne on ne.id = ee.entry_id
                 where ne.url_canonical = 'https://example.gov/a')),
    'replay did not inflate entry_count');

select ok(
    not has_function_privilege('anon',
        'public.ingest_news_entry(uuid, text, text, text, text, timestamptz, text, text[], text[], integer)',
        'execute'),
    'anon cannot execute write RPCs');

select * from finish();

rollback;
