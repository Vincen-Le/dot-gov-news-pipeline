begin;

truncate table
    public.news_sources,
    public.inventory_sync_runs,
    public.government_sites
cascade;

select plan(31);

select is(
    (
        select count(*)::integer
        from pg_catalog.pg_class
        join pg_catalog.pg_namespace
          on pg_namespace.oid = pg_class.relnamespace
        where pg_namespace.nspname = 'public'
          and pg_class.relname in (
              'news_sources',
              'government_site_news_sources',
              'news_source_fetch_state'
          )
          and pg_class.relkind = 'r'
    ),
    3,
    'creates all generalized news-source tables'
);

select is(
    (
        select count(*)::integer
        from pg_catalog.pg_class
        join pg_catalog.pg_namespace
          on pg_namespace.oid = pg_class.relnamespace
        where pg_namespace.nspname = 'public'
          and pg_class.relname in (
              'feeds',
              'government_site_feeds',
              'feed_fetch_state'
          )
    ),
    0,
    'removes every legacy feed relation'
);

select is(
    (
        select count(*)::integer
        from pg_catalog.pg_class
        join pg_catalog.pg_namespace
          on pg_namespace.oid = pg_class.relnamespace
        where pg_namespace.nspname = 'public'
          and pg_class.relname in (
              'news_sources',
              'government_site_news_sources',
              'news_source_fetch_state'
          )
          and pg_class.relrowsecurity
    ),
    3,
    'enables RLS on every generalized table'
);

select ok(
    not has_table_privilege(
        'anon',
        'public.government_site_news_sources',
        'select'
    )
    and not has_table_privilege(
        'anon',
        'public.news_source_fetch_state',
        'select'
    ),
    'anon cannot read non-corpus generalized source state'
);

select ok(
    not has_table_privilege('authenticated', 'public.news_sources', 'select')
    and not has_table_privilege(
        'authenticated',
        'public.government_site_news_sources',
        'select'
    )
    and not has_table_privilege(
        'authenticated',
        'public.news_source_fetch_state',
        'select'
    ),
    'authenticated cannot read generalized source state'
);

select ok(
    has_table_privilege('service_role', 'public.news_sources', 'select')
    and has_table_privilege(
        'service_role',
        'public.government_site_news_sources',
        'select'
    )
    and has_table_privilege(
        'service_role',
        'public.news_source_fetch_state',
        'select'
    ),
    'service_role can read generalized source state'
);

select ok(
    not has_table_privilege('service_role', 'public.news_sources', 'insert')
    and not has_table_privilege('service_role', 'public.news_sources', 'update')
    and not has_table_privilege('service_role', 'public.news_sources', 'delete')
    and not has_table_privilege(
        'service_role',
        'public.government_site_news_sources',
        'insert'
    )
    and not has_table_privilege(
        'service_role',
        'public.news_source_fetch_state',
        'insert'
    ),
    'service_role cannot bypass the RPC write boundary'
);

insert into public.inventory_sync_runs (
    id,
    source,
    source_url
) values (
    '30000000-0000-4000-8000-000000000001',
    'gsa_federal_website_index',
    'https://example.test/gsa.csv'
);

insert into public.government_sites (
    id,
    source,
    source_initial_url,
    initial_url,
    base_domain,
    top_level_domain,
    gsa_filtered,
    inventory_usable,
    inventory_active,
    source_row_hash,
    discovery_input_hash,
    last_sync_run_id
) values
    (
        '30000000-0000-4000-8000-000000000011',
        'gsa_federal_website_index',
        'news-one.example.gov',
        'news-one.example.gov',
        'example.gov',
        'gov',
        false,
        true,
        true,
        repeat('a', 64),
        repeat('b', 64),
        '30000000-0000-4000-8000-000000000001'
    ),
    (
        '30000000-0000-4000-8000-000000000012',
        'gsa_federal_website_index',
        'news-two.example.gov',
        'news-two.example.gov',
        'other.gov',
        'gov',
        false,
        true,
        true,
        repeat('c', 64),
        repeat('d', 64),
        '30000000-0000-4000-8000-000000000001'
    );

insert into public.site_discovery_state (
    site_id,
    status,
    next_discovery_at
) values
    (
        '30000000-0000-4000-8000-000000000011',
        'pending',
        now() - interval '2 minutes'
    ),
    (
        '30000000-0000-4000-8000-000000000012',
        'pending',
        now() - interval '1 minute'
    );

select lives_ok(
    $$
        insert into public.news_sources (canonical_url, source_type)
        values
            ('https://example.test/rss.xml', 'rss'),
            ('https://example.test/atom.xml', 'atom'),
            ('https://example.test/feed.json', 'json_feed'),
            ('https://example.test/api/news', 'publisher_api'),
            ('https://example.test/news/archive', 'html_archive'),
            ('https://example.test/sitemap.xml', 'sitemap')
    $$,
    'accepts every supported source type'
);

select throws_ok(
    $$
        insert into public.news_sources (canonical_url, source_type)
        values ('https://example.test/invalid', 'web_scrape')
    $$,
    '23514',
    null,
    'rejects unsupported source types'
);

