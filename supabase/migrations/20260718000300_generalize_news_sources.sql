begin;

-- Prevent legacy writers from committing rows between the copy assertions and
-- destructive drop. Lock discovery state first to match the completion RPC's
-- lock order and avoid a state/source lock inversion during rollout.
lock table
    public.site_discovery_state,
    public.feeds,
    public.government_site_feeds,
    public.feed_fetch_state
in access exclusive mode;

create table public.news_sources (
    id uuid primary key default gen_random_uuid(),
    canonical_url text not null unique,
    source_type text not null,
    title text,
    home_page_url text,
    status text not null default 'active',
    last_http_status integer,
    backfill_supported boolean not null default false,
    earliest_available_at timestamptz,
    latest_observed_at timestamptz,
    adapter_config jsonb not null default '{}'::jsonb,
    quality_flags text[] not null default '{}'::text[],
    first_seen_at timestamptz not null default now(),
    last_seen_at timestamptz not null default now(),
    last_validated_at timestamptz not null default now(),
    created_at timestamptz not null default now(),
    updated_at timestamptz not null default now(),
    constraint news_sources_canonical_url_bounded
        check (length(canonical_url) between 1 and 2048),
    constraint news_sources_type_valid
        check (source_type in (
            'rss',
            'atom',
            'json_feed',
            'publisher_api',
            'html_archive',
            'sitemap'
        )),
    constraint news_sources_title_bounded
        check (title is null or length(title) <= 512),
    constraint news_sources_home_page_url_bounded
        check (home_page_url is null or length(home_page_url) between 1 and 2048),
    constraint news_sources_status_valid
        check (status in ('active', 'invalid', 'gone', 'suppressed')),
    constraint news_sources_last_http_status_valid
        check (last_http_status is null or last_http_status between 100 and 599),
    constraint news_sources_adapter_config_valid
        check (
            jsonb_typeof(adapter_config) = 'object'
            and pg_catalog.pg_column_size(adapter_config) <= 32768
        ),
    constraint news_sources_quality_flags_valid
        check (
            cardinality(quality_flags) <= 32
            and array_position(quality_flags, null) is null
        ),
    constraint news_sources_observation_window_valid
        check (
            earliest_available_at is null
            or latest_observed_at is null
            or earliest_available_at <= latest_observed_at
        )
);

comment on table public.news_sources is
    'Globally canonical news endpoints and archives discovered from government sites.';
comment on column public.news_sources.adapter_config is
    'Bounded source-adapter configuration for APIs, archives, sitemaps, and syndication formats.';

create index news_sources_status_last_validated_idx
    on public.news_sources (status, last_validated_at);
create index news_sources_type_status_idx
    on public.news_sources (source_type, status);

create table public.government_site_news_sources (
    site_id uuid not null
        references public.government_sites(id) on delete cascade,
    news_source_id uuid not null
        references public.news_sources(id) on delete cascade,
    discovery_method text not null,
    discovery_url text not null,
    active boolean not null default true,
    missing_success_count integer not null default 0,
    first_seen_at timestamptz not null default now(),
    last_seen_at timestamptz not null default now(),
    updated_at timestamptz not null default now(),
    primary key (site_id, news_source_id),
    constraint government_site_news_sources_method_valid
        check (discovery_method in (
            'http_link',
            'html_alternate',
            'anchor',
            'conventional_path',
            'root_document',
            'api_documentation',
            'html_archive',
            'sitemap',
            'manual'
        )),
    constraint government_site_news_sources_discovery_url_bounded
        check (length(discovery_url) between 1 and 2048),
    constraint government_site_news_sources_missing_count_nonnegative
        check (missing_success_count >= 0)
);

comment on table public.government_site_news_sources is
    'Many-to-many provenance between inventory sites and canonical news sources.';

create index government_site_news_sources_source_active_idx
    on public.government_site_news_sources (news_source_id, active);

