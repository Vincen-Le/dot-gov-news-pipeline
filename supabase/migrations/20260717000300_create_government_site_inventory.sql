begin;

create schema if not exists private;

revoke all on schema private from public, anon, authenticated;

create table public.inventory_sync_runs (
    id uuid primary key default gen_random_uuid(),
    source text not null,
    status text not null default 'running',
    source_url text not null,
    source_etag text,
    source_sha256 text,
    raw_artifact_key text,
    source_row_count integer,
    staged_count integer not null default 0,
    inserted_count integer not null default 0,
    updated_count integer not null default 0,
    reactivated_count integer not null default 0,
    deactivated_count integer not null default 0,
    eligible_count integer not null default 0,
    error_code text,
    error_detail text,
    started_at timestamptz not null default now(),
    completed_at timestamptz,
    constraint inventory_sync_runs_source_not_empty
        check (length(btrim(source)) > 0),
    constraint inventory_sync_runs_status_valid
        check (status in ('running', 'unchanged', 'succeeded', 'failed')),
    constraint inventory_sync_runs_source_url_not_empty
        check (length(btrim(source_url)) > 0),
    constraint inventory_sync_runs_sha256_valid
        check (source_sha256 is null or source_sha256 ~ '^[0-9a-f]{64}$'),
    constraint inventory_sync_runs_raw_artifact_key_not_empty
        check (raw_artifact_key is null or length(btrim(raw_artifact_key)) > 0),
    constraint inventory_sync_runs_counts_nonnegative
        check (
            coalesce(source_row_count, 0) >= 0
            and staged_count >= 0
            and inserted_count >= 0
            and updated_count >= 0
            and reactivated_count >= 0
            and deactivated_count >= 0
            and eligible_count >= 0
        ),
    constraint inventory_sync_runs_completion_consistent
        check (
            (status = 'running' and completed_at is null)
            or (status <> 'running' and completed_at is not null)
        )
);

comment on table public.inventory_sync_runs is
    'One auditable attempt to synchronize an external government-site inventory.';

create index inventory_sync_runs_source_started_at_idx
    on public.inventory_sync_runs (source, started_at desc);

create index inventory_sync_runs_successful_checksum_idx
    on public.inventory_sync_runs (source, source_sha256)
    where status = 'succeeded' and source_sha256 is not null;

create table private.gsa_inventory_stage (
    sync_run_id uuid not null
        references public.inventory_sync_runs(id) on delete cascade,
    source_row_number integer not null,
    source_initial_url text not null,
    initial_url text,
    base_domain text,
    top_level_domain text not null,
    branch text,
    agency text,
    bureau text,
    gsa_filtered boolean not null,
    inventory_usable boolean not null,
    exclusion_reason text,
    source_record jsonb not null,
    source_row_hash text not null,
    discovery_input_hash text not null,
    primary key (sync_run_id, source_row_number),
    constraint gsa_inventory_stage_source_row_number_positive
        check (source_row_number > 0),
    constraint gsa_inventory_stage_source_initial_url_not_empty
        check (length(btrim(source_initial_url)) > 0),
    constraint gsa_inventory_stage_initial_url_not_empty
        check (initial_url is null or length(btrim(initial_url)) > 0),
    constraint gsa_inventory_stage_base_domain_not_empty
        check (base_domain is null or length(btrim(base_domain)) > 0),
    constraint gsa_inventory_stage_top_level_domain_not_empty
        check (length(btrim(top_level_domain)) > 0),
    constraint gsa_inventory_stage_source_record_object
        check (jsonb_typeof(source_record) = 'object'),
    constraint gsa_inventory_stage_source_row_hash_valid
        check (source_row_hash ~ '^[0-9a-f]{64}$'),
    constraint gsa_inventory_stage_discovery_input_hash_valid
        check (discovery_input_hash ~ '^[0-9a-f]{64}$'),
    constraint gsa_inventory_stage_usability_consistent
        check (
            (inventory_usable
                and initial_url is not null
                and base_domain is not null
                and exclusion_reason is null)
            or (not inventory_usable
                and initial_url is null
                and base_domain is null
                and exclusion_reason is not null
                and length(btrim(exclusion_reason)) > 0)
        )
);

comment on table private.gsa_inventory_stage is
    'Complete GSA source rows staged by row number before atomic reconciliation.';

create index gsa_inventory_stage_run_initial_url_idx
    on private.gsa_inventory_stage (sync_run_id, source_initial_url);

