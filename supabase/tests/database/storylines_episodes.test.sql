begin;

select plan(12);

select has_table('public', 'storylines', 'storylines table exists');
select has_table('public', 'episodes', 'episodes table exists');
select has_table('public', 'episode_entries', 'episode_entries table exists');

select has_column('public', 'news_entries', 'episode_id',
    'news_entries gained denormalized episode_id');

select is(
    (
        select count(*)::integer
        from pg_catalog.pg_class
        join pg_catalog.pg_namespace
          on pg_namespace.oid = pg_class.relnamespace
        where pg_namespace.nspname = 'public'
          and pg_class.relname in ('storylines', 'episodes', 'episode_entries')
          and pg_class.relrowsecurity
    ),
    3,
    'RLS enabled on all three tables'
);

select ok(
    not has_table_privilege('anon', 'public.storylines', 'select')
    and not has_table_privilege('anon', 'public.episodes', 'select')
    and not has_table_privilege('anon', 'public.episode_entries', 'select'),
    'anon cannot read clustering tables'
);

-- fixtures
insert into public.storylines (id, first_entry_at, newest_entry_at)
values ('00000000-0000-0000-0000-000000000051', now(), now());

select lives_ok(
    $$insert into public.episodes
        (id, storyline_id, first_entry_at, newest_entry_at, attach_method)
      values
        ('00000000-0000-0000-0000-0000000000e1',
         '00000000-0000-0000-0000-000000000051',
         now(), now(), 'new_storyline')$$,
    'episode with valid attach_method inserts'
);

select throws_ok(
    $$insert into public.episodes
        (storyline_id, first_entry_at, newest_entry_at, attach_method)
      values
        ('00000000-0000-0000-0000-000000000051',
         now(), now(), 'vibes')$$,
    '23514',
    null,
    'invalid episode attach_method rejected'
);

select throws_ok(
    $$insert into public.episodes
        (storyline_id, status, first_entry_at, newest_entry_at, attach_method)
      values
        ('00000000-0000-0000-0000-000000000051',
         'closed', now(), now(), 'new_storyline')$$,
    '23514',
    null,
    'invalid episode status rejected'
);

insert into public.news_sources (id, canonical_url, source_type)
values ('00000000-0000-0000-0000-00000000fee2', 'https://example.gov/f2.xml', 'rss');
insert into public.news_entries (id, news_source_id, url, url_canonical, content_hash)
values ('00000000-0000-0000-0000-0000000000a1',
        '00000000-0000-0000-0000-00000000fee2',
        'https://example.gov/x', 'https://example.gov/x', repeat('aa', 32));

select lives_ok(
    $$insert into public.episode_entries
        (episode_id, entry_id, attach_method, similarity, threshold_used, embedding_model)
      values
        ('00000000-0000-0000-0000-0000000000e1',
         '00000000-0000-0000-0000-0000000000a1',
         'near_dup', 0.95, 0.93, 'bge-large-en-v1.5')$$,
    'junction row with audit evidence inserts'
);

select throws_ok(
    $$insert into public.episode_entries (episode_id, entry_id, attach_method)
      values
        ('00000000-0000-0000-0000-0000000000e1',
         '00000000-0000-0000-0000-0000000000a1',
         'exact_url')$$,
    '23505',
    null,
    'duplicate membership rejected'
);

select ok(
    exists (
        select 1 from pg_catalog.pg_indexes
        where schemaname = 'public' and tablename = 'storylines'
          and indexdef like '%gin%entity_set%'
    )
    and exists (
        select 1 from pg_catalog.pg_indexes
        where schemaname = 'public' and tablename = 'storylines'
          and indexdef like '%gin%event_keys%'
    ),
    'storyline candidate-generation GIN indexes exist'
);

select * from finish();

rollback;