create table public.news_source_fetch_state (
    news_source_id uuid primary key
        references public.news_sources(id) on delete cascade,
    status text not null default 'pending',
    next_fetch_at timestamptz,
    lease_token uuid,
    lease_owner uuid,
    lease_until timestamptz,
    etag text,
    last_modified text,
    last_success_at timestamptz,
    last_new_item_at timestamptz,
    failure_count integer not null default 0,
    updated_at timestamptz not null default now(),
    constraint news_source_fetch_state_status_valid
        check (status in ('pending', 'leased', 'active', 'backoff', 'disabled')),
    constraint news_source_fetch_state_lease_consistent
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
    constraint news_source_fetch_state_etag_bounded
        check (etag is null or length(etag) <= 1024),
    constraint news_source_fetch_state_last_modified_bounded
        check (last_modified is null or length(last_modified) <= 1024),
    constraint news_source_fetch_state_failure_count_nonnegative
        check (failure_count >= 0)
);

comment on table public.news_source_fetch_state is
    'Durable fetch handoff state shared by every supported news-source adapter.';

create index news_source_fetch_state_due_idx
    on public.news_source_fetch_state (next_fetch_at, news_source_id)
    where status in ('pending', 'active', 'backoff');

alter table public.news_sources enable row level security;
alter table public.government_site_news_sources enable row level security;
alter table public.news_source_fetch_state enable row level security;

revoke all privileges on table public.news_sources
    from public, anon, authenticated, service_role;
revoke all privileges on table public.government_site_news_sources
    from public, anon, authenticated, service_role;
revoke all privileges on table public.news_source_fetch_state
    from public, anon, authenticated, service_role;

grant select on table public.news_sources,
    public.government_site_news_sources,
    public.news_source_fetch_state
    to service_role;

insert into public.news_sources (
    id,
    canonical_url,
    source_type,
    title,
    home_page_url,
    status,
    last_http_status,
    first_seen_at,
    last_seen_at,
    last_validated_at,
    created_at,
    updated_at
)
select
    id,
    canonical_url,
    feed_type,
    title,
    home_page_url,
    status,
    last_http_status,
    first_seen_at,
    last_seen_at,
    last_validated_at,
    created_at,
    updated_at
from public.feeds;

insert into public.government_site_news_sources (
    site_id,
    news_source_id,
    discovery_method,
    discovery_url,
    active,
    missing_success_count,
    first_seen_at,
    last_seen_at,
    updated_at
)
select
    site_id,
    feed_id,
    discovery_method,
    discovery_url,
    active,
    missing_success_count,
    first_seen_at,
    last_seen_at,
    updated_at
from public.government_site_feeds;

insert into public.news_source_fetch_state (
    news_source_id,
    status,
    next_fetch_at,
    lease_token,
    lease_owner,
    lease_until,
    etag,
    last_modified,
    last_success_at,
    last_new_item_at,
    failure_count,
    updated_at
)
select
    feed_id,
    status,
    next_fetch_at,
    lease_token,
    lease_owner,
    lease_until,
    etag,
    last_modified,
    last_success_at,
    last_new_item_at,
    failure_count,
    updated_at
from public.feed_fetch_state;