create table public.government_sites (
    id uuid primary key default gen_random_uuid(),
    source text not null default 'gsa_federal_website_index',
    source_initial_url text not null,
    initial_url text,
    base_domain text,
    top_level_domain text not null,
    branch text,
    agency text,
    bureau text,
    gsa_filtered boolean not null,
    inventory_usable boolean not null,
    exclusion_reason text,
    inventory_active boolean not null default true,
    source_row_hash text not null,
    discovery_input_hash text not null,
    first_seen_at timestamptz not null default now(),
    last_seen_at timestamptz not null default now(),
    deactivated_at timestamptz,
    last_sync_run_id uuid not null
        references public.inventory_sync_runs(id),
    constraint government_sites_source_initial_url_unique
        unique (source, source_initial_url),
    constraint government_sites_source_not_empty
        check (length(btrim(source)) > 0),
    constraint government_sites_source_initial_url_not_empty
        check (length(btrim(source_initial_url)) > 0),
    constraint government_sites_initial_url_not_empty
        check (initial_url is null or length(btrim(initial_url)) > 0),
    constraint government_sites_base_domain_not_empty
        check (base_domain is null or length(btrim(base_domain)) > 0),
    constraint government_sites_top_level_domain_not_empty
        check (length(btrim(top_level_domain)) > 0),
    constraint government_sites_source_row_hash_valid
        check (source_row_hash ~ '^[0-9a-f]{64}$'),
    constraint government_sites_discovery_input_hash_valid
        check (discovery_input_hash ~ '^[0-9a-f]{64}$'),
    constraint government_sites_deactivation_consistent
        check (
            (inventory_active and deactivated_at is null)
            or (not inventory_active and deactivated_at is not null)
        ),
    constraint government_sites_usability_consistent
        check (
            (inventory_usable
                and initial_url is not null
                and base_domain is not null
                and exclusion_reason is null)
            or (not inventory_usable
                and initial_url is null
                and base_domain is null
                and exclusion_reason is not null
                and length(btrim(exclusion_reason)) > 0)
        )
);

comment on table public.government_sites is
    'Current, soft-deletable federal website inventory reconciled from GSA snapshots.';

create index government_sites_eligible_idx
    on public.government_sites (last_seen_at desc, id)
    where inventory_active and not gsa_filtered and inventory_usable;

create index government_sites_base_domain_idx
    on public.government_sites (base_domain)
    where base_domain is not null;

create index government_sites_initial_url_idx
    on public.government_sites (initial_url)
    where inventory_active and inventory_usable and initial_url is not null;

create index government_sites_agency_idx
    on public.government_sites (agency)
    where agency is not null;

create index government_sites_last_seen_at_idx
    on public.government_sites (last_seen_at desc);

create table public.site_discovery_state (
    site_id uuid primary key
        references public.government_sites(id) on delete cascade,
    status text not null,
    next_discovery_at timestamptz,
    lease_token uuid,
    lease_owner uuid,
    lease_until timestamptz,
    last_started_at timestamptz,
    last_completed_at timestamptz,
    last_result text,
    failure_count integer not null default 0,
    successful_discovery_count integer not null default 0,
    last_error_code text,
    last_error_detail text,
    updated_at timestamptz not null default now(),
    constraint site_discovery_state_status_valid
        check (status in ('pending', 'leased', 'succeeded', 'no_feed', 'backoff', 'disabled')),
    constraint site_discovery_state_counts_nonnegative
        check (failure_count >= 0 and successful_discovery_count >= 0),
    constraint site_discovery_state_lease_consistent
        check (
            (status = 'leased'
                and lease_token is not null
                and lease_owner is not null
                and lease_until is not null)
            or (status <> 'leased'
                and lease_token is null
                and lease_owner is null
                and lease_until is null)
        ),
    constraint site_discovery_state_disabled_not_due
        check (status <> 'disabled' or next_discovery_at is null)
);

comment on table public.site_discovery_state is
    'Lease-based, per-site scheduling state for bounded feed discovery.';

create index site_discovery_state_due_idx
    on public.site_discovery_state (next_discovery_at, site_id)
    where status in ('pending', 'succeeded', 'no_feed', 'backoff');

create index site_discovery_state_lease_until_idx
    on public.site_discovery_state (lease_until)
    where status = 'leased';

create view public.usable_government_sites
with (security_invoker = true)
as
select
    id,
    source,
    source_initial_url,
    initial_url,
    base_domain,
    top_level_domain,
    branch,
    agency,
    bureau,
    first_seen_at,
    last_seen_at,
    last_sync_run_id
from public.government_sites
where inventory_active and not gsa_filtered and inventory_usable;

comment on view public.usable_government_sites is
    'Active, unfiltered government sites eligible for discovery.';

alter table public.inventory_sync_runs enable row level security;
alter table public.government_sites enable row level security;
alter table public.site_discovery_state enable row level security;

revoke all privileges on table public.inventory_sync_runs
    from public, anon, authenticated, service_role;
revoke all privileges on table public.government_sites
    from public, anon, authenticated, service_role;
revoke all privileges on table public.site_discovery_state
    from public, anon, authenticated, service_role;
revoke all privileges on table public.usable_government_sites
    from public, anon, authenticated, service_role;
revoke all privileges on table private.gsa_inventory_stage
    from public, anon, authenticated, service_role;

grant select on table public.inventory_sync_runs to service_role;
grant select on table public.government_sites, public.site_discovery_state,
    public.usable_government_sites to service_role;

create or replace function public.begin_gsa_inventory_sync(
    p_source_url text
)
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
    v_run_id uuid;
