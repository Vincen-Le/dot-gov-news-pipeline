begin;

alter table public.site_discovery_state
    add column last_final_url text,
    add column last_http_status integer,
    add column last_duration_ms integer,
    add column last_policy_version integer,
    add constraint site_discovery_state_last_final_url_bounded
        check (last_final_url is null or length(last_final_url) between 1 and 2048),
    add constraint site_discovery_state_last_http_status_valid
        check (last_http_status is null or last_http_status between 100 and 599),
    add constraint site_discovery_state_last_duration_valid
        check (last_duration_ms is null or last_duration_ms between 0 and 3600000),
    add constraint site_discovery_state_last_policy_version_valid
        check (last_policy_version is null or last_policy_version > 0);

create table public.feeds (
    id uuid primary key default gen_random_uuid(),
    canonical_url text not null unique
        check (length(canonical_url) between 1 and 2048),
    feed_type text not null check (feed_type in ('rss', 'atom', 'json_feed')),
    title text check (title is null or length(title) <= 512),
    home_page_url text
        check (home_page_url is null or length(home_page_url) between 1 and 2048),
    status text not null default 'active'
        check (status in ('active', 'invalid', 'gone', 'suppressed')),
    last_http_status integer
        check (last_http_status is null or last_http_status between 100 and 599),
    first_seen_at timestamptz not null default now(),
    last_seen_at timestamptz not null default now(),
    last_validated_at timestamptz not null default now(),
    created_at timestamptz not null default now(),
    updated_at timestamptz not null default now()
);

comment on table public.feeds is
    'Globally canonical feed endpoints discovered from government sites.';

create index feeds_status_last_validated_idx
    on public.feeds (status, last_validated_at);

create table public.government_site_feeds (
    site_id uuid not null references public.government_sites(id) on delete cascade,
    feed_id uuid not null references public.feeds(id) on delete cascade,
    discovery_method text not null check (discovery_method in (
        'http_link', 'html_alternate', 'anchor', 'conventional_path',
        'root_document'
    )),
    discovery_url text not null check (length(discovery_url) between 1 and 2048),
    active boolean not null default true,
    missing_success_count integer not null default 0
        check (missing_success_count >= 0),
    first_seen_at timestamptz not null default now(),
    last_seen_at timestamptz not null default now(),
    updated_at timestamptz not null default now(),
    primary key (site_id, feed_id)
);

comment on table public.government_site_feeds is
    'Many-to-many provenance between inventory sites and canonical feeds.';

create index government_site_feeds_feed_active_idx
    on public.government_site_feeds (feed_id, active);

create table public.feed_fetch_state (
    feed_id uuid primary key references public.feeds(id) on delete cascade,
    status text not null default 'pending'
        check (status in ('pending', 'leased', 'active', 'backoff', 'disabled')),
    next_fetch_at timestamptz,
    lease_token uuid,
    lease_owner uuid,
    lease_until timestamptz,
    etag text check (etag is null or length(etag) <= 1024),
    last_modified text check (last_modified is null or length(last_modified) <= 1024),
    last_success_at timestamptz,
    last_new_item_at timestamptz,
    failure_count integer not null default 0 check (failure_count >= 0),
    updated_at timestamptz not null default now(),
    constraint feed_fetch_state_lease_consistent check (
        (status = 'leased' and lease_token is not null
            and lease_owner is not null and lease_until is not null)
        or (status <> 'leased' and lease_token is null
            and lease_owner is null and lease_until is null)
    )
);

comment on table public.feed_fetch_state is
    'Durable polling handoff state; discovery seeds it but never claims it.';

create index feed_fetch_state_due_idx
    on public.feed_fetch_state (next_fetch_at, feed_id)
    where status in ('pending', 'active', 'backoff');

alter table public.feeds enable row level security;
alter table public.government_site_feeds enable row level security;
alter table public.feed_fetch_state enable row level security;

revoke all privileges on table public.feeds
    from public, anon, authenticated, service_role;
revoke all privileges on table public.government_site_feeds
    from public, anon, authenticated, service_role;
revoke all privileges on table public.feed_fetch_state
    from public, anon, authenticated, service_role;