insert into public.government_site_news_sources (
    site_id,
    news_source_id,
    discovery_method,
    discovery_url
)
select
    site.id,
    source.id,
    'manual',
    'https://example.test/source-catalog'
from public.government_sites as site
cross join public.news_sources as source
where source.canonical_url = 'https://example.test/rss.xml';

select is(
    (
        select count(*)::integer
        from public.government_site_news_sources
        where news_source_id = (
            select id
            from public.news_sources
            where canonical_url = 'https://example.test/rss.xml'
        )
    ),
    2,
    'preserves the many-to-many site/source relationship'
);

insert into public.news_source_fetch_state (
    news_source_id,
    status,
    next_fetch_at,
    lease_token,
    lease_owner,
    lease_until,
    etag,
    last_modified,
    failure_count
)
select
    id,
    'leased',
    '2026-07-18 12:00:00+00'::timestamptz,
    '30000000-0000-4000-8000-000000000021',
    '30000000-0000-4000-8000-000000000022',
    '2026-07-18 12:05:00+00'::timestamptz,
    'fixture-etag',
    'Fri, 18 Jul 2026 12:00:00 GMT',
    3
from public.news_sources
where canonical_url = 'https://example.test/atom.xml';

select is(
    (
        select row(
            status,
            next_fetch_at,
            lease_token,
            lease_owner,
            lease_until,
            etag,
            last_modified,
            failure_count
        )::text
        from public.news_source_fetch_state
        where news_source_id = (
            select id
            from public.news_sources
            where canonical_url = 'https://example.test/atom.xml'
        )
    ),
    row(
        'leased',
        '2026-07-18 12:00:00+00'::timestamptz,
        '30000000-0000-4000-8000-000000000021'::uuid,
        '30000000-0000-4000-8000-000000000022'::uuid,
        '2026-07-18 12:05:00+00'::timestamptz,
        'fixture-etag',
        'Fri, 18 Jul 2026 12:00:00 GMT',
        3
    )::text,
    'retains the complete fetch lease and validator state'
);

select is(
    (
        select count(*)::integer
        from pg_catalog.pg_indexes
        where schemaname = 'public'
          and indexname in (
              'news_sources_status_last_validated_idx',
              'government_site_news_sources_source_active_idx',
              'news_source_fetch_state_due_idx'
          )
    ),
    3,
    'creates the generalized scheduling and relationship indexes'
);

select ok(
    has_function_privilege(
        'service_role',
        'public.complete_site_discovery(uuid, uuid, text, jsonb, jsonb, integer)',
        'execute'
    ),
    'service_role can complete generalized discovery'
);

select ok(
    not has_function_privilege(
        'anon',
        'public.complete_site_discovery(uuid, uuid, text, jsonb, jsonb, integer)',
        'execute'
    ),
    'anon cannot complete generalized discovery'
);

select ok(
    pg_get_function_arguments(
        'public.complete_site_discovery(uuid,uuid,text,jsonb,jsonb,integer)'::regprocedure
    ) like '%p_sources jsonb%'
    and pg_get_function_arguments(
        'public.complete_site_discovery(uuid,uuid,text,jsonb,jsonb,integer)'::regprocedure
    ) not like '%p_feeds%',
    'uses the generalized completion payload name'
);

create temporary table claimed_first as
select *
from public.claim_due_site_discoveries(
    '30000000-0000-4000-8000-000000000031',
    1,
    300,
    false,
    1
);

select ok(
    public.complete_site_discovery(
        (select site_id from claimed_first),
        (select lease_token from claimed_first),
        'succeeded',
        jsonb_build_object(
            'final_url', 'https://news-one.example.gov/news',
            'http_status', 200,
            'duration_ms', 125
        ),
        jsonb_build_array(jsonb_build_object(
            'canonical_url', 'https://news-one.example.gov/api/releases',
            'source_type', 'publisher_api',
            'title', 'Release API',
            'home_page_url', 'https://news-one.example.gov/news',
            'http_status', 200,
            'discovery_method', 'api_documentation',
            'discovery_url', 'https://news-one.example.gov/developers',
            'adapter_config', jsonb_build_object('page_size', 50),
            'backfill_supported', true,
            'earliest_available_at', '2000-01-01T00:00:00Z',
            'latest_observed_at', '2026-07-18T00:00:00Z'
        )),
        2
    ),
    'generalized completion accepts a publisher API source'
);

select is(
    (
        select row(
            source_type,
            backfill_supported,
            adapter_config,
            earliest_available_at,
            latest_observed_at
        )::text
        from public.news_sources
        where canonical_url = 'https://news-one.example.gov/api/releases'
    ),
    row(
        'publisher_api',
        true,
        jsonb_build_object('page_size', 50),
        '2000-01-01T00:00:00Z'::timestamptz,
        '2026-07-18T00:00:00Z'::timestamptz
    )::text,
    'persists generalized adapter and backfill metadata'
);

select is(
    (
        select count(*)::integer
        from public.government_site_news_sources
        where site_id = (select site_id from claimed_first)
          and news_source_id = (
              select id
              from public.news_sources
              where canonical_url = 'https://news-one.example.gov/api/releases'
          )
    ),
    1,
    'completion persists site/source provenance'
);