begin
    if p_source_url is null
       or length(p_source_url) > 2048
       or p_source_url !~ '^https://[^[:space:]]+$' then
        raise exception using
            errcode = '22023',
            message = 'source URL must be a valid bounded HTTPS URL';
    end if;

    insert into public.inventory_sync_runs (
        source,
        source_url,
        status
    ) values (
        'gsa_federal_website_index',
        p_source_url,
        'running'
    )
    returning id into v_run_id;

    return v_run_id;
end;
$$;

create or replace function public.record_gsa_inventory_snapshot(
    p_sync_run_id uuid,
    p_source_etag text,
    p_source_sha256 text,
    p_raw_artifact_key text,
    p_source_row_count integer
)
returns void
language plpgsql
security definer
set search_path = ''
as $$
begin
    if p_sync_run_id is null then
        raise exception using
            errcode = '22004',
            message = 'sync_run_id is required';
    end if;

    if p_source_sha256 is null or p_source_sha256 !~ '^[0-9a-f]{64}$' then
        raise exception using
            errcode = '22023',
            message = 'source SHA-256 is invalid';
    end if;

    if p_raw_artifact_key is null
       or length(btrim(p_raw_artifact_key)) = 0
       or length(p_raw_artifact_key) > 1024 then
        raise exception using
            errcode = '22023',
            message = 'raw artifact key is invalid';
    end if;

    if p_source_etag is not null and length(p_source_etag) > 1024 then
        raise exception using
            errcode = '22023',
            message = 'source ETag is too long';
    end if;

    if p_source_row_count < 1 or p_source_row_count > 1000000 then
        raise exception using
            errcode = '22023',
            message = 'source row count must be between 1 and 1000000';
    end if;

    update public.inventory_sync_runs
    set
        source_etag = p_source_etag,
        source_sha256 = p_source_sha256,
        raw_artifact_key = p_raw_artifact_key,
        source_row_count = p_source_row_count
    where id = p_sync_run_id
      and source = 'gsa_federal_website_index'
      and status = 'running';

    if not found then
        raise exception using
            errcode = '55000',
            message = 'GSA inventory sync run is not running';
    end if;
end;
$$;

create or replace function public.mark_gsa_inventory_sync_unchanged(
    p_sync_run_id uuid,
    p_source_etag text,
    p_source_sha256 text,
    p_source_row_count integer,
    p_eligible_count integer
)
returns void
language plpgsql
security definer
set search_path = ''
as $$
begin
    if p_sync_run_id is null
       or p_source_sha256 is null
       or p_source_sha256 !~ '^[0-9a-f]{64}$'
       or p_source_row_count < 1
       or p_source_row_count > 1000000
       or p_eligible_count < 0
       or p_eligible_count > p_source_row_count
       or (p_source_etag is not null and length(p_source_etag) > 1024) then
        raise exception using
            errcode = '22023',
            message = 'unchanged inventory metadata is invalid';
    end if;

    if not exists (
        select 1
        from public.inventory_sync_runs as prior
        where prior.id <> p_sync_run_id
          and prior.source = 'gsa_federal_website_index'
          and prior.status = 'succeeded'
          and prior.source_sha256 = p_source_sha256
          and prior.source_row_count = p_source_row_count
    ) then
        raise exception using
            errcode = '55000',
            message = 'unchanged snapshot has no matching successful run';
    end if;

    update public.inventory_sync_runs
    set
        status = 'unchanged',
        source_etag = p_source_etag,
        source_sha256 = p_source_sha256,
        source_row_count = p_source_row_count,
        eligible_count = p_eligible_count,
        completed_at = pg_catalog.now()
    where id = p_sync_run_id
      and source = 'gsa_federal_website_index'
      and status = 'running';

    if not found then
        raise exception using
            errcode = '55000',
            message = 'GSA inventory sync run is not running';
    end if;
end;
$$;

create or replace function public.fail_gsa_inventory_sync(
    p_sync_run_id uuid,
    p_error_code text,
    p_error_detail text
)
returns void
language plpgsql
security definer
set search_path = ''
as $$
begin
    if p_sync_run_id is null
       or p_error_code is null
       or length(btrim(p_error_code)) = 0
       or length(p_error_code) > 128
       or p_error_detail is null
       or length(p_error_detail) > 1000 then
        raise exception using
            errcode = '22023',
            message = 'inventory failure metadata is invalid';
    end if;

    update public.inventory_sync_runs
    set
        status = 'failed',
        error_code = p_error_code,
        error_detail = p_error_detail,
        completed_at = pg_catalog.now()
    where id = p_sync_run_id
      and source = 'gsa_federal_website_index'
      and status = 'running';

    if not found then
        raise exception using
            errcode = '55000',
            message = 'GSA inventory sync run is not running';
    end if;
end;
$$;

