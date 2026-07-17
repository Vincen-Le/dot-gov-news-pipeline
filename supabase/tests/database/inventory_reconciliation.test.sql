begin;

truncate table
    public.inventory_sync_runs,
    public.government_sites
cascade;

select plan(27);

insert into public.inventory_sync_runs (
    id,
    source,
    source_url
) values (
    '10000000-0000-4000-8000-000000000001',
    'gsa_federal_website_index',
    'https://example.test/gsa.csv'
);

select is(
    public.stage_gsa_inventory_batch(
        '10000000-0000-4000-8000-000000000001',
        (
            select jsonb_agg(jsonb_build_object(
                'source_row_number', source_number,
                'source_initial_url', format('site-%s.example.gov', source_number),
                'initial_url', format('site-%s.example.gov', source_number),
                'base_domain', 'example.gov',
                'top_level_domain', 'gov',
                'branch', 'Executive',
                'agency', 'Example Agency',
                'bureau', null,
                'gsa_filtered', source_number % 10 = 0,
                'inventory_usable', true,
                'exclusion_reason', null,
                'source_record', jsonb_build_object(
                    'initial_url', format('site-%s.example.gov', source_number)
                ),
                'source_row_hash', repeat('a', 64),
                'discovery_input_hash', repeat('b', 64)
            ))
            from generate_series(1, 1000) as source(source_number)
        )
    ),
    1000,
    'stages one bounded 1000-row batch'
);

select is(
    (select staged_count from public.inventory_sync_runs
     where id = '10000000-0000-4000-8000-000000000001'),
    1000,
    'records the staged row count'
);

update public.inventory_sync_runs
set
    source_sha256 = repeat('1', 64),
    source_row_count = 1000,
    raw_artifact_key = format('inventory/gsa/%s.csv', repeat('1', 64))
where id = '10000000-0000-4000-8000-000000000001';

select is(
    (
        select eligible_count
        from public.finalize_gsa_inventory_sync(
            '10000000-0000-4000-8000-000000000001',
            1000,
            false
        )
    ),
    900,
    'finalization returns the eligible-site count'
);

select is(
    (select status from public.inventory_sync_runs
     where id = '10000000-0000-4000-8000-000000000001'),
    'succeeded',
    'marks the run succeeded atomically'
);

select is(
    (select inserted_count from public.inventory_sync_runs
     where id = '10000000-0000-4000-8000-000000000001'),
    1000,
    'records inserted sites'
);

select is(
    (select count(*)::integer from public.government_sites),
    1000,
    'retains every source row in the inventory'
);

select is(
    (select count(*)::integer from public.usable_government_sites),
    900,
    'exposes only active unfiltered sites as usable'
);

select is(
    (select count(*)::integer from public.site_discovery_state
     where status = 'pending'),
    900,
    'makes eligible sites due for discovery'
);

select is(
    (select count(*)::integer from public.site_discovery_state
     where status = 'disabled'),
    100,
    'keeps filtered sites disabled'
);

select ok(
    not has_table_privilege('anon', 'public.government_sites', 'select'),
    'anon cannot read the inventory table'
);

select ok(
    not has_function_privilege(
        'anon',
        'public.stage_gsa_inventory_batch(uuid,jsonb)',
        'execute'
    ),
    'anon cannot execute the staging RPC'
);

select ok(
    has_table_privilege('service_role', 'public.usable_government_sites', 'select'),
    'service role can read the usable inventory'
);

select ok(
    not has_table_privilege('service_role', 'public.inventory_sync_runs', 'insert'),
    'service role cannot bypass controlled sync-run creation'
);

select ok(
    has_function_privilege(
        'service_role',
        'public.begin_gsa_inventory_sync(text)',
        'execute'
    ),
    'service role can create sync runs through the controlled RPC'
);

select ok(
    not has_function_privilege(
        'anon',
        'public.list_government_sites(uuid,integer,boolean,boolean,text,text,text)',
        'execute'
    ),
    'anon cannot list government sites'
);

select ok(
    has_function_privilege(
        'service_role',
        'public.list_government_sites(uuid,integer,boolean,boolean,text,text,text)',
        'execute'
    ),
    'service role can use the paginated site-list RPC'
);

select is(
    (
        select usable_count::integer
        from public.get_government_inventory_summary()
    ),
    900,
    'summary RPC reports usable inventory'
);

select is(
    (
        select count(*)::integer
        from public.list_government_sites(p_limit => 25)
    ),
    25,
    'list RPC enforces a bounded requested page size'
);

select is(
    (
        select eligible_count
        from public.finalize_gsa_inventory_sync(
            '10000000-0000-4000-8000-000000000001',
            1000,
            false
        )
    ),
    900,
    'replaying finalization returns the persisted result'
);

select is(
    (select count(*)::integer from public.government_sites),
    1000,
    'replaying finalization does not duplicate sites'
);

insert into public.inventory_sync_runs (
    id,
    source,
    source_url
) values (
    '10000000-0000-4000-8000-000000000002',
    'gsa_federal_website_index',
    'https://example.test/gsa.csv'
);

select is(
    public.stage_gsa_inventory_batch(
        '10000000-0000-4000-8000-000000000002',
        (
            select jsonb_agg(jsonb_build_object(
                'source_row_number', source_number,
                'source_initial_url', format('site-%s.example.gov', source_number + 1),
                'initial_url', format('site-%s.example.gov', source_number + 1),
                'base_domain', 'example.gov',
                'top_level_domain', 'gov',
                'branch', 'Executive',
                'agency', 'Example Agency',
                'bureau', null,
                'gsa_filtered', (source_number + 1) % 10 = 0,
                'inventory_usable', true,
                'exclusion_reason', null,
                'source_record', jsonb_build_object(
                    'initial_url', format('site-%s.example.gov', source_number + 1)
                ),
                'source_row_hash', repeat('a', 64),
                'discovery_input_hash', repeat('b', 64)
            ))
            from generate_series(1, 1000) as source(source_number)
        )
    ),
    1000,
    'stages a replacement snapshot'
);

update public.inventory_sync_runs
set
    source_sha256 = repeat('2', 64),
    source_row_count = 1000,
    raw_artifact_key = format('inventory/gsa/%s.csv', repeat('2', 64))
where id = '10000000-0000-4000-8000-000000000002';

select is(
    (
        select deactivated_count
        from public.finalize_gsa_inventory_sync(
            '10000000-0000-4000-8000-000000000002',
            1000,
            false
        )
    ),
    1,
    'soft-deactivates a site missing from a valid replacement snapshot'
);

select is(
    (select inserted_count from public.inventory_sync_runs
     where id = '10000000-0000-4000-8000-000000000002'),
    1,
    'records a newly inserted replacement site'
);

select is(
    (select count(*)::integer from public.government_sites
     where inventory_active),
    1000,
    'keeps the active inventory aligned with the replacement snapshot'
);

select ok(
    not (select inventory_active from public.government_sites
         where initial_url = 'site-1.example.gov'),
    'missing rows are inactive rather than deleted'
);

select is(
    (select status from public.site_discovery_state
     where site_id = (
         select id from public.government_sites
         where initial_url = 'site-1.example.gov'
     )),
    'disabled',
    'deactivation disables discovery state'
);

select is(
    (select count(*)::integer from public.government_sites),
    1001,
    'historical inventory rows remain queryable after replacement'
);

select * from finish();
rollback;
