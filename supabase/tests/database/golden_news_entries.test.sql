begin;

select plan(8);

select has_table(
    'public', 'golden_news_entries',
    'golden_news_entries table exists'
);

select ok(
    (
        select relrowsecurity
        from pg_catalog.pg_class relations
        join pg_catalog.pg_namespace namespaces
          on namespaces.oid = relations.relnamespace
        where namespaces.nspname = 'public'
          and relations.relname = 'golden_news_entries'
    ),
    'RLS is enabled'
);

select ok(
    has_table_privilege('service_role', 'public.golden_news_entries', 'select')
    and has_table_privilege('service_role', 'public.golden_news_entries', 'insert')
    and has_table_privilege('service_role', 'public.golden_news_entries', 'update')
    and has_table_privilege('service_role', 'public.golden_news_entries', 'delete')
    and not has_table_privilege('anon', 'public.golden_news_entries', 'select'),
    'golden labels are service-writable and unavailable to clients'
);

insert into public.news_sources (id, canonical_url, source_type)
values (
    '00000000-0000-4000-8000-00000000f401',
    'https://golden-labels.example.gov/feed.xml',
    'rss'
);

insert into public.news_entries (
    id, news_source_id, url, url_canonical, content_hash, title, published_at
) values (
    '00000000-0000-4000-8000-00000000f402',
    '00000000-0000-4000-8000-00000000f401',
    'https://golden-labels.example.gov/1',
    'https://golden-labels.example.gov/1',
    repeat('ab', 32),
    'Golden fixture',
    '2025-07-18T00:00:00Z'
);

insert into public.golden_news_entries (
    news_entry_id, content_hash_at_review, ordinal, batch_number
) values (
    '00000000-0000-4000-8000-00000000f402', repeat('ab', 32), 1, 1
);

select is(
    (select review_status from public.golden_news_entries
     where news_entry_id = '00000000-0000-4000-8000-00000000f402'),
    'pending',
    'new rows begin pending'
);

select throws_ok(
    $$update public.golden_news_entries
      set review_status = 'reviewed', reviewed_at = now()
      where news_entry_id = '00000000-0000-4000-8000-00000000f402'$$,
    '23514',
    null,
    'reviewed rows require the complete hierarchy'
);

select lives_ok(
    $$update public.golden_news_entries set
          review_status = 'reviewed',
          gold_episode_id = '00000000-0000-4000-8000-00000000f410',
          gold_episode_label = 'Golden episode',
          gold_storyline_id = '00000000-0000-4000-8000-00000000f411',
          gold_storyline_label = 'Golden storyline',
          gold_theme_id = '00000000-0000-4000-8000-00000000f412',
          gold_theme_name = 'Golden theme',
          gold_category_id = (select id from public.topic_categories
                              where origin = 'seed' order by display_name limit 1),
          reviewed_at = now()
      where news_entry_id = '00000000-0000-4000-8000-00000000f402'$$,
    'a complete hierarchy can be reviewed'
);

select is(
    (select batch_number from public.golden_news_entries
     where news_entry_id = '00000000-0000-4000-8000-00000000f402'),
    1,
    'batch membership is stored with the label row'
);

select throws_ok(
    $$delete from public.news_entries
      where id = '00000000-0000-4000-8000-00000000f402'$$,
    '23503',
    null,
    'golden membership protects its source news entry'
);

select * from finish();

rollback;
