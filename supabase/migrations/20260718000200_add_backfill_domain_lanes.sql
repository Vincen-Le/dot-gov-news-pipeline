begin;

drop function public.claim_due_site_discoveries(uuid, integer, integer, boolean);

create function public.claim_due_site_discoveries(
    p_worker_id uuid,
    p_claim_limit integer default 1,
    p_lease_seconds integer default 300,
    p_pending_only boolean default false,
    p_max_per_base_domain integer default 1
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
    if p_max_per_base_domain is null then
        raise exception using errcode = '22004',
            message = 'maximum per base domain is required';
    end if;
    if p_max_per_base_domain < 1 or p_max_per_base_domain > 25 then
        raise exception using errcode = '22023',
            message = 'maximum per base domain must be between 1 and 25';
    end if;
    if not p_pending_only and p_max_per_base_domain <> 1 then
        raise exception using errcode = '22023',
            message = 'wider base-domain lanes require pending-only mode';
    end if;

    -- The active-domain count is a negative predicate. Serialize claim
    -- transactions so concurrent snapshots cannot both fill the same lane.
    if not pg_catalog.pg_try_advisory_xact_lock(1732577068, 1) then
        return;
    end if;

    perform public.recover_expired_site_discovery_leases();

    return query
    with active_domains as (
        select
            leased_site.base_domain,
            count(*)::integer as active_count
        from public.site_discovery_state as active_lease
        join public.government_sites as leased_site
          on leased_site.id = active_lease.site_id
        where active_lease.status = 'leased'
          and active_lease.lease_until > pg_catalog.now()
          and leased_site.base_domain is not null
        group by leased_site.base_domain
    ),
    ranked_due as (
        select
            state.site_id,
            state.next_discovery_at,
            site.base_domain,
            coalesce(active_domain.active_count, 0) as active_count,
            row_number() over (
                partition by site.base_domain
                order by state.next_discovery_at, state.site_id
            ) as domain_rank
        from public.site_discovery_state as state
        join public.government_sites as site on site.id = state.site_id
        left join active_domains as active_domain
          on active_domain.base_domain = site.base_domain
        where state.status in ('pending', 'succeeded', 'no_feed', 'backoff')
          and (not p_pending_only or state.status = 'pending')
          and state.next_discovery_at <= pg_catalog.now()
          and site.inventory_active and not site.gsa_filtered
          and site.inventory_usable and site.initial_url is not null
          and site.base_domain is not null
          and coalesce(active_domain.active_count, 0) < p_max_per_base_domain
    ),
    candidates as (
        select ranked_due.site_id
        from ranked_due
        where ranked_due.domain_rank
            <= p_max_per_base_domain - ranked_due.active_count
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

comment on function public.claim_due_site_discoveries(
    uuid, integer, integer, boolean, integer
)
is 'Claims due site discovery work with a bounded base-domain lane count; recurring callers default to one lane and pending-only backfills may opt into more.';

revoke all on function public.claim_due_site_discoveries(
    uuid, integer, integer, boolean, integer
)
    from public, anon, authenticated;
grant execute on function public.claim_due_site_discoveries(
    uuid, integer, integer, boolean, integer
)
    to service_role;

commit;