do $$
begin
    if (select count(*) from public.news_sources)
        <> (select count(*) from public.feeds) then
        raise exception 'news-source migration changed the source row count';
    end if;

    if exists (
        select 1
        from public.feeds as legacy
        left join public.news_sources as migrated on migrated.id = legacy.id
        where migrated.id is null
           or row(
                migrated.canonical_url,
                migrated.source_type,
                migrated.title,
                migrated.home_page_url,
                migrated.status,
                migrated.last_http_status,
                migrated.first_seen_at,
                migrated.last_seen_at,
                migrated.last_validated_at,
                migrated.created_at,
                migrated.updated_at
           ) is distinct from row(
                legacy.canonical_url,
                legacy.feed_type,
                legacy.title,
                legacy.home_page_url,
                legacy.status,
                legacy.last_http_status,
                legacy.first_seen_at,
                legacy.last_seen_at,
                legacy.last_validated_at,
                legacy.created_at,
                legacy.updated_at
           )
    ) then
        raise exception 'news-source migration changed legacy source data';
    end if;

    if (select count(*) from public.government_site_news_sources)
        <> (select count(*) from public.government_site_feeds) then
        raise exception 'news-source migration changed the relationship row count';
    end if;

    if exists (
        select 1
        from public.government_site_feeds as legacy
        left join public.government_site_news_sources as migrated
          on migrated.site_id = legacy.site_id
         and migrated.news_source_id = legacy.feed_id
        where migrated.news_source_id is null
           or row(
                migrated.discovery_method,
                migrated.discovery_url,
                migrated.active,
                migrated.missing_success_count,
                migrated.first_seen_at,
                migrated.last_seen_at,
                migrated.updated_at
           ) is distinct from row(
                legacy.discovery_method,
                legacy.discovery_url,
                legacy.active,
                legacy.missing_success_count,
                legacy.first_seen_at,
                legacy.last_seen_at,
                legacy.updated_at
           )
    ) then
        raise exception 'news-source migration changed relationship data';
    end if;

    if (select count(*) from public.news_source_fetch_state)
        <> (select count(*) from public.feed_fetch_state) then
        raise exception 'news-source migration changed the fetch-state row count';
    end if;

    if exists (
        select 1
        from public.feed_fetch_state as legacy
        left join public.news_source_fetch_state as migrated
          on migrated.news_source_id = legacy.feed_id
        where migrated.news_source_id is null
           or row(
                migrated.status,
                migrated.next_fetch_at,
                migrated.lease_token,
                migrated.lease_owner,
                migrated.lease_until,
                migrated.etag,
                migrated.last_modified,
                migrated.last_success_at,
                migrated.last_new_item_at,
                migrated.failure_count,
                migrated.updated_at
           ) is distinct from row(
                legacy.status,
                legacy.next_fetch_at,
                legacy.lease_token,
                legacy.lease_owner,
                legacy.lease_until,
                legacy.etag,
                legacy.last_modified,
                legacy.last_success_at,
                legacy.last_new_item_at,
                legacy.failure_count,
                legacy.updated_at
           )
    ) then
        raise exception 'news-source migration changed fetch-state data';
    end if;
end;
$$;

drop index public.site_discovery_state_due_idx;

alter table public.site_discovery_state
    drop constraint site_discovery_state_status_valid,
    add column last_checked_source_types text[] not null default '{}'::text[],
    add constraint site_discovery_state_checked_source_types_valid
        check (
            cardinality(last_checked_source_types) <= 6
            and array_position(last_checked_source_types, null) is null
            and last_checked_source_types <@ array[
                'rss',
                'atom',
                'json_feed',
                'publisher_api',
                'html_archive',
                'sitemap'
            ]::text[]
        );

-- The legacy result proved only that a bounded RSS/Atom crawl found nothing.
-- Preserve its due time, but require a new generalized discovery before a
-- durable no_news_source result can be recorded.
update public.site_discovery_state
set
    status = case when status = 'no_feed' then 'pending' else status end,
    last_result = case
        when last_result = 'no_feed' then 'source_rediscovery_required'
        else last_result
    end
where status = 'no_feed' or last_result = 'no_feed';

alter table public.site_discovery_state
    add constraint site_discovery_state_status_valid
        check (status in (
            'pending',
            'leased',
            'succeeded',
            'no_news_source',
            'backoff',
            'disabled'
        ));

create index site_discovery_state_due_idx
    on public.site_discovery_state (next_discovery_at, site_id)
    where status in ('pending', 'succeeded', 'no_news_source', 'backoff');

comment on table public.site_discovery_state is
    'Lease-based, per-site scheduling state for bounded news-source discovery.';