create or replace function public.get_government_inventory_summary()
returns table (
    total_count bigint,
    active_count bigint,
    usable_count bigint,
    gsa_filtered_count bigint,
    ingestion_excluded_count bigint,
    inactive_count bigint,
    discovery_pending_count bigint,
    discovery_leased_count bigint,
    discovery_backoff_count bigint,
    latest_success_at timestamptz,
    latest_source_sha256 text
)
language sql
stable
security definer
set search_path = ''
as $$
    select
        count(*) as total_count,
        count(*) filter (where site.inventory_active) as active_count,
        count(*) filter (
            where site.inventory_active
              and not site.gsa_filtered
              and site.inventory_usable
        ) as usable_count,
        count(*) filter (
            where site.inventory_active and site.gsa_filtered
        ) as gsa_filtered_count,
        count(*) filter (
            where site.inventory_active and not site.inventory_usable
        ) as ingestion_excluded_count,
        count(*) filter (where not site.inventory_active) as inactive_count,
        count(*) filter (where state.status = 'pending') as discovery_pending_count,
        count(*) filter (where state.status = 'leased') as discovery_leased_count,
        count(*) filter (where state.status = 'backoff') as discovery_backoff_count,
        (
            select run.completed_at
            from public.inventory_sync_runs as run
            where run.source = 'gsa_federal_website_index'
              and run.status = 'succeeded'
            order by run.completed_at desc
            limit 1
        ) as latest_success_at,
        (
            select run.source_sha256
            from public.inventory_sync_runs as run
            where run.source = 'gsa_federal_website_index'
              and run.status = 'succeeded'
            order by run.completed_at desc
            limit 1
        ) as latest_source_sha256
    from public.government_sites as site
    left join public.site_discovery_state as state on state.site_id = site.id;
$$;

create or replace function public.list_government_sites(
    p_after_id uuid default null,
    p_limit integer default 100,
    p_usable_only boolean default true,
    p_inventory_active boolean default null,
    p_agency text default null,
    p_base_domain text default null,
    p_initial_url text default null
)
returns table (
    id uuid,
    source_initial_url text,
    initial_url text,
    base_domain text,
    top_level_domain text,
    branch text,
    agency text,
    bureau text,
    gsa_filtered boolean,
    inventory_usable boolean,
    exclusion_reason text,
    inventory_active boolean,
    first_seen_at timestamptz,
    last_seen_at timestamptz,
    discovery_status text,
    next_discovery_at timestamptz
)
language plpgsql
stable
security definer
set search_path = ''
as $$
begin
    if p_limit < 1 or p_limit > 1000 then
        raise exception using
            errcode = '22023',
            message = 'limit must be between 1 and 1000';
    end if;

    return query
    select
        site.id,
        site.source_initial_url,
        site.initial_url,
        site.base_domain,
        site.top_level_domain,
        site.branch,
        site.agency,
        site.bureau,
        site.gsa_filtered,
        site.inventory_usable,
        site.exclusion_reason,
        site.inventory_active,
        site.first_seen_at,
        site.last_seen_at,
        state.status,
        state.next_discovery_at
    from public.government_sites as site
    left join public.site_discovery_state as state on state.site_id = site.id
    where (p_after_id is null or site.id > p_after_id)
      and (
          not p_usable_only
          or (
              site.inventory_active
              and not site.gsa_filtered
              and site.inventory_usable
          )
      )
      and (p_inventory_active is null or site.inventory_active = p_inventory_active)
      and (p_agency is null or site.agency = p_agency)
      and (p_base_domain is null or site.base_domain = lower(btrim(p_base_domain)))
      and (p_initial_url is null or site.initial_url = lower(btrim(p_initial_url)))
    order by site.id
    limit p_limit;
end;
$$;

create or replace function public.stage_gsa_inventory_batch(
    p_sync_run_id uuid,
    p_rows jsonb
)
returns integer
language plpgsql
security definer
set search_path = ''
as $$
declare
    v_row_count integer;
    v_staged_count integer;
