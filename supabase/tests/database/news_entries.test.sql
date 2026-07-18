begin;

select plan(10);

select has_table('public', 'news_entries', 'news_entries table exists');

select ok(
    (
        select relrowsecurity
        from pg_catalog.pg_class
        join pg_catalog.pg_namespace
          on pg_namespace.oid = pg_class.relnamespace
        where pg_namespace.nspname = 'public'
          and pg_class.relname = 'news_entries'
    ),
    'RLS enabled on news_entries'
);

select ok(
    not has_table_privilege('anon', 'public.news_entries', 'select')
    and not has_table_privilege('authenticated', 'public.news_entries', 'select'),
    'anon and authenticated cannot read news_entries'
);

select ok(
    has_table_privilege('service_role', 'public.news_entries', 'select')
    and not has_table_privilege('service_role', 'public.news_entries', 'insert'),
    'service_role is read-only on news_entries'
);

-- constraint behavior: use a fixture source
insert into public.news_sources (id, canonical_url, source_type)
values ('00000000-0000-0000-0000-00000000feed', 'https://example.gov/feed.xml', 'rss');

select lives_ok(
    $$insert into public.news_entries
        (news_source_id, url, url_canonical, title, summary, content_hash, published_at)
      values
        ('00000000-0000-0000-0000-00000000feed',
         'https://example.gov/a?utm=1', 'https://example.gov/a',
         'FDA recalls Valsatrex', 'Contamination found.',
         repeat('ab', 32), now())$$,
    'valid entry inserts'
);

select throws_ok(
    $$insert into public.news_entries
        (news_source_id, url, url_canonical, content_hash)
      values
        ('00000000-0000-0000-0000-00000000feed',
         'https://example.gov/b', 'https://example.gov/a',
         repeat('cd', 32))$$,
    '23505',
    null,
    'duplicate url_canonical rejected'
);

select throws_ok(
    $$insert into public.news_entries
        (news_source_id, url, url_canonical, content_hash)
      values
        ('00000000-0000-0000-0000-00000000feed',
         'https://example.gov/c', 'https://example.gov/c', 'not-a-sha')$$,
    '23514',
    null,
    'malformed content_hash rejected'
);

select throws_ok(
    $$insert into public.news_entries
        (news_source_id, url, url_canonical, content_hash, embedding)
      values
        ('00000000-0000-0000-0000-00000000feed',
         'https://example.gov/d', 'https://example.gov/d',
         repeat('ef', 32), '\x0102')$$,
    '23514',
    null,
    'embedding without embedding_model rejected'
);

select ok(
    exists (
        select 1 from pg_catalog.pg_indexes
        where schemaname = 'public' and tablename = 'news_entries'
          and indexdef like '%gin%entity_set%'
    ),
    'GIN index on entity_set exists'
);

select ok(
    exists (
        select 1 from pg_catalog.pg_indexes
        where schemaname = 'public' and tablename = 'news_entries'
          and indexdef like '%gin%event_keys%'
    ),
    'GIN index on event_keys exists'
);

select * from finish();

rollback;