grant select on table public.feeds, public.government_site_feeds,
    public.feed_fetch_state to service_role;

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

create or replace function public.renew_site_discovery_lease(
    p_site_id uuid,
    p_lease_token uuid,
    p_lease_seconds integer
)
returns timestamptz
language plpgsql
security definer
set search_path = ''
as $$
declare
    v_lease_until timestamptz;
begin
    if p_site_id is null or p_lease_token is null then
        raise exception using errcode = '22004',
            message = 'site ID and lease token are required';
    end if;
    if p_lease_seconds is null or p_lease_seconds < 30 or p_lease_seconds > 3600 then
        raise exception using errcode = '22023',
            message = 'lease seconds must be between 30 and 3600';
    end if;

    update public.site_discovery_state as state
    set lease_until = pg_catalog.now()
            + pg_catalog.make_interval(secs => p_lease_seconds),
        updated_at = pg_catalog.now()
    from public.government_sites as site
    where state.site_id = p_site_id and state.site_id = site.id
      and state.status = 'leased' and state.lease_token = p_lease_token
      and state.lease_until > pg_catalog.now()
      and site.inventory_active and not site.gsa_filtered and site.inventory_usable
    returning state.lease_until into v_lease_until;
    return v_lease_until;
end;
$$;

create or replace function public.release_site_discovery_lease(
    p_site_id uuid,
    p_lease_token uuid,
    p_reason_code text
)
returns boolean
language plpgsql
security definer
set search_path = ''
as $$
begin
    if p_site_id is null or p_lease_token is null then
        raise exception using errcode = '22004',
            message = 'site ID and lease token are required';
    end if;
    if p_reason_code is null
       or length(btrim(p_reason_code)) not between 1 and 128 then
        raise exception using errcode = '22023',
            message = 'release reason code is invalid';
    end if;

    update public.site_discovery_state
    set status = 'pending', next_discovery_at = pg_catalog.now(),
        lease_token = null, lease_owner = null, lease_until = null,
        updated_at = pg_catalog.now()
    where site_id = p_site_id and status = 'leased'
      and lease_token = p_lease_token;
    return found;
end;
$$;

create or replace function public.complete_site_discovery(
    p_site_id uuid,
    p_lease_token uuid,
    p_result text,
    p_site_health jsonb,
    p_feeds jsonb,
    p_policy_version integer
)
returns boolean
language plpgsql
security definer
set search_path = ''
as $$
declare
    v_state public.site_discovery_state%rowtype;
    v_feed_count integer;
    v_interval_seconds integer;
    v_jitter_seconds integer;