begin
    if p_sync_run_id is null then
        raise exception using
            errcode = '22004',
            message = 'sync_run_id is required';
    end if;

    if jsonb_typeof(p_rows) <> 'array' then
        raise exception using
            errcode = '22023',
            message = 'rows must be a JSON array';
    end if;

    v_row_count := jsonb_array_length(p_rows);
    if v_row_count < 1 or v_row_count > 1000 then
        raise exception using
            errcode = '22023',
            message = 'rows must contain between 1 and 1000 records';
    end if;

    perform 1
    from public.inventory_sync_runs as run
    where run.id = p_sync_run_id
      and run.source = 'gsa_federal_website_index'
      and run.status = 'running'
    for update;

    if not found then
        raise exception using
            errcode = '55000',
            message = 'GSA inventory sync run is not running';
    end if;

    if exists (
        select 1
        from jsonb_array_elements(p_rows) as item(value)
        where jsonb_typeof(item.value) <> 'object'
    ) then
        raise exception using
            errcode = '22023',
            message = 'each staged row must be a JSON object';
    end if;

    if (
        select count(distinct parsed.source_row_number)
        from jsonb_to_recordset(p_rows) as parsed(
            source_row_number integer,
            source_initial_url text,
            initial_url text,
            base_domain text,
            top_level_domain text,
            branch text,
            agency text,
            bureau text,
            gsa_filtered boolean,
            inventory_usable boolean,
            exclusion_reason text,
            source_record jsonb,
            source_row_hash text,
            discovery_input_hash text
        )
    ) <> v_row_count then
        raise exception using
            errcode = '23505',
            message = 'source row numbers must be unique within a staging batch';
    end if;

    insert into private.gsa_inventory_stage (
        sync_run_id,
        source_row_number,
        source_initial_url,
        initial_url,
        base_domain,
        top_level_domain,
        branch,
        agency,
        bureau,
        gsa_filtered,
        inventory_usable,
        exclusion_reason,
        source_record,
        source_row_hash,
        discovery_input_hash
    )
    select
        p_sync_run_id,
        parsed.source_row_number,
        parsed.source_initial_url,
        parsed.initial_url,
        parsed.base_domain,
        parsed.top_level_domain,
        parsed.branch,
        parsed.agency,
        parsed.bureau,
        parsed.gsa_filtered,
        parsed.inventory_usable,
        parsed.exclusion_reason,
        parsed.source_record,
        parsed.source_row_hash,
        parsed.discovery_input_hash
    from jsonb_to_recordset(p_rows) as parsed(
        source_row_number integer,
        source_initial_url text,
        initial_url text,
        base_domain text,
        top_level_domain text,
        branch text,
        agency text,
        bureau text,
        gsa_filtered boolean,
        inventory_usable boolean,
        exclusion_reason text,
        source_record jsonb,
        source_row_hash text,
        discovery_input_hash text
    )
    on conflict (sync_run_id, source_row_number) do nothing;

    if exists (
        select 1
        from jsonb_to_recordset(p_rows) as parsed(
            source_row_number integer,
            source_initial_url text,
            initial_url text,
            base_domain text,
            top_level_domain text,
            branch text,
            agency text,
            bureau text,
            gsa_filtered boolean,
            inventory_usable boolean,
            exclusion_reason text,
            source_record jsonb,
            source_row_hash text,
            discovery_input_hash text
        )
        join private.gsa_inventory_stage as staged
          on staged.sync_run_id = p_sync_run_id
         and staged.source_row_number = parsed.source_row_number
        where row(
            staged.source_initial_url,
            staged.initial_url,
            staged.base_domain,
            staged.top_level_domain,
            staged.branch,
            staged.agency,
            staged.bureau,
            staged.gsa_filtered,
            staged.inventory_usable,
            staged.exclusion_reason,
            staged.source_record,
            staged.source_row_hash,
            staged.discovery_input_hash
        ) is distinct from row(
            parsed.source_initial_url,
            parsed.initial_url,
            parsed.base_domain,
            parsed.top_level_domain,
            parsed.branch,
            parsed.agency,
            parsed.bureau,
            parsed.gsa_filtered,
            parsed.inventory_usable,
            parsed.exclusion_reason,
            parsed.source_record,
            parsed.source_row_hash,
            parsed.discovery_input_hash
        )
    ) then
        raise exception using
            errcode = '23505',
            message = 'staging replay conflicts with an existing source row';
    end if;

    select count(*)::integer
    into v_staged_count
    from private.gsa_inventory_stage
    where sync_run_id = p_sync_run_id;

    update public.inventory_sync_runs
    set staged_count = v_staged_count
    where id = p_sync_run_id;

    return v_staged_count;
end;
$$;

create or replace function public.finalize_gsa_inventory_sync(
    p_sync_run_id uuid,
    p_minimum_row_count integer default 20000,
    p_allow_large_decrease boolean default false
)
returns table (
    inserted_count integer,
    updated_count integer,
    reactivated_count integer,
    deactivated_count integer,
    eligible_count integer
)
language plpgsql
security definer
set search_path = ''
as $$
declare
    v_run public.inventory_sync_runs%rowtype;
    v_actual_staged_count integer;
    v_previous_row_count integer;
    v_inserted_count integer := 0;
    v_updated_count integer := 0;
    v_reactivated_count integer := 0;
    v_deactivated_count integer := 0;
    v_eligible_count integer := 0;
    v_due_source_initial_urls text[] := '{}'::text[];
