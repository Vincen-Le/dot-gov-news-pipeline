insert into public.inventory_sync_runs (
    id,
    source,
    status,
    source_url,
    source_sha256,
    source_row_count,
    completed_at
) values (
    '10000000-0000-0000-0000-000000000001',
    'migration_fixture',
    'succeeded',
    'https://example.gov/inventory.csv',
    repeat('a', 64),
    2,
    '2026-07-01 00:00:00+00'
);

insert into public.government_sites (
    id,
    source,
    source_initial_url,
    initial_url,
    base_domain,
    top_level_domain,
    branch,
    agency,
    bureau,
    gsa_filtered,
    inventory_usable,
    inventory_active,
    source_row_hash,
    discovery_input_hash,
    first_seen_at,
    last_seen_at,
    last_sync_run_id
) values
    (
        '20000000-0000-0000-0000-000000000001',
        'migration_fixture',
        'https://one.example.gov',
        'https://one.example.gov/',
        'example.gov',
        'gov',
        'Executive',
        'Example Agency',
        'First Bureau',
        false,
        true,
        true,
        repeat('b', 64),
        repeat('c', 64),
        '2026-07-01 01:00:00+00',
        '2026-07-02 01:00:00+00',
        '10000000-0000-0000-0000-000000000001'
    ),
    (
        '20000000-0000-0000-0000-000000000002',
        'migration_fixture',
        'https://two.example.gov',
        'https://two.example.gov/',
        'example.gov',
        'gov',
        'Executive',
        'Example Agency',
        'Second Bureau',
        false,
        true,
        true,
        repeat('d', 64),
        repeat('e', 64),
        '2026-07-01 02:00:00+00',
        '2026-07-02 02:00:00+00',
        '10000000-0000-0000-0000-000000000001'
    );

insert into public.site_discovery_state (
    site_id,
    status,
    next_discovery_at,
    last_started_at,
    last_completed_at,
    last_result,
    failure_count,
    successful_discovery_count,
    last_final_url,
    last_http_status,
    last_duration_ms,
    last_policy_version,
    updated_at
) values (
    '20000000-0000-0000-0000-000000000001',
    'no_feed',
    '2026-08-15 12:00:00+00',
    '2026-07-15 12:00:00+00',
    '2026-07-15 12:00:10+00',
    'no_feed',
    0,
    4,
    'https://one.example.gov/',
    200,
    10000,
    7,
    '2026-07-15 12:00:10+00'
);

insert into public.site_discovery_state (
    site_id,
    status,
    next_discovery_at,
    lease_token,
    lease_owner,
    lease_until,
    last_started_at,
    last_result,
    failure_count,
    successful_discovery_count,
    updated_at
) values (
    '20000000-0000-0000-0000-000000000002',
    'leased',
    '2026-07-20 12:00:00+00',
    '21000000-0000-0000-0000-000000000001',
    '22000000-0000-0000-0000-000000000001',
    '2099-07-20 12:05:00+00',
    '2026-07-20 12:00:00+00',
    'no_feed',
    2,
    3,
    '2026-07-20 12:00:00+00'
);

insert into public.feeds (
    id,
    canonical_url,
    feed_type,
    title,
    home_page_url,
    status,
    last_http_status,
    first_seen_at,
    last_seen_at,
    last_validated_at,
    created_at,
    updated_at
) values
    (
        '30000000-0000-0000-0000-000000000001',
        'https://one.example.gov/news.xml',
        'rss',
        'Example RSS',
        'https://one.example.gov/news',
        'active',
        200,
        '2026-01-01 01:00:00+00',
        '2026-07-01 01:00:00+00',
        '2026-07-01 01:01:00+00',
        '2026-01-01 01:00:00+00',
        '2026-07-01 01:02:00+00'
    ),
    (
        '30000000-0000-0000-0000-000000000002',
        'https://shared.example.gov/atom.xml',
        'atom',
        null,
        null,
        'gone',
        410,
        '2026-02-01 02:00:00+00',
        '2026-06-01 02:00:00+00',
        '2026-06-01 02:01:00+00',
        '2026-02-01 02:00:00+00',
        '2026-06-01 02:02:00+00'
    );

insert into public.government_site_feeds (
    site_id,
    feed_id,
    discovery_method,
    discovery_url,
    active,
    missing_success_count,
    first_seen_at,
    last_seen_at,
    updated_at
) values
    (
        '20000000-0000-0000-0000-000000000001',
        '30000000-0000-0000-0000-000000000001',
        'html_alternate',
        'https://one.example.gov/',
        true,
        0,
        '2026-01-01 03:00:00+00',
        '2026-07-01 03:00:00+00',
        '2026-07-01 03:01:00+00'
    ),
    (
        '20000000-0000-0000-0000-000000000001',
        '30000000-0000-0000-0000-000000000002',
        'anchor',
        'https://one.example.gov/news',
        false,
        2,
        '2026-02-01 04:00:00+00',
        '2026-06-01 04:00:00+00',
        '2026-06-01 04:01:00+00'
    ),
    (
        '20000000-0000-0000-0000-000000000002',
        '30000000-0000-0000-0000-000000000002',
        'conventional_path',
        'https://two.example.gov/feed',
        true,
        1,
        '2026-03-01 05:00:00+00',
        '2026-07-01 05:00:00+00',
        '2026-07-01 05:01:00+00'
    );

insert into public.feed_fetch_state (
    feed_id,
    status,
    next_fetch_at,
    lease_token,
    lease_owner,
    lease_until,
    etag,
    last_modified,
    last_success_at,
    last_new_item_at,
    failure_count,
    updated_at
) values
    (
        '30000000-0000-0000-0000-000000000001',
        'leased',
        '2026-07-18 10:00:00+00',
        '31000000-0000-0000-0000-000000000001',
        '32000000-0000-0000-0000-000000000001',
        '2099-07-18 10:05:00+00',
        '"rss-etag"',
        'Fri, 17 Jul 2026 10:00:00 GMT',
        '2026-07-17 10:00:00+00',
        '2026-07-17 09:00:00+00',
        5,
        '2026-07-18 10:00:01+00'
    ),
    (
        '30000000-0000-0000-0000-000000000002',
        'active',
        '2026-07-18 11:00:00+00',
        null,
        null,
        null,
        null,
        null,
        '2026-07-17 11:00:00+00',
        null,
        0,
        '2026-07-18 11:00:01+00'
    );
