begin;

truncate table
    public.inventory_sync_runs,
    public.government_sites
cascade;

select plan(35);

insert into public.inventory_sync_runs (
    id,
    source,
    status,
    source_url,
    source_sha256,
    source_row_count,
    completed_at
) values (
    '30000000-0000-4000-8000-000000000001',
    'gsa_federal_website_index',
    'succeeded',
    'https://example.test/gsa.csv',
    repeat('4', 64),
    3,
    now()
);

insert into public.government_sites (
    id,
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
        'one.example.gov',
        'one.example.gov',
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
        'two.other.gov',
        'two.other.gov',
        'other.gov',
        'gov',
        false,
        true,
        true,
        repeat('c', 64),
        repeat('d', 64),
        '30000000-0000-4000-8000-000000000001'
    ),
    (
        '30000000-0000-4000-8000-000000000013',
        'disabled.third.gov',
        'disabled.third.gov',
        'third.gov',
        'gov',
        true,
        true,
        true,
        repeat('e', 64),
        repeat('f', 64),
        '30000000-0000-4000-8000-000000000001'
    );

insert into public.site_discovery_state (
    site_id,
    status,
    next_discovery_at
) values
    ('30000000-0000-4000-8000-000000000011', 'pending', now()),
    ('30000000-0000-4000-8000-000000000012', 'pending', now()),
    ('30000000-0000-4000-8000-000000000013', 'disabled', null);

select ok(
    not has_table_privilege('anon', 'public.feeds', 'select'),
    'anon cannot read feeds'
);

select ok(
    not has_table_privilege('authenticated', 'public.government_site_feeds', 'select'),
    'authenticated cannot read site/feed provenance'
);

select ok(
    has_table_privilege('service_role', 'public.feed_fetch_state', 'select'),
    'service role can read polling handoff state'
);

select ok(
    not has_function_privilege(
        'anon',
        'public.complete_site_discovery(uuid,uuid,text,jsonb,jsonb,integer)',
        'execute'
    ),
    'anon cannot complete discovery'
);

select throws_ok(
    $$select * from public.claim_due_site_discoveries(
        '30000000-0000-4000-8000-000000000099', null, 900
    )$$,
    '22023',
    'claim limit must be between 1 and 25',
    'a null claim limit cannot disable the claim cap'
);

select throws_ok(
    $$select * from public.claim_due_site_discoveries(
        '30000000-0000-4000-8000-000000000099', 1, null
    )$$,
    '22023',
    'lease seconds must be between 30 and 3600',
    'null lease seconds are rejected'
);

create temporary table first_claim as
select *
from public.claim_due_site_discoveries(
    '30000000-0000-4000-8000-000000000099',
    1,
    900
);

select is(
    (select count(*)::integer from first_claim),
    1,
    'claims one due site'
);

select is(
    public.renew_site_discovery_lease(
        (select site_id from first_claim),
        '30000000-0000-4000-8000-000000000098',
        900
    ),
    null::timestamptz,
    'a stale token cannot renew a lease'
);

select ok(
    public.renew_site_discovery_lease(
        (select site_id from first_claim),
        (select lease_token from first_claim),
        900
    ) > now() + interval '14 minutes',
    'the matching token renews the lease'
);

select is(
    public.release_site_discovery_lease(
        (select site_id from first_claim),
        '30000000-0000-4000-8000-000000000098',
        'enqueue_failed'
    ),
    false,
    'a stale token cannot release a lease'
);

select is(
    public.release_site_discovery_lease(
        (select site_id from first_claim),
        (select lease_token from first_claim),
        'enqueue_failed'
    ),
    true,
    'enqueue compensation returns matching work to pending'
);

truncate first_claim;
insert into first_claim
select *
from public.claim_due_site_discoveries(
    '30000000-0000-4000-8000-000000000099',
    1,
    900
);