begin
    if p_sync_run_id is null then
        raise exception using
            errcode = '22004',
            message = 'sync_run_id is required';
    end if;

    if p_minimum_row_count < 1000 or p_minimum_row_count > 1000000 then
        raise exception using
            errcode = '22023',
            message = 'minimum row count must be between 1000 and 1000000';
    end if;

    if not pg_catalog.pg_try_advisory_xact_lock(
        pg_catalog.hashtextextended('gsa_federal_website_index:finalize', 0)
    ) then
        raise exception using
            errcode = '55P03',
            message = 'another GSA inventory finalization is running';
    end if;

    select *
    into v_run
    from public.inventory_sync_runs
    where id = p_sync_run_id
    for update;

    if not found or v_run.source <> 'gsa_federal_website_index' then
        raise exception using
            errcode = '22023',
            message = 'unknown GSA inventory sync run';
    end if;

    if v_run.status = 'succeeded' then
        return query
        select
            v_run.inserted_count,
            v_run.updated_count,
            v_run.reactivated_count,
            v_run.deactivated_count,
            (
                select count(*)::integer
                from public.government_sites as site
                where site.source = 'gsa_federal_website_index'
                  and site.inventory_active
                  and not site.gsa_filtered
                  and site.inventory_usable
            );
        return;
    end if;

    if v_run.status <> 'running' then
        raise exception using
            errcode = '55000',
            message = 'GSA inventory sync run is not running';
    end if;

    if v_run.source_sha256 is null or v_run.source_row_count is null then
        raise exception using
            errcode = '23514',
            message = 'source checksum and parsed row count are required before finalization';
    end if;

    if exists (
        select 1
        from public.inventory_sync_runs as prior
        where prior.id <> v_run.id
          and prior.source = v_run.source
          and prior.status = 'succeeded'
          and prior.source_sha256 = v_run.source_sha256
    ) then
        update public.inventory_sync_runs
        set
            status = 'unchanged',
            inserted_count = 0,
            updated_count = 0,
            reactivated_count = 0,
            deactivated_count = 0,
            eligible_count = (
                select count(*)::integer
                from public.government_sites as site
                where site.source = 'gsa_federal_website_index'
                  and site.inventory_active
                  and not site.gsa_filtered
                  and site.inventory_usable
            ),
            completed_at = pg_catalog.now()
        where id = v_run.id;

        return query
        select
            0,
            0,
            0,
            0,
            (
                select count(*)::integer
                from public.government_sites as site
                where site.source = 'gsa_federal_website_index'
                  and site.inventory_active
                  and not site.gsa_filtered
                  and site.inventory_usable
            );
        return;
    end if;

    select count(*)::integer
    into v_actual_staged_count
    from private.gsa_inventory_stage
    where sync_run_id = v_run.id;

    if v_run.source_row_count <> v_run.staged_count
       or v_run.source_row_count <> v_actual_staged_count then
        raise exception using
            errcode = '23514',
            message = 'parsed and staged row counts do not match';
    end if;

    if v_actual_staged_count < p_minimum_row_count then
        raise exception using
            errcode = '23514',
            message = 'staged snapshot is below the absolute minimum row count';
    end if;

    if exists (
        select 1
        from private.gsa_inventory_stage as staged
        where staged.sync_run_id = v_run.id
          and (
              length(btrim(staged.source_initial_url)) = 0
              or length(btrim(staged.top_level_domain)) = 0
          )
    ) then
        raise exception using
            errcode = '23514',
            message = 'staged snapshot contains missing required fields';
    end if;

    if exists (
        select 1
        from private.gsa_inventory_stage as staged
        where staged.sync_run_id = v_run.id
        group by staged.source_initial_url
        having count(*) > 1
    ) then
        raise exception using
            errcode = '23505',
            message = 'staged snapshot contains duplicate source initial_url values';
    end if;

    if exists (
        select 1
        from private.gsa_inventory_stage as staged
        where staged.sync_run_id = v_run.id
          and staged.inventory_usable
        group by staged.initial_url
        having count(*) > 1
    ) then
        raise exception using
            errcode = '23505',
            message = 'staged snapshot contains duplicate normalized hostnames';
    end if;

    select prior.source_row_count
    into v_previous_row_count
    from public.inventory_sync_runs as prior
    where prior.id <> v_run.id
      and prior.source = v_run.source
      and prior.status = 'succeeded'
      and prior.source_row_count is not null
    order by prior.completed_at desc
    limit 1;

    if not p_allow_large_decrease
       and v_previous_row_count is not null
       and v_actual_staged_count < pg_catalog.ceil(v_previous_row_count * 0.8) then
        raise exception using
            errcode = '23514',
            message = 'staged snapshot is less than 80 percent of the previous successful snapshot';
    end if;

    select
        count(*) filter (where existing.id is null)::integer,
        count(*) filter (
            where existing.id is not null
              and existing.inventory_active
              and row(
                  existing.base_domain,
                  existing.top_level_domain,
                  existing.branch,
                  existing.agency,
                  existing.bureau,
                  existing.gsa_filtered,
                  existing.inventory_usable,
                  existing.exclusion_reason,
                  existing.source_row_hash,
                  existing.discovery_input_hash
              ) is distinct from row(
                  staged.base_domain,
                  staged.top_level_domain,
                  staged.branch,
                  staged.agency,
                  staged.bureau,
                  staged.gsa_filtered,
                  staged.inventory_usable,
                  staged.exclusion_reason,
                  staged.source_row_hash,
                  staged.discovery_input_hash
              )
        )::integer,
        count(*) filter (
            where existing.id is not null and not existing.inventory_active
        )::integer
    into v_inserted_count, v_updated_count, v_reactivated_count
    from private.gsa_inventory_stage as staged
    left join public.government_sites as existing
      on existing.source = 'gsa_federal_website_index'
     and existing.source_initial_url = staged.source_initial_url
    where staged.sync_run_id = v_run.id;

    select count(*)::integer
    into v_deactivated_count
    from public.government_sites as existing
    where existing.source = 'gsa_federal_website_index'
      and existing.inventory_active
      and not exists (
          select 1
          from private.gsa_inventory_stage as staged
          where staged.sync_run_id = v_run.id
            and staged.source_initial_url = existing.source_initial_url
      );

    select coalesce(array_agg(staged.source_initial_url), '{}'::text[])
    into v_due_source_initial_urls
    from private.gsa_inventory_stage as staged
    left join public.government_sites as existing
      on existing.source = 'gsa_federal_website_index'
     and existing.source_initial_url = staged.source_initial_url
    where staged.sync_run_id = v_run.id
      and not staged.gsa_filtered
      and staged.inventory_usable
      and (
          existing.id is null
          or not existing.inventory_active
          or existing.gsa_filtered
          or not existing.inventory_usable
          or existing.discovery_input_hash <> staged.discovery_input_hash
      );

    insert into public.government_sites (
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
        exclusion_reason,
        inventory_active,
        source_row_hash,
        discovery_input_hash,
        first_seen_at,
        last_seen_at,
        deactivated_at,
        last_sync_run_id
    )
    select
        'gsa_federal_website_index',
        staged.source_initial_url,
        staged.initial_url,
        staged.base_domain,
        staged.top_level_domain,
        staged.branch,
        staged.agency,
        staged.bureau,
        staged.gsa_filtered,
        staged.inventory_usable,
        staged.exclusion_reason,
        true,
        staged.source_row_hash,
        staged.discovery_input_hash,
        pg_catalog.now(),
        pg_catalog.now(),
        null,
        v_run.id
    from private.gsa_inventory_stage as staged
    where staged.sync_run_id = v_run.id
    on conflict (source, source_initial_url) do update
    set
        initial_url = excluded.initial_url,
        base_domain = excluded.base_domain,
        top_level_domain = excluded.top_level_domain,
        branch = excluded.branch,
        agency = excluded.agency,
        bureau = excluded.bureau,
        gsa_filtered = excluded.gsa_filtered,
        inventory_usable = excluded.inventory_usable,
        exclusion_reason = excluded.exclusion_reason,
        inventory_active = true,
        source_row_hash = excluded.source_row_hash,
        discovery_input_hash = excluded.discovery_input_hash,
        last_seen_at = excluded.last_seen_at,
        deactivated_at = null,
        last_sync_run_id = excluded.last_sync_run_id;

    update public.government_sites as site
    set
        inventory_active = false,
        deactivated_at = pg_catalog.now(),
        last_sync_run_id = v_run.id
    where site.source = 'gsa_federal_website_index'
      and site.inventory_active
      and not exists (
          select 1
          from private.gsa_inventory_stage as staged
          where staged.sync_run_id = v_run.id
            and staged.source_initial_url = site.source_initial_url
      );

    insert into public.site_discovery_state (
        site_id,
        status,
        next_discovery_at,
        updated_at
    )
    select
        site.id,
        case
            when site.inventory_active
                and not site.gsa_filtered
                and site.inventory_usable then 'pending'
            else 'disabled'
        end,
        case
            when site.inventory_active
                and not site.gsa_filtered
                and site.inventory_usable then pg_catalog.now()
            else null
        end,
        pg_catalog.now()
    from public.government_sites as site
    where site.source = 'gsa_federal_website_index'
      and site.last_sync_run_id = v_run.id
    on conflict (site_id) do nothing;

    update public.site_discovery_state as state
    set
        status = 'disabled',
        next_discovery_at = null,
        lease_token = null,
        lease_owner = null,
        lease_until = null,
        updated_at = pg_catalog.now()
    from public.government_sites as site
    where site.id = state.site_id
      and site.source = 'gsa_federal_website_index'
      and (not site.inventory_active or site.gsa_filtered or not site.inventory_usable)
      and state.status <> 'disabled';

    update public.site_discovery_state as state
    set
        status = 'pending',
        next_discovery_at = pg_catalog.now(),
        lease_token = null,
        lease_owner = null,
        lease_until = null,
        last_error_code = null,
        last_error_detail = null,
        updated_at = pg_catalog.now()
    from public.government_sites as site
    where site.id = state.site_id
      and site.source = 'gsa_federal_website_index'
      and site.inventory_active
      and not site.gsa_filtered
      and site.inventory_usable
      and site.source_initial_url = any(v_due_source_initial_urls);

    select count(*)::integer
    into v_eligible_count
    from public.government_sites as site
    where site.source = 'gsa_federal_website_index'
      and site.inventory_active
      and not site.gsa_filtered
      and site.inventory_usable;

    update public.inventory_sync_runs
    set
        status = 'succeeded',
        inserted_count = v_inserted_count,
        updated_count = v_updated_count,
        reactivated_count = v_reactivated_count,
        deactivated_count = v_deactivated_count,
        eligible_count = v_eligible_count,
        completed_at = pg_catalog.now()
    where id = v_run.id;

    return query
    select
        v_inserted_count,
        v_updated_count,
        v_reactivated_count,
        v_deactivated_count,
        v_eligible_count;