create or replace function public.claim_due_site_discoveries(
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
        where state.status in (
                'pending',
                'succeeded',
                'no_news_source',
                'backoff'
              )
          and (not p_pending_only or state.status = 'pending')
          and state.next_discovery_at <= pg_catalog.now()
          and site.inventory_active
          and not site.gsa_filtered
          and site.inventory_usable
          and site.initial_url is not null
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
        set
            status = 'leased',
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

comment on function public.claim_due_site_discoveries(
    uuid, integer, integer, boolean, integer
)
is 'Claims due news-source discovery work with bounded base-domain lanes.';

drop function public.complete_site_discovery(
    uuid, uuid, text, jsonb, jsonb, integer
);

create function public.complete_site_discovery(
    p_site_id uuid,
    p_lease_token uuid,
    p_result text,
    p_site_health jsonb,
    p_sources jsonb,
    p_policy_version integer
)
returns boolean
language plpgsql
security definer
set search_path = ''
as $$
declare
    v_state public.site_discovery_state%rowtype;
    v_source_count integer;
    v_interval_seconds integer;
    v_jitter_seconds integer;
begin
    if p_site_id is null or p_lease_token is null then
        raise exception using errcode = '22004',
            message = 'site ID and lease token are required';
    end if;
    if p_result is null
       or p_result not in ('succeeded', 'no_news_source')
       or coalesce(p_policy_version, 0) < 1
       or p_site_health is null
       or pg_catalog.jsonb_typeof(p_site_health) is distinct from 'object'
       or p_sources is null
       or pg_catalog.jsonb_typeof(p_sources) is distinct from 'array' then
        raise exception using errcode = '22023',
            message = 'discovery completion metadata is invalid';
    end if;

    v_source_count := pg_catalog.jsonb_array_length(p_sources);
    if v_source_count > 10
       or (p_result = 'succeeded' and v_source_count = 0)
       or (p_result = 'no_news_source' and v_source_count <> 0) then
        raise exception using errcode = '22023',
            message = 'discovery result and news-source count are inconsistent';
    end if;

    if p_site_health - array[
            'final_url',
            'http_status',
            'duration_ms',
            'checked_source_types'
       ] <> '{}'::jsonb
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

    if p_site_health ? 'checked_source_types' then
        if pg_catalog.jsonb_typeof(
                p_site_health -> 'checked_source_types'
           ) is distinct from 'array'
           or pg_catalog.jsonb_array_length(
                p_site_health -> 'checked_source_types'
           ) > 6
           or exists (
                select 1
                from pg_catalog.jsonb_array_elements(
                    p_site_health -> 'checked_source_types'
                ) as checked(value)
                where pg_catalog.jsonb_typeof(checked.value) <> 'string'
                   or checked.value #>> '{}' not in (
                        'rss',
                        'atom',
                        'json_feed',
                        'publisher_api',
                        'html_archive',
                        'sitemap'
                   )
           )
           or (
                select count(distinct checked.value #>> '{}')
                from pg_catalog.jsonb_array_elements(
                    p_site_health -> 'checked_source_types'
                ) as checked(value)
           ) <> pg_catalog.jsonb_array_length(
                p_site_health -> 'checked_source_types'
           ) then
            raise exception using errcode = '22023',
                message = 'checked news-source types are invalid';
        end if;
    end if;

    if p_result = 'no_news_source'
       and (
            not p_site_health ? 'checked_source_types'
            or pg_catalog.jsonb_array_length(
                p_site_health -> 'checked_source_types'
            ) <> 6
            or exists (
                select required.source_type
                from unnest(array[
                    'rss',
                    'atom',
                    'json_feed',
                    'publisher_api',
                    'html_archive',
                    'sitemap'
                ]::text[]) as required(source_type)
                except
                select checked.value #>> '{}'
                from pg_catalog.jsonb_array_elements(
                    p_site_health -> 'checked_source_types'
                ) as checked(value)
            )
       ) then
        raise exception using errcode = '22023',
            message = 'no-news-source completion requires every adapter check';
    end if;

    if exists (
        select 1
        from pg_catalog.jsonb_array_elements(p_sources) as item(value)
        where pg_catalog.jsonb_typeof(item.value) <> 'object'
           or item.value - array[
               'canonical_url',
               'source_type',
               'title',
               'home_page_url',
               'http_status',
               'discovery_method',
               'discovery_url',
               'adapter_config',
               'backfill_supported',
               'earliest_available_at',
               'latest_observed_at'
           ] <> '{}'::jsonb
           or coalesce(
                length(item.value ->> 'canonical_url') between 1 and 2048,
                false
           ) = false
           or coalesce((item.value ->> 'canonical_url') ~ '^https?://', false) = false
           or coalesce(item.value ->> 'source_type' in (
                'rss',
                'atom',
                'json_feed',
                'publisher_api',
                'html_archive',
                'sitemap'
           ), false) = false
           or coalesce(item.value ->> 'discovery_method' in (
                'http_link',
                'html_alternate',
                'anchor',
                'conventional_path',
                'root_document',
                'api_documentation',
                'html_archive',
                'sitemap',
                'manual'
           ), false) = false
           or coalesce(
                length(item.value ->> 'discovery_url') between 1 and 2048,
                false
           ) = false
           or coalesce((item.value ->> 'discovery_url') ~ '^https?://', false) = false
           or (item.value ? 'title'
               and item.value -> 'title' <> 'null'::jsonb
               and case
                   when pg_catalog.jsonb_typeof(item.value -> 'title') = 'string'
                   then length(item.value ->> 'title') > 512
                   else true
               end)
           or (item.value ? 'home_page_url'
               and item.value -> 'home_page_url' <> 'null'::jsonb
               and case
                   when pg_catalog.jsonb_typeof(item.value -> 'home_page_url') = 'string'
                   then length(item.value ->> 'home_page_url') not between 1 and 2048
                        or (item.value ->> 'home_page_url') !~ '^https?://'
                   else true
               end)
           or (item.value ? 'http_status'
               and item.value -> 'http_status' <> 'null'::jsonb
               and case
                   when pg_catalog.jsonb_typeof(item.value -> 'http_status') = 'number'
                   then (item.value ->> 'http_status')::numeric
                            <> pg_catalog.trunc((item.value ->> 'http_status')::numeric)
                        or (item.value ->> 'http_status')::numeric not between 100 and 599
                   else true
               end)
           or (item.value ? 'adapter_config'
               and item.value -> 'adapter_config' <> 'null'::jsonb
               and (
                    pg_catalog.jsonb_typeof(item.value -> 'adapter_config') <> 'object'
                    or pg_catalog.pg_column_size(item.value -> 'adapter_config') > 32768
               ))
           or (item.value ? 'backfill_supported'
               and item.value -> 'backfill_supported' <> 'null'::jsonb
               and pg_catalog.jsonb_typeof(item.value -> 'backfill_supported') <> 'boolean')
           or (item.value ? 'earliest_available_at'
               and item.value -> 'earliest_available_at' <> 'null'::jsonb
               and pg_catalog.jsonb_typeof(item.value -> 'earliest_available_at') <> 'string')
           or (item.value ? 'latest_observed_at'
               and item.value -> 'latest_observed_at' <> 'null'::jsonb
               and pg_catalog.jsonb_typeof(item.value -> 'latest_observed_at') <> 'string')
    ) or (
        select count(distinct item.value ->> 'canonical_url')
        from pg_catalog.jsonb_array_elements(p_sources) as item(value)
    ) <> v_source_count then
        raise exception using errcode = '22023',
            message = 'news-source completion payload is invalid';
    end if;

    if exists (
        select 1
        from pg_catalog.jsonb_array_elements(p_sources) as item(value)
        where nullif(item.value ->> 'earliest_available_at', '')::timestamptz
              > nullif(item.value ->> 'latest_observed_at', '')::timestamptz
    ) then
        raise exception using errcode = '22023',
            message = 'news-source observation window is invalid';
    end if;

    select state.* into v_state
    from public.site_discovery_state as state
    join public.government_sites as site on site.id = state.site_id
    where state.site_id = p_site_id
      and state.status = 'leased'
      and state.lease_token = p_lease_token
      and state.lease_until > pg_catalog.now()
      and site.inventory_active
      and not site.gsa_filtered
      and site.inventory_usable
    for update of state;

    if not found then
        return false;
    end if;

    insert into public.news_sources (
        canonical_url,
        source_type,
        title,
        home_page_url,
        status,
        last_http_status,
        backfill_supported,
        earliest_available_at,
        latest_observed_at,
        adapter_config,
        last_seen_at,
        last_validated_at,
        updated_at
    )
    select
        item.value ->> 'canonical_url',
        item.value ->> 'source_type',
        nullif(item.value ->> 'title', ''),
        nullif(item.value ->> 'home_page_url', ''),
        'active',
        nullif(item.value ->> 'http_status', '')::integer,
        coalesce(nullif(item.value ->> 'backfill_supported', '')::boolean, false),
        nullif(item.value ->> 'earliest_available_at', '')::timestamptz,
        nullif(item.value ->> 'latest_observed_at', '')::timestamptz,
        case
            when item.value -> 'adapter_config' is null
              or item.value -> 'adapter_config' = 'null'::jsonb
            then '{}'::jsonb
            else item.value -> 'adapter_config'
        end,
        pg_catalog.now(),
        pg_catalog.now(),
        pg_catalog.now()
    from pg_catalog.jsonb_array_elements(p_sources) as item(value)
    on conflict (canonical_url) do update
    set
        source_type = excluded.source_type,
        title = coalesce(excluded.title, public.news_sources.title),
        home_page_url = coalesce(
            excluded.home_page_url,
            public.news_sources.home_page_url
        ),
        status = case
            when public.news_sources.status = 'suppressed' then 'suppressed'
            else 'active'
        end,
        last_http_status = excluded.last_http_status,
        backfill_supported = excluded.backfill_supported,
        earliest_available_at = coalesce(
            excluded.earliest_available_at,
            public.news_sources.earliest_available_at
        ),
        latest_observed_at = coalesce(
            excluded.latest_observed_at,
            public.news_sources.latest_observed_at
        ),
        adapter_config = excluded.adapter_config,
        last_seen_at = excluded.last_seen_at,
        last_validated_at = excluded.last_validated_at,
        updated_at = excluded.updated_at;

    insert into public.government_site_news_sources (
        site_id,
        news_source_id,
        discovery_method,
        discovery_url,
        active,
        missing_success_count,
        last_seen_at,
        updated_at
    )
    select
        p_site_id,
        source.id,
        item.value ->> 'discovery_method',
        item.value ->> 'discovery_url',
        true,
        0,
        pg_catalog.now(),
        pg_catalog.now()
    from pg_catalog.jsonb_array_elements(p_sources) as item(value)
    join public.news_sources as source
      on source.canonical_url = item.value ->> 'canonical_url'
    on conflict (site_id, news_source_id) do update
    set
        discovery_method = excluded.discovery_method,
        discovery_url = excluded.discovery_url,
        active = true,
        missing_success_count = 0,
        last_seen_at = excluded.last_seen_at,
        updated_at = excluded.updated_at;

    insert into public.news_source_fetch_state (
        news_source_id,
        status,
        next_fetch_at
    )
    select source.id, 'pending', pg_catalog.now()
    from pg_catalog.jsonb_array_elements(p_sources) as item(value)
    join public.news_sources as source
      on source.canonical_url = item.value ->> 'canonical_url'
    on conflict (news_source_id) do nothing;

    update public.government_site_news_sources as relationship
    set
        missing_success_count = relationship.missing_success_count + 1,
        active = relationship.missing_success_count + 1 < 2,
        updated_at = pg_catalog.now()
    where relationship.site_id = p_site_id
      and not exists (
          select 1
          from pg_catalog.jsonb_array_elements(p_sources) as item(value)
          join public.news_sources as source
            on source.canonical_url = item.value ->> 'canonical_url'
          where source.id = relationship.news_source_id
      );

    v_interval_seconds := case
        when p_result = 'succeeded' then 90 * 86400
        when v_state.last_result = 'no_news_source' then 90 * 86400
        else 30 * 86400
    end;
    v_jitter_seconds := -43200 + (
        pg_catalog.hashtextextended(
            p_site_id::text || ':' || (v_state.successful_discovery_count + 1)::text,
            0
        ) & 2147483647
    )::integer % 86401;

    update public.site_discovery_state
    set
        status = p_result,
        next_discovery_at = pg_catalog.now()
            + pg_catalog.make_interval(secs => v_interval_seconds + v_jitter_seconds),
        lease_token = null,
        lease_owner = null,
        lease_until = null,
        last_completed_at = pg_catalog.now(),
        last_result = p_result,
        failure_count = 0,
        successful_discovery_count = successful_discovery_count + 1,
        last_error_code = null,
        last_error_detail = null,
        last_final_url = p_site_health ->> 'final_url',
        last_http_status = nullif(p_site_health ->> 'http_status', '')::integer,
        last_duration_ms = nullif(p_site_health ->> 'duration_ms', '')::integer,
        last_policy_version = p_policy_version,
        last_checked_source_types = case
            when p_site_health ? 'checked_source_types' then array(
                select checked.value #>> '{}'
                from pg_catalog.jsonb_array_elements(
                    p_site_health -> 'checked_source_types'
                ) as checked(value)
                order by checked.value #>> '{}'
            )
            else '{}'::text[]
        end,
        updated_at = pg_catalog.now()
    where site_id = p_site_id and lease_token = p_lease_token;

    return found;
end;
$$;

comment on function public.complete_site_discovery(
    uuid, uuid, text, jsonb, jsonb, integer
)
is 'Completes one leased discovery by upserting generalized news sources, provenance, and fetch state.';

drop function public.get_site_discovery_summary();

create function public.get_site_discovery_summary()
returns table (
    pending_count bigint,
    leased_count bigint,
    succeeded_count bigint,
    no_news_source_count bigint,
    backoff_count bigint,
    disabled_count bigint,
    overdue_count bigint,
    expired_lease_count bigint,
    news_source_count bigint,
    active_source_relationship_count bigint,
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
        count(*) filter (where state.status = 'no_news_source'),
        count(*) filter (where state.status = 'backoff'),
        count(*) filter (where state.status = 'disabled'),
        count(*) filter (
            where state.status in (
                'pending',
                'succeeded',
                'no_news_source',
                'backoff'
            )
              and state.next_discovery_at <= pg_catalog.now()
        ),
        count(*) filter (
            where state.status = 'leased'
              and state.lease_until <= pg_catalog.now()
        ),
        (select count(*) from public.news_sources),
        (
            select count(*)
            from public.government_site_news_sources
            where active
        ),
        min(state.next_discovery_at) filter (
            where state.status in (
                'pending',
                'succeeded',
                'no_news_source',
                'backoff'
            )
              and state.next_discovery_at <= pg_catalog.now()
        )
    from public.site_discovery_state as state;
$$;

revoke all on function public.claim_due_site_discoveries(
    uuid, integer, integer, boolean, integer
)
    from public, anon, authenticated;
revoke all on function public.complete_site_discovery(
    uuid, uuid, text, jsonb, jsonb, integer
)
    from public, anon, authenticated;
revoke all on function public.get_site_discovery_summary()
    from public, anon, authenticated;

grant execute on function public.claim_due_site_discoveries(
    uuid, integer, integer, boolean, integer
)
    to service_role;
grant execute on function public.complete_site_discovery(
    uuid, uuid, text, jsonb, jsonb, integer
)
    to service_role;
grant execute on function public.get_site_discovery_summary()
    to service_role;

drop table public.feed_fetch_state;
drop table public.government_site_feeds;
drop table public.feeds;

do $$
begin
    if to_regclass('public.feeds') is not null
       or to_regclass('public.government_site_feeds') is not null
       or to_regclass('public.feed_fetch_state') is not null then
        raise exception 'legacy feed relations still exist after migration';
    end if;
end;
$$;

commit;