begin
    if p_site_id is null or p_lease_token is null then
        raise exception using errcode = '22004',
            message = 'site ID and lease token are required';
    end if;
    if p_result is null
       or p_result not in ('succeeded', 'no_feed')
       or coalesce(p_policy_version, 0) < 1
       or p_site_health is null
       or pg_catalog.jsonb_typeof(p_site_health) is distinct from 'object'
       or p_feeds is null
       or pg_catalog.jsonb_typeof(p_feeds) is distinct from 'array' then
        raise exception using errcode = '22023',
            message = 'discovery completion metadata is invalid';
    end if;

    v_feed_count := pg_catalog.jsonb_array_length(p_feeds);
    if v_feed_count > 10
       or (p_result = 'succeeded' and v_feed_count = 0)
       or (p_result = 'no_feed' and v_feed_count <> 0) then
        raise exception using errcode = '22023',
            message = 'discovery result and feed count are inconsistent';
    end if;

    if p_site_health - array['final_url', 'http_status', 'duration_ms'] <> '{}'::jsonb
       or (p_site_health ? 'final_url' and case
            when pg_catalog.jsonb_typeof(p_site_health -> 'final_url') = 'string'
            then length(p_site_health ->> 'final_url') not between 1 and 2048
                or (p_site_health ->> 'final_url') !~ '^https?://'
            else true end)
       or (p_site_health ? 'http_status' and case
            when pg_catalog.jsonb_typeof(p_site_health -> 'http_status') = 'number'
            then (p_site_health ->> 'http_status')::numeric
                    <> pg_catalog.trunc((p_site_health ->> 'http_status')::numeric)
                or (p_site_health ->> 'http_status')::numeric not between 100 and 599
            else true end)
       or (p_site_health ? 'duration_ms' and case
            when pg_catalog.jsonb_typeof(p_site_health -> 'duration_ms') = 'number'
            then (p_site_health ->> 'duration_ms')::numeric
                    <> pg_catalog.trunc((p_site_health ->> 'duration_ms')::numeric)
                or (p_site_health ->> 'duration_ms')::numeric not between 0 and 3600000
            else true end) then
        raise exception using errcode = '22023',
            message = 'site health payload is invalid';
    end if;

    if exists (
        select 1
        from pg_catalog.jsonb_array_elements(p_feeds) as item(value)
        where pg_catalog.jsonb_typeof(item.value) <> 'object'
           or item.value - array[
               'canonical_url', 'feed_type', 'title', 'home_page_url',
               'http_status', 'discovery_method', 'discovery_url'
           ] <> '{}'::jsonb
           or coalesce(length(item.value ->> 'canonical_url') between 1 and 2048, false) = false
           or coalesce((item.value ->> 'canonical_url') ~ '^https?://', false) = false
           or coalesce(item.value ->> 'feed_type' in ('rss', 'atom', 'json_feed'), false) = false
           or coalesce(item.value ->> 'discovery_method' in (
               'http_link', 'html_alternate', 'anchor', 'conventional_path',
               'root_document'
           ), false) = false
           or coalesce(length(item.value ->> 'discovery_url') between 1 and 2048, false) = false
           or coalesce((item.value ->> 'discovery_url') ~ '^https?://', false) = false
           or (item.value ? 'title' and item.value -> 'title' <> 'null'::jsonb
               and case when pg_catalog.jsonb_typeof(item.value -> 'title') = 'string'
                   then length(item.value ->> 'title') > 512 else true end)
           or (item.value ? 'home_page_url'
               and item.value -> 'home_page_url' <> 'null'::jsonb
               and case when pg_catalog.jsonb_typeof(item.value -> 'home_page_url') = 'string'
                   then length(item.value ->> 'home_page_url') not between 1 and 2048
                        or (item.value ->> 'home_page_url') !~ '^https?://'
                   else true end)
           or (item.value ? 'http_status'
               and item.value -> 'http_status' <> 'null'::jsonb
               and case when pg_catalog.jsonb_typeof(item.value -> 'http_status') = 'number'
                   then (item.value ->> 'http_status')::numeric
                            <> pg_catalog.trunc((item.value ->> 'http_status')::numeric)
                        or (item.value ->> 'http_status')::numeric not between 100 and 599
                   else true end)
    ) or (
        select count(distinct item.value ->> 'canonical_url')
        from pg_catalog.jsonb_array_elements(p_feeds) as item(value)
    ) <> v_feed_count then
        raise exception using errcode = '22023',
            message = 'feed completion payload is invalid';
    end if;

    select state.* into v_state
    from public.site_discovery_state as state
    join public.government_sites as site on site.id = state.site_id
    where state.site_id = p_site_id and state.status = 'leased'
      and state.lease_token = p_lease_token
      and state.lease_until > pg_catalog.now()
      and site.inventory_active and not site.gsa_filtered and site.inventory_usable
    for update of state;
    if not found then return false; end if;

    insert into public.feeds (
        canonical_url, feed_type, title, home_page_url, status,
        last_http_status, last_seen_at, last_validated_at, updated_at
    )
    select item.value ->> 'canonical_url', item.value ->> 'feed_type',
        nullif(item.value ->> 'title', ''),
        nullif(item.value ->> 'home_page_url', ''), 'active',
        nullif(item.value ->> 'http_status', '')::integer,
        pg_catalog.now(), pg_catalog.now(), pg_catalog.now()
    from pg_catalog.jsonb_array_elements(p_feeds) as item(value)
    on conflict (canonical_url) do update
    set feed_type = excluded.feed_type,
        title = coalesce(excluded.title, public.feeds.title),
        home_page_url = coalesce(excluded.home_page_url, public.feeds.home_page_url),
        status = case when public.feeds.status = 'suppressed'
            then 'suppressed' else 'active' end,
        last_http_status = excluded.last_http_status,
        last_seen_at = excluded.last_seen_at,
        last_validated_at = excluded.last_validated_at,
        updated_at = excluded.updated_at;

    insert into public.government_site_feeds (
        site_id, feed_id, discovery_method, discovery_url, active,
        missing_success_count, last_seen_at, updated_at
    )
    select p_site_id, feed.id, item.value ->> 'discovery_method',
        item.value ->> 'discovery_url', true, 0,
        pg_catalog.now(), pg_catalog.now()
    from pg_catalog.jsonb_array_elements(p_feeds) as item(value)
    join public.feeds as feed on feed.canonical_url = item.value ->> 'canonical_url'
    on conflict (site_id, feed_id) do update
    set discovery_method = excluded.discovery_method,
        discovery_url = excluded.discovery_url, active = true,
        missing_success_count = 0, last_seen_at = excluded.last_seen_at,
        updated_at = excluded.updated_at;

    insert into public.feed_fetch_state (feed_id, status, next_fetch_at)
    select feed.id, 'pending', pg_catalog.now()
    from pg_catalog.jsonb_array_elements(p_feeds) as item(value)
    join public.feeds as feed on feed.canonical_url = item.value ->> 'canonical_url'
    on conflict (feed_id) do nothing;

    update public.government_site_feeds as relationship
    set missing_success_count = relationship.missing_success_count + 1,
        active = relationship.missing_success_count + 1 < 2,
        updated_at = pg_catalog.now()
    where relationship.site_id = p_site_id
      and not exists (
          select 1
          from pg_catalog.jsonb_array_elements(p_feeds) as item(value)
          join public.feeds as feed
            on feed.canonical_url = item.value ->> 'canonical_url'
          where feed.id = relationship.feed_id
      );

    v_interval_seconds := case
        when p_result = 'succeeded' then 90 * 86400
        when v_state.last_result = 'no_feed' then 90 * 86400
        else 30 * 86400 end;
    v_jitter_seconds := -43200 + (
        pg_catalog.hashtextextended(
            p_site_id::text || ':' || (v_state.successful_discovery_count + 1)::text,
            0
        ) & 2147483647
    )::integer % 86401;

    update public.site_discovery_state
    set status = p_result,
        next_discovery_at = pg_catalog.now()
            + pg_catalog.make_interval(secs => v_interval_seconds + v_jitter_seconds),
        lease_token = null, lease_owner = null, lease_until = null,
        last_completed_at = pg_catalog.now(), last_result = p_result,
        failure_count = 0,
        successful_discovery_count = successful_discovery_count + 1,
        last_error_code = null, last_error_detail = null,
        last_final_url = p_site_health ->> 'final_url',
        last_http_status = nullif(p_site_health ->> 'http_status', '')::integer,
        last_duration_ms = nullif(p_site_health ->> 'duration_ms', '')::integer,
        last_policy_version = p_policy_version,
        updated_at = pg_catalog.now()
    where site_id = p_site_id and lease_token = p_lease_token;
    return found;