end;
$$;

create or replace function public.recover_expired_site_discovery_leases()
returns integer
language plpgsql
security definer
set search_path = ''
as $$
declare
    v_recovered_count integer;
begin
    update public.site_discovery_state
    set
        status = case when failure_count > 0 then 'backoff' else 'pending' end,
        next_discovery_at = pg_catalog.now(),
        lease_token = null,
        lease_owner = null,
        lease_until = null,
        updated_at = pg_catalog.now()
    where status = 'leased'
      and lease_until <= pg_catalog.now();

    get diagnostics v_recovered_count = row_count;
    return v_recovered_count;
end;
$$;

create or replace function public.claim_due_site_discoveries(
    p_worker_id uuid,
    p_claim_limit integer default 1,
    p_lease_seconds integer default 300
)
returns table (
    site_id uuid,
    initial_url text,
    base_domain text,
    lease_token uuid,
    lease_until timestamptz
)
language plpgsql
security definer
set search_path = ''
as $$
begin
    if p_worker_id is null then
        raise exception using
            errcode = '22004',
            message = 'worker_id is required';
    end if;

    if p_claim_limit < 1 or p_claim_limit > 25 then
        raise exception using
            errcode = '22023',
            message = 'claim limit must be between 1 and 25';
    end if;

    if p_lease_seconds < 30 or p_lease_seconds > 3600 then
        raise exception using
            errcode = '22023',
            message = 'lease seconds must be between 30 and 3600';
    end if;

    perform public.recover_expired_site_discovery_leases();

    return query
    with ranked_due as (
        select
            state.site_id,
            state.next_discovery_at,
            site.base_domain,
            row_number() over (
                partition by site.base_domain
                order by state.next_discovery_at, state.site_id
            ) as domain_rank
        from public.site_discovery_state as state
        join public.government_sites as site on site.id = state.site_id
        where state.status in ('pending', 'succeeded', 'no_feed', 'backoff')
          and state.next_discovery_at <= pg_catalog.now()
          and site.inventory_active
          and not site.gsa_filtered
          and site.inventory_usable
          and site.initial_url is not null
          and site.base_domain is not null
          and not exists (
              select 1
              from public.site_discovery_state as active_lease
              join public.government_sites as leased_site
                on leased_site.id = active_lease.site_id
              where active_lease.status = 'leased'
                and active_lease.lease_until > pg_catalog.now()
                and leased_site.base_domain = site.base_domain
          )
    ),
    candidates as (
        select ranked_due.site_id
        from ranked_due
        where ranked_due.domain_rank = 1
        order by ranked_due.next_discovery_at, ranked_due.site_id
        limit p_claim_limit
    ),
    locked as (
        select state.site_id
        from public.site_discovery_state as state
        join candidates on candidates.site_id = state.site_id
        for update of state skip locked
    ),
    claimed as (
        update public.site_discovery_state as state
        set
            status = 'leased',
            lease_token = gen_random_uuid(),
            lease_owner = p_worker_id,
            lease_until = pg_catalog.now() + pg_catalog.make_interval(secs => p_lease_seconds),
            last_started_at = pg_catalog.now(),
            updated_at = pg_catalog.now()
        from locked
        where state.site_id = locked.site_id
        returning state.site_id, state.lease_token, state.lease_until
    )
    select
        claimed.site_id,
        site.initial_url,
        site.base_domain,
        claimed.lease_token,
        claimed.lease_until
    from claimed
    join public.government_sites as site on site.id = claimed.site_id
    order by site.initial_url;
