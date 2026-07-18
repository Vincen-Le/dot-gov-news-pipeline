create extension if not exists dblink with schema extensions;

truncate table
    public.inventory_sync_runs,
    public.government_sites
cascade;

do $$
begin
    if not exists (
        select 1 from pg_catalog.pg_roles where rolname = 'discovery_claim_test'
    ) then
        create role discovery_claim_test login password 'local-concurrency-test-only';
    else
        alter role discovery_claim_test password 'local-concurrency-test-only';
    end if;
end;
$$;

grant execute on function public.claim_due_site_discoveries(
    uuid, integer, integer, boolean, integer
)
    to discovery_claim_test;

insert into public.inventory_sync_runs (
    id, source, status, source_url, source_sha256, source_row_count, completed_at
) values (
    '40000000-0000-4000-8000-000000000001',
    'gsa_federal_website_index',
    'succeeded',
    'https://example.test/gsa.csv',
    repeat('5', 64),
    2,
    now()
);

insert into public.government_sites (
    id, source_initial_url, initial_url, base_domain, top_level_domain,
    gsa_filtered, inventory_usable, inventory_active, source_row_hash,
    discovery_input_hash, last_sync_run_id
) values
    (
        '40000000-0000-4000-8000-000000000011',
        'one.shared.gov', 'one.shared.gov', 'shared.gov', 'gov',
        false, true, true, repeat('a', 64), repeat('b', 64),
        '40000000-0000-4000-8000-000000000001'
    ),
    (
        '40000000-0000-4000-8000-000000000012',
        'two.shared.gov', 'two.shared.gov', 'shared.gov', 'gov',
        false, true, true, repeat('c', 64), repeat('d', 64),
        '40000000-0000-4000-8000-000000000001'
    );

insert into public.site_discovery_state (site_id, status, next_discovery_at)
values
    ('40000000-0000-4000-8000-000000000011', 'pending', now()),
    ('40000000-0000-4000-8000-000000000012', 'pending', now());

select plan(2);

select extensions.dblink_connect(
    'claim_a',
    'host=supabase_db_dot-gov-news-pipeline port=5432 dbname=postgres '
        || 'user=discovery_claim_test password=local-concurrency-test-only'
);
select extensions.dblink_exec('claim_a', 'begin');

select *
from extensions.dblink(
    'claim_a',
    $$select count(*)::integer
      from public.claim_due_site_discoveries(
          '40000000-0000-4000-8000-000000000091', 1, 900
      )$$
) as remote_claim(count integer);

select is(
    (
        select count(*)::integer
        from public.claim_due_site_discoveries(
            '40000000-0000-4000-8000-000000000092', 1, 900
        )
    ),
    0,
    'a concurrent claim returns immediately while the global claim lock is held'
);

select extensions.dblink_exec('claim_a', 'commit');
select extensions.dblink_disconnect('claim_a');

select is(
    (
        select count(*)::integer
        from public.site_discovery_state as state
        join public.government_sites as site on site.id = state.site_id
        where state.status = 'leased' and site.base_domain = 'shared.gov'
    ),
    1,
    'committed active leases contain one site for the shared base domain'
);

select * from finish();

truncate table
    public.inventory_sync_runs,
    public.government_sites
cascade;
revoke execute on function public.claim_due_site_discoveries(
    uuid, integer, integer, boolean, integer
)
    from discovery_claim_test;
drop role discovery_claim_test;
