begin;

truncate table
    public.inventory_sync_runs,
    public.government_sites
cascade;

select plan(3);

insert into public.inventory_sync_runs (
    id, source, status, source_url, source_sha256, source_row_count, completed_at
) values (
    '50000000-0000-4000-8000-000000000001',
    'gsa_federal_website_index',
    'succeeded',
    'https://example.test/gsa.csv',
    repeat('6', 64),
    2,
    now()
);

insert into public.government_sites (
    id, source_initial_url, initial_url, base_domain, top_level_domain,
    gsa_filtered, inventory_usable, inventory_active, source_row_hash,
    discovery_input_hash, last_sync_run_id
) values
    (
        '50000000-0000-4000-8000-000000000011',
        'pending.example.gov', 'pending.example.gov', 'example.gov', 'gov',
        false, true, true, repeat('a', 64), repeat('b', 64),
        '50000000-0000-4000-8000-000000000001'
    ),
    (
        '50000000-0000-4000-8000-000000000012',
        'retry.other.gov', 'retry.other.gov', 'other.gov', 'gov',
        false, true, true, repeat('c', 64), repeat('d', 64),
        '50000000-0000-4000-8000-000000000001'
    );

insert into public.site_discovery_state (site_id, status, next_discovery_at)
values
    ('50000000-0000-4000-8000-000000000011', 'pending', now()),
    ('50000000-0000-4000-8000-000000000012', 'backoff', now());

select throws_ok(
    $$select * from public.claim_due_site_discoveries(
        '50000000-0000-4000-8000-000000000099', 1, 900, null
    )$$,
    '22004',
    'pending-only mode is required',
    'null pending-only mode is rejected'
);

create temporary table pending_claim as
select * from public.claim_due_site_discoveries(
    '50000000-0000-4000-8000-000000000099', 2, 900, true
);

select results_eq(
    'select site_id from pending_claim',
    $$values ('50000000-0000-4000-8000-000000000011'::uuid)$$,
    'pending-only mode excludes a due backoff row'
);

select results_eq(
    $$select site_id from public.claim_due_site_discoveries(
        '50000000-0000-4000-8000-000000000098', 2, 900, false
    )$$,
    $$values ('50000000-0000-4000-8000-000000000012'::uuid)$$,
    'recurring mode still claims a due backoff row'
);

select * from finish();
rollback;