select throws_ok(
    format(
        'select public.complete_site_discovery(%L, %L, null, ''{}''::jsonb, ''[]''::jsonb, 1)',
        (select site_id from first_claim),
        (select lease_token from first_claim)
    ),
    '22023',
    'discovery completion metadata is invalid',
    'null result is rejected before mutation'
);

select throws_ok(
    format(
        'select public.complete_site_discovery(%L, %L, ''succeeded'', null, %L::jsonb, 1)',
        (select site_id from first_claim),
        (select lease_token from first_claim),
        '[{"canonical_url":"https://one.example.gov/feed.xml","feed_type":"rss","discovery_method":"html_alternate","discovery_url":"https://one.example.gov/feed.xml"}]'
    ),
    '22023',
    'discovery completion metadata is invalid',
    'null site health is rejected before mutation'
);

select throws_ok(
    format(
        'select public.complete_site_discovery(%L, %L, ''succeeded'', ''{}''::jsonb, null, 1)',
        (select site_id from first_claim),
        (select lease_token from first_claim)
    ),
    '22023',
    'discovery completion metadata is invalid',
    'null feeds are rejected before mutation'
);

select throws_ok(
    format(
        'select public.complete_site_discovery(%L, %L, ''no_feed'', ''{"duration_ms":1.5}''::jsonb, ''[]''::jsonb, 1)',
        (select site_id from first_claim),
        (select lease_token from first_claim)
    ),
    '22023',
    'site health payload is invalid',
    'fractional duration metadata is rejected'
);

select throws_ok(
    format(
        'select public.complete_site_discovery(%L, %L, ''succeeded'', ''{}''::jsonb, %L::jsonb, 1)',
        (select site_id from first_claim),
        (select lease_token from first_claim),
        '[{"canonical_url":"https://one.example.gov/feed.xml","feed_type":"rss","http_status":200.5,"discovery_method":"html_alternate","discovery_url":"https://one.example.gov/feed.xml"}]'
    ),
    '22023',
    'feed completion payload is invalid',
    'fractional feed status metadata is rejected'
);

select throws_ok(
    format(
        'select public.complete_site_discovery(%L, %L, ''succeeded'', ''{}''::jsonb, %L::jsonb, 1)',
        (select site_id from first_claim),
        (select lease_token from first_claim),
        '[{"canonical_url":"https://one.example.gov/feed.xml","feed_type":"rss","home_page_url":"javascript:alert(1)","discovery_method":"html_alternate","discovery_url":"https://one.example.gov/feed.xml"}]'
    ),
    '22023',
    'feed completion payload is invalid',
    'non-HTTP feed metadata is rejected at the database boundary'
);

select is(
    public.complete_site_discovery(
        (select site_id from first_claim),
        (select lease_token from first_claim),
        'succeeded',
        jsonb_build_object(
            'final_url', 'https://one.example.gov/',
            'http_status', 200,
            'duration_ms', 125
        ),
        jsonb_build_array(jsonb_build_object(
            'canonical_url', 'https://one.example.gov/feed.xml',
            'feed_type', 'rss',
            'title', 'Example news',
            'home_page_url', 'https://one.example.gov/',
            'http_status', 200,
            'discovery_method', 'html_alternate',
            'discovery_url', 'https://one.example.gov/feed.xml'
        )),
        1
    ),
    true,
    'completion atomically accepts a valid leased result'
);

select is((select count(*)::integer from public.feeds), 1, 'creates one canonical feed');

select is(
    (select count(*)::integer from public.government_site_feeds where active),
    1,
    'creates active site/feed provenance'
);

select is(
    (select status from public.feed_fetch_state),
    'pending',
    'creates a pending polling handoff row'
);

select is(
    public.complete_site_discovery(
        (select site_id from first_claim),
        (select lease_token from first_claim),
        'no_feed',
        '{}'::jsonb,
        '[]'::jsonb,
        1
    ),
    false,
    'duplicate completion is stale and cannot overwrite state'
);

update public.site_discovery_state
set next_discovery_at = now()
where site_id = (select site_id from first_claim);