end;
$$;

create or replace function public.fail_site_discovery(
    p_site_id uuid,
    p_lease_token uuid,
    p_error_code text,
    p_error_detail text,
    p_retry_after_seconds integer,
    p_policy_version integer
)
returns boolean
language plpgsql
security definer
set search_path = ''
as $$
declare
    v_state public.site_discovery_state%rowtype;
    v_backoff_seconds integer;
    v_jitter_seconds integer;
begin
    if p_site_id is null or p_lease_token is null then
        raise exception using errcode = '22004',
            message = 'site ID and lease token are required';
    end if;
    if p_error_code is null or length(btrim(p_error_code)) not between 1 and 128
       or p_error_detail is null or length(p_error_detail) > 1000
       or coalesce(p_retry_after_seconds, -1) < 0
       or coalesce(p_policy_version, 0) < 1 then
        raise exception using errcode = '22023',
            message = 'discovery failure metadata is invalid';
    end if;

    select state.* into v_state
    from public.site_discovery_state as state
    join public.government_sites as site on site.id = state.site_id
    where state.site_id = p_site_id and state.status = 'leased'
      and state.lease_token = p_lease_token
      and state.lease_until > pg_catalog.now()
      and site.inventory_active and not site.gsa_filtered and site.inventory_usable
    for update of state;
    if not found then return false; end if;

    v_backoff_seconds := least(
        7 * 86400,
        greatest(
            (3600 * pg_catalog.power(
                2::numeric,
                least(v_state.failure_count, 7)
            ))::integer,
            least(p_retry_after_seconds, 7 * 86400)
        )
    );
    v_jitter_seconds := (
        (pg_catalog.hashtextextended(
            p_site_id::text || ':failure:' || (v_state.failure_count + 1)::text,
            0
        ) & 2147483647)::integer % 1201
    ) - 600;

    update public.site_discovery_state
    set status = 'backoff',
        next_discovery_at = pg_catalog.now() + pg_catalog.make_interval(
            secs => least(
                7 * 86400,
                greatest(
                    3600,
                    least(p_retry_after_seconds, 7 * 86400),
                    v_backoff_seconds + v_jitter_seconds
                )
            )
        ),
        lease_token = null, lease_owner = null, lease_until = null,
        last_completed_at = pg_catalog.now(), last_result = 'failed',
        failure_count = failure_count + 1,
        last_error_code = btrim(p_error_code), last_error_detail = p_error_detail,
        last_final_url = null, last_http_status = null, last_duration_ms = null,
        last_policy_version = p_policy_version, updated_at = pg_catalog.now()
    where site_id = p_site_id and lease_token = p_lease_token;
    return found;