select is(
    (
        select status
        from public.news_source_fetch_state
        where news_source_id = (
            select id
            from public.news_sources
            where canonical_url = 'https://news-one.example.gov/api/releases'
        )
    ),
    'pending',
    'completion seeds generalized fetch state'
);

select is(
    (
        select news_source_count
        from public.get_site_discovery_summary()
    ),
    (select count(*) from public.news_sources),
    'summary reports the generalized source count'
);

create temporary table claimed_second as
select *
from public.claim_due_site_discoveries(
    '30000000-0000-4000-8000-000000000032',
    1,
    300,
    false,
    1
);

select ok(
    public.complete_site_discovery(
        (select site_id from claimed_second),
        (select lease_token from claimed_second),
        'no_news_source',
        jsonb_build_object(
            'final_url', 'https://news-two.example.gov/',
            'http_status', 200,
            'duration_ms', 250,
            'checked_source_types', jsonb_build_array(
                'rss',
                'atom',
                'json_feed',
                'publisher_api',
                'html_archive',
                'sitemap'
            )
        ),
        '[]'::jsonb,
        2
    ),
    'only generalized discovery can record no-news-source evidence'
);

select is(
    (
        select status
        from public.site_discovery_state
        where site_id = (select site_id from claimed_second)
    ),
    'no_news_source',
    'stores the generalized no-source terminal state'
);

select is(
    (
        select last_checked_source_types
        from public.site_discovery_state
        where site_id = (select site_id from claimed_second)
    ),
    array[
        'atom',
        'html_archive',
        'json_feed',
        'publisher_api',
        'rss',
        'sitemap'
    ]::text[],
    'persists complete generalized adapter coverage'
);

select throws_ok(
    $$
        select public.complete_site_discovery(
            '30000000-0000-4000-8000-000000000012',
            '30000000-0000-4000-8000-000000000099',
            'no_news_source',
            jsonb_build_object(
                'checked_source_types',
                jsonb_build_array('rss', 'atom', 'json_feed')
            ),
            '[]'::jsonb,
            2
        )
    $$,
    '22023',
    'no-news-source completion requires every adapter check',
    'rejects syndication-only no-source evidence'
);

select ok(
    pg_get_constraintdef(
        (
            select oid
            from pg_catalog.pg_constraint
            where conrelid = 'public.site_discovery_state'::regclass
              and conname = 'site_discovery_state_status_valid'
        )
    ) not like '%no_feed%',
    'the discovery status constraint has no feed-only result'
);

select throws_ok(
    $$
        select public.complete_site_discovery(
            '30000000-0000-4000-8000-000000000012',
            '30000000-0000-4000-8000-000000000099',
            'no_news_source',
            '{}'::jsonb,
            jsonb_build_array(jsonb_build_object(
                'canonical_url', 'https://example.test/contradiction',
                'source_type', 'rss',
                'discovery_method', 'manual',
                'discovery_url', 'https://example.test/catalog'
            )),
            2
        )
    $$,
    '22023',
    'discovery result and news-source count are inconsistent',
    'rejects contradictory no-source completions'
);

select throws_ok(
    $$
        insert into public.news_sources (
            canonical_url,
            source_type,
            adapter_config
        ) values (
            'https://example.test/bad-config',
            'publisher_api',
            '[]'::jsonb
        )
    $$,
    '23514',
    null,
    'requires adapter configuration to be a bounded object'
);

delete from public.news_sources
where canonical_url = 'https://example.test/rss.xml';

select is(
    (
        select count(*)::integer
        from public.government_site_news_sources
        where news_source_id not in (select id from public.news_sources)
    ),
    0,
    'source deletion cascades without dangling relationships'
);

select ok(
    pg_get_function_result(
        'public.get_site_discovery_summary()'::regprocedure
    ) like '%news_source_count%'
    and pg_get_function_result(
        'public.get_site_discovery_summary()'::regprocedure
    ) not like '%feed_count%',
    'summary RPC exposes only generalized count names'
);

select ok(
    pg_get_constraintdef(
        (
            select oid
            from pg_catalog.pg_constraint
            where conrelid = 'public.news_sources'::regclass
              and conname = 'news_sources_type_valid'
        )
    ) like '%publisher_api%'
    and pg_get_constraintdef(
        (
            select oid
            from pg_catalog.pg_constraint
            where conrelid = 'public.news_sources'::regclass
              and conname = 'news_sources_type_valid'
        )
    ) like '%html_archive%'
    and pg_get_constraintdef(
        (
            select oid
            from pg_catalog.pg_constraint
            where conrelid = 'public.news_sources'::regclass
              and conname = 'news_sources_type_valid'
        )
    ) like '%sitemap%',
    'source-type constraint includes non-syndication adapters'
);

select is(
    (
        select active_source_relationship_count
        from public.get_site_discovery_summary()
    ),
    (
        select count(*)
        from public.government_site_news_sources
        where active
    ),
    'summary reports active generalized relationships'
);

select * from finish();
rollback;
