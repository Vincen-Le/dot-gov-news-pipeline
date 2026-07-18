begin;

drop function public.claim_due_site_discoveries(uuid, integer, integer);

create function public.claim_due_site_discoveries(
    p_worker_id uuid,
    p_claim_limit integer default 1,
    p_lease_seconds integer default 300,
    p_pending_only boolean default false
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
        raise exception using errcode = '22004', message = 'worker_id is required';
    end if;
    if p_claim_limit is null or p_claim_limit < 1 or p_claim_limit > 25 then
        raise exception using errcode = '22023',
            message = 'claim limit must be between 1 and 25';
    end if;
    if p_lease_seconds is null or p_lease_seconds < 30 or p_lease_seconds > 3600 then
        raise exception using errcode = '22023',
            message = 'lease seconds must be between 30 and 3600';
    end if;
    if p_pending_only is null then
        raise exception using errcode = '22004',
            message = 'pending-only mode is required';
    end if;

    -- The selection predicate depends on the absence of an active sibling
    -- lease. Serialize claim transactions so concurrent snapshots cannot both
    -- observe that absence for the same base domain.
    if not pg_catalog.pg_try_advisory_xact_lock(1732577068, 1) then
        return;
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
          and (not p_pending_only or state.status = 'pending')
          and state.next_discovery_at <= pg_catalog.now()
          and site.inventory_active and not site.gsa_filtered
          and site.inventory_usable and site.initial_url is not null
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
        set status = 'leased',
            lease_token = gen_random_uuid(),
            lease_owner = p_worker_id,
            lease_until = pg_catalog.now()
                + pg_catalog.make_interval(secs => p_lease_seconds),
            last_started_at = pg_catalog.now(),
            updated_at = pg_catalog.now()
        from locked
        where state.site_id = locked.site_id
        returning state.site_id, state.lease_token, state.lease_until
    )
    select claimed.site_id, site.initial_url, site.base_domain,
        claimed.lease_token, claimed.lease_until
    from claimed
    join public.government_sites as site on site.id = claimed.site_id
    order by site.initial_url;
end;
$$;

comment on function public.claim_due_site_discoveries(uuid, integer, integer, boolean)
is 'Claims due site discovery work by distinct base domain; pending-only mode is reserved for initial backfills.';

revoke all on function public.claim_due_site_discoveries(uuid, integer, integer, boolean)
    from public, anon, authenticated;
grant execute on function public.claim_due_site_discoveries(uuid, integer, integer, boolean)
    to service_role;

commit;