end;
$$;

revoke all on function public.stage_gsa_inventory_batch(uuid, jsonb)
    from public, anon, authenticated;
revoke all on function public.begin_gsa_inventory_sync(text)
    from public, anon, authenticated;
revoke all on function public.record_gsa_inventory_snapshot(uuid, text, text, text, integer)
    from public, anon, authenticated;
revoke all on function public.mark_gsa_inventory_sync_unchanged(uuid, text, text, integer, integer)
    from public, anon, authenticated;
revoke all on function public.fail_gsa_inventory_sync(uuid, text, text)
    from public, anon, authenticated;
revoke all on function public.get_government_inventory_summary()
    from public, anon, authenticated;
revoke all on function public.list_government_sites(uuid, integer, boolean, boolean, text, text, text)
    from public, anon, authenticated;
revoke all on function public.finalize_gsa_inventory_sync(uuid, integer, boolean)
    from public, anon, authenticated;
revoke all on function public.recover_expired_site_discovery_leases()
    from public, anon, authenticated;
revoke all on function public.claim_due_site_discoveries(uuid, integer, integer)
    from public, anon, authenticated;

grant execute on function public.stage_gsa_inventory_batch(uuid, jsonb)
    to service_role;
grant execute on function public.begin_gsa_inventory_sync(text)
    to service_role;
grant execute on function public.record_gsa_inventory_snapshot(uuid, text, text, text, integer)
    to service_role;
grant execute on function public.mark_gsa_inventory_sync_unchanged(uuid, text, text, integer, integer)
    to service_role;
grant execute on function public.fail_gsa_inventory_sync(uuid, text, text)
    to service_role;
grant execute on function public.get_government_inventory_summary()
    to service_role;
grant execute on function public.list_government_sites(uuid, integer, boolean, boolean, text, text, text)
    to service_role;
grant execute on function public.finalize_gsa_inventory_sync(uuid, integer, boolean)
    to service_role;
grant execute on function public.recover_expired_site_discovery_leases()
    to service_role;
grant execute on function public.claim_due_site_discoveries(uuid, integer, integer)
    to service_role;

commit;
