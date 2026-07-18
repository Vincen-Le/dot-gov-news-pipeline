begin;

truncate table
    public.inventory_sync_runs,
    public.government_sites
cascade;

select plan(6);

insert into public.inventory_sync_runs (
    id, source, status, source_url, source_sha256, source_row_count, completed_at
) values (
    '60000000-0000-4000-8000-000000000001',
    'gsa_federal_website_index',
    'succeeded',
    'https://example.test/gsa.csv',
    repeat('7', 64),
    4,
    now()
);

insert into public.government_sites (
    id, source_initial_url, initial_url, base_domain, top_level_domain,
    gsa_filtered, inventory_usable, inventory_active, source_row_hash,
    discovery_input_hash, last_sync_run_id
)
select
    format(
        '60000000-0000-4000-8000-%s',
        lpad(site_number::text, 12, '0')
    )::uuid,
    format('site-%s.shared.gov', site_number),
    format('site-%s.shared.gov', site_number),
    'shared.gov',
    'gov',
    false,
    true,
    true,
    repeat(site_number::text, 64),
    repeat((site_number + 4)::text, 64),
    '60000000-0000-4000-8000-000000000001'
from generate_series(1, 4) as site_number;

insert into public.site_discovery_state (site_id, status, next_discovery_at)
select id, 'pending', now()
from public.government_sites;

select throws_ok(
    $$select * from public.claim_due_site_discoveries(
        '60000000-0000-4000-8000-000000000099', 1, 900, true, null
    )$$,
    '22004',
    'maximum per base domain is required',
    'null base-domain concurrency is rejected'
);

select throws_ok(
    $$select * from public.claim_due_site_discoveries(
        '60000000-0000-4000-8000-000000000099', 1, 900, true, 26
    )$$,
    '22023',
    'maximum per base domain must be between 1 and 25',
    'base-domain concurrency is bounded'
);

select throws_ok(
    $$select * from public.claim_due_site_discoveries(
        '60000000-0000-4000-8000-000000000099', 1, 900, false, 2
    )$$,
    '22023',
    'wider base-domain lanes require pending-only mode',
    'recurring claims cannot widen the base-domain lane count'
);

create temporary table scaled_claim as
select * from public.claim_due_site_discoveries(
    '60000000-0000-4000-8000-000000000099', 4, 900, true, 3
);

select is(
    (select count(*)::integer from scaled_claim),
    3,
    'a pending-only backfill may fill three lanes for one base domain'
);

select is(
    (
        select count(*)::integer
        from public.claim_due_site_discoveries(
            '60000000-0000-4000-8000-000000000098', 4, 900, true, 3
        )
    ),
    0,
    'the configured active-lane cap is enforced across claims'
);

update public.site_discovery_state
set status = 'pending',
    lease_token = null,
    lease_owner = null,
    lease_until = null,
    updated_at = now();

select is(
    (
        select count(*)::integer
        from public.claim_due_site_discoveries(
            '60000000-0000-4000-8000-000000000097', 4, 900, true
        )
    ),
    1,
    'callers that omit the lane count retain one active lease per base domain'
);

select * from finish();
rollback;
