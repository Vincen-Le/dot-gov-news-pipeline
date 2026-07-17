-- Operator-only discovery health queries. Run with a database role that can
-- read the service-owned tables; these relations are not exposed to browsers.

select * from public.get_site_discovery_summary();

select
    status,
    count(*) as site_count,
    min(next_discovery_at) as oldest_due_at,
    max(next_discovery_at) as newest_due_at
from public.site_discovery_state
group by status
order by status;

select
    state.site_id,
    site.base_domain,
    state.lease_owner,
    state.last_started_at,
    state.lease_until,
    now() - state.last_started_at as lease_age,
    state.lease_until <= now() as expired
from public.site_discovery_state as state
join public.government_sites as site on site.id = state.site_id
where state.status = 'leased'
order by state.lease_until;

select
    date_trunc('hour', last_completed_at) as hour,
    count(*) filter (where last_result = 'succeeded') as succeeded,
    count(*) filter (where last_result = 'no_feed') as no_feed,
    count(*) filter (where last_result = 'failed') as failed,
    percentile_cont(0.50) within group (order by last_duration_ms)
        filter (where last_duration_ms is not null) as duration_p50_ms,
    percentile_cont(0.95) within group (order by last_duration_ms)
        filter (where last_duration_ms is not null) as duration_p95_ms
from public.site_discovery_state
where last_completed_at >= now() - interval '7 days'
group by date_trunc('hour', last_completed_at)
order by hour desc;

select
    last_error_code,
    count(*) as site_count,
    max(last_completed_at) as latest_failure_at
from public.site_discovery_state
where last_error_code is not null
group by last_error_code
order by site_count desc, last_error_code;

select
    count(*) as feeds,
    count(*) filter (where status = 'active') as active_feeds,
    (select count(*) from public.government_site_feeds) as relationships,
    (select count(*) from public.government_site_feeds where active)
        as active_relationships,
    (select count(*)
     from public.feeds as feed
     where (select count(*)
            from public.government_site_feeds as relationship
            where relationship.feed_id = feed.id) > 1) as reused_feeds
from public.feeds;