create temporary table second_claim as
select *
from public.claim_due_site_discoveries(
    '30000000-0000-4000-8000-000000000099',
    1,
    900
);

select is(
    public.complete_site_discovery(
        (select site_id from second_claim),
        (select lease_token from second_claim),
        'no_feed',
        '{}'::jsonb,
        '[]'::jsonb,
        1
    ),
    true,
    'a complete no-feed scan succeeds'
);

select ok(
    (select active and missing_success_count = 1 from public.government_site_feeds),
    'one complete miss preserves the known relationship'
);

update public.site_discovery_state
set next_discovery_at = now()
where site_id = (select site_id from second_claim);

truncate second_claim;
insert into second_claim
select *
from public.claim_due_site_discoveries(
    '30000000-0000-4000-8000-000000000099',
    1,
    900
);

select ok(
    public.complete_site_discovery(
        (select site_id from second_claim),
        (select lease_token from second_claim),
        'no_feed',
        '{}'::jsonb,
        '[]'::jsonb,
        1
    ),
    'a second complete no-feed scan succeeds'
);

select ok(
    (select not active and missing_success_count = 2 from public.government_site_feeds),
    'two consecutive complete misses deactivate the relationship'
);

update public.site_discovery_state
set next_discovery_at = now()
where site_id = '30000000-0000-4000-8000-000000000012';

update public.feeds set status = 'suppressed';

truncate second_claim;
insert into second_claim
select *
from public.claim_due_site_discoveries(
    '30000000-0000-4000-8000-000000000099',
    1,
    900
);

select ok(
    public.complete_site_discovery(
        (select site_id from second_claim),
        (select lease_token from second_claim),
        'succeeded',
        '{}'::jsonb,
        jsonb_build_array(jsonb_build_object(
            'canonical_url', 'https://one.example.gov/feed.xml',
            'feed_type', 'rss',
            'title', null,
            'home_page_url', null,
            'http_status', 200,
            'discovery_method', 'http_link',
            'discovery_url', 'https://feeds.example.net/gov.xml'
        )),
        1
    ),
    'a second site can discover the same canonical feed'
);

select is((select count(*)::integer from public.feeds), 1, 'canonical URL remains globally unique');

select is(
    (select status from public.feeds),
    'suppressed',
    'rediscovery preserves an operator-suppressed feed'
);

select is(
    (select count(*)::integer from public.government_site_feeds),
    2,
    'one canonical feed retains many-to-many site provenance'
);

update public.site_discovery_state
set next_discovery_at = now(),
    last_final_url = 'https://stale.example.gov/',
    last_http_status = 200,
    last_duration_ms = 123
where site_id = '30000000-0000-4000-8000-000000000012';

truncate second_claim;
insert into second_claim
select *
from public.claim_due_site_discoveries(
    '30000000-0000-4000-8000-000000000099',
    1,
    900
);

select ok(
    public.fail_site_discovery(
        (select site_id from second_claim),
        (select lease_token from second_claim),
        'publisher_timeout',
        'publisher request timed out',
        99999999,
        1
    ),
    'a publisher failure persists bounded backoff'
);

select ok(
    (select status = 'backoff'
        and failure_count = 1
        and next_discovery_at >= now() + interval '7 days' - interval '1 second'
        and next_discovery_at <= now() + interval '7 days' + interval '1 second'
     from public.site_discovery_state
     where site_id = '30000000-0000-4000-8000-000000000012'),
    'jitter cannot schedule before the clamped retry-after'
);

select ok(
    (select last_final_url is null
        and last_http_status is null
        and last_duration_ms is null
     from public.site_discovery_state
     where site_id = '30000000-0000-4000-8000-000000000012'),
    'a failed scan clears stale success health'
);

select ok(
    (select active
     from public.government_site_feeds
     where site_id = '30000000-0000-4000-8000-000000000012'),
    'failed scans do not age out a prior relationship'
);

select is(
    (select feed_count::integer from public.get_site_discovery_summary()),
    1,
    'operator summary reports canonical feeds'
);

select * from finish();
rollback;
