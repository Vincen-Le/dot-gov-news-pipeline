-- Run in psql as an operator. Replace the VALUES rows with exactly 1, 25, or 250
-- reviewed site UUIDs and set expected_size to the same number.
--
-- This shifts every non-cohort schedule by exactly 100 years. The inverse
-- statement at the bottom preserves each original schedule while fencing the
-- wider backlog for the entire canary. Do not run inventory synchronization
-- until the canary is disabled and the fence is restored.
\set expected_size 25

begin;

-- Serialize against claim_due_site_discoveries so the cohort cannot change
-- while this transaction defers the wider backlog.
select pg_catalog.pg_advisory_xact_lock(1732577068, 1);

create temporary table discovery_canary_sites (
    site_id uuid primary key
) on commit drop;

create temporary table discovery_canary_settings (
    expected_size integer not null check (expected_size in (1, 25, 250))
) on commit drop;

insert into discovery_canary_settings values (:expected_size);

insert into discovery_canary_sites (site_id) values
    ('00000000-0000-0000-0000-000000000000'); -- replace with reviewed IDs

do $$
declare
    v_actual integer;
    v_expected integer;
begin
    select expected_size into v_expected from discovery_canary_settings;
    select count(*) into v_actual from discovery_canary_sites;
    if v_expected not in (1, 25, 250) or v_actual <> v_expected then
        raise exception 'canary must contain exactly 1, 25, or 250 reviewed sites';
    end if;
    if exists (
        select 1 from public.site_discovery_state where status = 'leased'
    ) then
        raise exception 'active discovery leases must drain before preparing a canary';
    end if;
    if exists (
        select 1
        from public.site_discovery_state
        where status in ('pending', 'succeeded', 'no_feed', 'backoff')
          and next_discovery_at >= now() + interval '99 years'
    ) then
        raise exception 'a discovery canary fence is already active';
    end if;
    if exists (
        select 1
        from discovery_canary_sites as cohort
        left join public.government_sites as site on site.id = cohort.site_id
        left join public.site_discovery_state as state on state.site_id = cohort.site_id
        where site.id is null or state.site_id is null
           or not site.inventory_active
           or site.gsa_filtered or not site.inventory_usable
           or state.status not in ('pending', 'succeeded', 'no_feed', 'backoff')
    ) then
        raise exception 'canary contains an ineligible or unknown site';
    end if;
end;
$$;

update public.site_discovery_state as state
set next_discovery_at = state.next_discovery_at + interval '100 years',
    updated_at = now()
where state.status in ('pending', 'succeeded', 'no_feed', 'backoff')
  and state.next_discovery_at is not null
  and not exists (
      select 1 from discovery_canary_sites as cohort
      where cohort.site_id = state.site_id
  );

update public.site_discovery_state as state
set next_discovery_at = now(), updated_at = now()
from discovery_canary_sites as cohort
where state.site_id = cohort.site_id
  and state.status in ('pending', 'succeeded', 'no_feed', 'backoff');

do $$
declare
    v_actual integer;
    v_expected integer;
begin
    select expected_size into v_expected from discovery_canary_settings;
    select count(*) into v_actual
    from public.site_discovery_state
    where status in ('pending', 'succeeded', 'no_feed', 'backoff')
      and next_discovery_at <= now();
    if v_actual <> v_expected then
        raise exception 'canary preparation exposed % due sites, expected %',
            v_actual, v_expected;
    end if;
end;
$$;

select status, count(*)
from public.site_discovery_state
where next_discovery_at <= now()
group by status;

commit;

-- Inverse restore after dispatch is disabled and active leases have drained:
-- begin;
-- update public.site_discovery_state
-- set next_discovery_at = next_discovery_at - interval '100 years',
--     updated_at = now()
-- where status in ('pending', 'succeeded', 'no_feed', 'backoff')
--   and next_discovery_at >= now() + interval '99 years';
-- commit;
