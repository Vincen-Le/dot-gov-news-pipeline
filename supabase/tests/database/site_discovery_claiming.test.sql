begin;

truncate table
    public.inventory_sync_runs,
    public.government_sites
cascade;

select plan(8);

insert into public.inventory_sync_runs (
    id,
    source,
    source_url
) values (
    '20000000-0000-4000-8000-000000000001',
    'gsa_federal_website_index',
    'https://example.test/gsa.csv'
);

select is(
    public.stage_gsa_inventory_batch(
        '20000000-0000-4000-8000-000000000001',
        (
            select jsonb_agg(jsonb_build_object(
                'source_row_number', source_number,
                'source_initial_url', format(
                    'site-%s.domain-%s.gov',
                    source_number,
                    ((source_number - 1) / 2) + 1
                ),
                'initial_url', case when source_number = 989 then null else format(
                    'site-%s.domain-%s.gov',
                    source_number,
                    ((source_number - 1) / 2) + 1
                ) end,
                'base_domain', case when source_number = 989 then null else format(
                    'domain-%s.gov',
                    ((source_number - 1) / 2) + 1
                ) end,
                'top_level_domain', 'gov',
                'branch', 'Executive',
                'agency', 'Example Agency',
                'bureau', null,
                'gsa_filtered', source_number > 990,
                'inventory_usable', source_number <> 989,
                'exclusion_reason', case
                    when source_number = 989 then 'invalid_hostname'
                    else null
                end,
                'source_record', jsonb_build_object('row', source_number),
                'source_row_hash', repeat('c', 64),
                'discovery_input_hash', repeat('d', 64)
            ))
            from generate_series(1, 1000) as source(source_number)
        )
    ),
    1000,
    'stages discovery claim fixtures'
);

update public.inventory_sync_runs
set
    source_sha256 = repeat('3', 64),
    source_row_count = 1000,
    raw_artifact_key = format('inventory/gsa/%s.csv', repeat('3', 64))
where id = '20000000-0000-4000-8000-000000000001';

select is(
    (
        select eligible_count
        from public.finalize_gsa_inventory_sync(
            '20000000-0000-4000-8000-000000000001',
            1000,
            false
        )
    ),
    989,
    'creates due work only for unfiltered, usable sites'
);

create temporary table claimed_sites as
select *
from public.claim_due_site_discoveries(
    '20000000-0000-4000-8000-000000000099',
    5,
    300
);

select is(
    (select count(*)::integer from claimed_sites),
    5,
    'claims the requested number of due sites'
);

select is(
    (select count(distinct base_domain)::integer from claimed_sites),
    5,
    'claims at most one site per base domain'
);

select is(
    (select count(*)::integer
     from public.site_discovery_state as state
     join claimed_sites as claimed on claimed.site_id = state.site_id
     where state.status = 'leased'
       and state.lease_token = claimed.lease_token
       and state.lease_owner = '20000000-0000-4000-8000-000000000099'),
    5,
    'persists lease tokens and ownership'
);

select is(
    (select count(*)::integer
     from claimed_sites as claimed
     join public.government_sites as site on site.id = claimed.site_id
     where site.gsa_filtered),
    0,
    'never claims filtered sites'
);

update public.site_discovery_state
set lease_until = now() - interval '1 second'
where site_id = (
    select site_id from claimed_sites order by site_id limit 1
);

select is(
    public.recover_expired_site_discovery_leases(),
    1,
    'recovers an expired lease'
);

select is(
    (select count(*)::integer
     from public.site_discovery_state as state
     join claimed_sites as claimed on claimed.site_id = state.site_id
     where state.status = 'pending'),
    1,
    'recovered work becomes due again'
);

select * from finish();
rollback;