end;
$$;

create or replace function public.get_site_discovery_summary()
returns table (
    pending_count bigint,
    leased_count bigint,
    succeeded_count bigint,
    no_feed_count bigint,
    backoff_count bigint,
    disabled_count bigint,
    overdue_count bigint,
    expired_lease_count bigint,
    feed_count bigint,
    active_relationship_count bigint,
    oldest_due_at timestamptz
)
language sql
stable
security definer
set search_path = ''
as $$
    select
        count(*) filter (where state.status = 'pending'),
        count(*) filter (where state.status = 'leased'),
        count(*) filter (where state.status = 'succeeded'),
        count(*) filter (where state.status = 'no_feed'),
        count(*) filter (where state.status = 'backoff'),
        count(*) filter (where state.status = 'disabled'),
        count(*) filter (
            where state.status in ('pending', 'succeeded', 'no_feed', 'backoff')
              and state.next_discovery_at <= pg_catalog.now()
        ),
        count(*) filter (
            where state.status = 'leased' and state.lease_until <= pg_catalog.now()
        ),
        (select count(*) from public.feeds),
        (select count(*) from public.government_site_feeds where active),
        min(state.next_discovery_at) filter (
            where state.status in ('pending', 'succeeded', 'no_feed', 'backoff')
              and state.next_discovery_at <= pg_catalog.now()
        )
    from public.site_discovery_state as state;
$$;

revoke all on function public.claim_due_site_discoveries(uuid, integer, integer)
    from public, anon, authenticated;
revoke all on function public.renew_site_discovery_lease(uuid, uuid, integer)
    from public, anon, authenticated;
revoke all on function public.release_site_discovery_lease(uuid, uuid, text)
    from public, anon, authenticated;
revoke all on function public.complete_site_discovery(uuid, uuid, text, jsonb, jsonb, integer)
    from public, anon, authenticated;
revoke all on function public.fail_site_discovery(uuid, uuid, text, text, integer, integer)
    from public, anon, authenticated;
revoke all on function public.get_site_discovery_summary()
    from public, anon, authenticated;

grant execute on function public.claim_due_site_discoveries(uuid, integer, integer)
    to service_role;
grant execute on function public.renew_site_discovery_lease(uuid, uuid, integer)
    to service_role;
grant execute on function public.release_site_discovery_lease(uuid, uuid, text)
    to service_role;
grant execute on function public.complete_site_discovery(uuid, uuid, text, jsonb, jsonb, integer)
    to service_role;
grant execute on function public.fail_site_discovery(uuid, uuid, text, text, integer, integer)
    to service_role;
grant execute on function public.get_site_discovery_summary()
    to service_role;

commit;
