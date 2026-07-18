do $$
declare
    v_arguments text;
    v_summary_result text;
begin
    if (select count(*) from public.news_sources) <> 2 then
        raise exception 'expected two migrated news sources';
    end if;
    if (select count(*) from public.government_site_news_sources) <> 3 then
        raise exception 'expected three migrated site/source relationships';
    end if;
    if (select count(*) from public.news_source_fetch_state) <> 2 then
        raise exception 'expected two migrated fetch-state rows';
    end if;

    if not exists (
        select 1
        from public.news_sources
        where id = '30000000-0000-0000-0000-000000000001'
          and canonical_url = 'https://one.example.gov/news.xml'
          and source_type = 'rss'
          and title = 'Example RSS'
          and home_page_url = 'https://one.example.gov/news'
          and status = 'active'
          and last_http_status = 200
          and first_seen_at = '2026-01-01 01:00:00+00'
          and last_seen_at = '2026-07-01 01:00:00+00'
          and last_validated_at = '2026-07-01 01:01:00+00'
          and created_at = '2026-01-01 01:00:00+00'
          and updated_at = '2026-07-01 01:02:00+00'
    ) then
        raise exception 'legacy source fields were not preserved';
    end if;

    if not exists (
        select 1
        from public.news_sources
        where id = '30000000-0000-0000-0000-000000000002'
          and source_type = 'atom'
          and title is null
          and home_page_url is null
          and status = 'gone'
          and last_http_status = 410
    ) then
        raise exception 'nullable and non-active legacy source fields were not preserved';
    end if;

    if not exists (
        select 1
        from public.government_site_news_sources
        where site_id = '20000000-0000-0000-0000-000000000001'
          and news_source_id = '30000000-0000-0000-0000-000000000002'
          and discovery_method = 'anchor'
          and discovery_url = 'https://one.example.gov/news'
          and not active
          and missing_success_count = 2
          and first_seen_at = '2026-02-01 04:00:00+00'
          and last_seen_at = '2026-06-01 04:00:00+00'
          and updated_at = '2026-06-01 04:01:00+00'
    ) then
        raise exception 'relationship fields were not preserved';
    end if;

    if (
        select count(*)
        from public.government_site_news_sources
        where news_source_id = '30000000-0000-0000-0000-000000000002'
    ) <> 2 then
        raise exception 'many-to-many source relationships were not preserved';
    end if;

    if not exists (
        select 1
        from public.news_source_fetch_state
        where news_source_id = '30000000-0000-0000-0000-000000000001'
          and status = 'leased'
          and next_fetch_at = '2026-07-18 10:00:00+00'
          and lease_token = '31000000-0000-0000-0000-000000000001'
          and lease_owner = '32000000-0000-0000-0000-000000000001'
          and lease_until = '2099-07-18 10:05:00+00'
          and etag = '"rss-etag"'
          and last_modified = 'Fri, 17 Jul 2026 10:00:00 GMT'
          and last_success_at = '2026-07-17 10:00:00+00'
          and last_new_item_at = '2026-07-17 09:00:00+00'
          and failure_count = 5
          and updated_at = '2026-07-18 10:00:01+00'
    ) then
        raise exception 'leased fetch-state fields were not preserved';
    end if;

    if not exists (
        select 1
        from public.site_discovery_state
        where site_id = '20000000-0000-0000-0000-000000000001'
          and status = 'pending'
          and next_discovery_at = '2026-08-15 12:00:00+00'
          and last_result = 'source_rediscovery_required'
          and last_checked_source_types = '{}'::text[]
          and successful_discovery_count = 4
    ) then
        raise exception 'legacy no-feed state was not safely queued for rediscovery';
    end if;

    if not exists (
        select 1
        from public.site_discovery_state
        where site_id = '20000000-0000-0000-0000-000000000002'
          and status = 'leased'
          and next_discovery_at = '2026-07-20 12:00:00+00'
          and lease_token = '21000000-0000-0000-0000-000000000001'
          and lease_owner = '22000000-0000-0000-0000-000000000001'
          and lease_until = '2099-07-20 12:05:00+00'
          and last_result = 'source_rediscovery_required'
    ) then
        raise exception 'active discovery lease or legacy result marker was not preserved';
    end if;

    if to_regclass('public.feeds') is not null
       or to_regclass('public.government_site_feeds') is not null
       or to_regclass('public.feed_fetch_state') is not null then
        raise exception 'legacy relations survived the migration';
    end if;

    if exists (
        select 1
        from pg_catalog.pg_class
        where oid in (
            'public.news_sources'::regclass,
            'public.government_site_news_sources'::regclass,
            'public.news_source_fetch_state'::regclass
        )
          and not relrowsecurity
    ) then
        raise exception 'RLS is not enabled on every generalized table';
    end if;

    if not has_table_privilege('service_role', 'public.news_sources', 'select')
       or not has_table_privilege(
            'service_role',
            'public.government_site_news_sources',
            'select'
       )
       or not has_table_privilege(
            'service_role',
            'public.news_source_fetch_state',
            'select'
       ) then
        raise exception 'service-role read privileges were not preserved';
    end if;

    if has_table_privilege('anon', 'public.news_sources', 'select')
       or has_table_privilege('authenticated', 'public.news_sources', 'select') then
        raise exception 'generalized source data is exposed to API user roles';
    end if;

    if to_regclass('public.news_source_fetch_state_due_idx') is null
       or to_regclass('public.government_site_news_sources_source_active_idx') is null
       or to_regclass('public.news_sources_status_last_validated_idx') is null then
        raise exception 'generalized scheduler or relationship indexes are missing';
    end if;

    select pg_catalog.pg_get_function_arguments(procedure.oid)
    into v_arguments
    from pg_catalog.pg_proc as procedure
    join pg_catalog.pg_namespace as namespace
      on namespace.oid = procedure.pronamespace
    where namespace.nspname = 'public'
      and procedure.proname = 'complete_site_discovery';

    if v_arguments not like '%p_sources jsonb%'
       or v_arguments like '%p_feeds jsonb%' then
        raise exception 'discovery completion RPC did not adopt generalized arguments';
    end if;

    select pg_catalog.pg_get_function_result(procedure.oid)
    into v_summary_result
    from pg_catalog.pg_proc as procedure
    join pg_catalog.pg_namespace as namespace
      on namespace.oid = procedure.pronamespace
    where namespace.nspname = 'public'
      and procedure.proname = 'get_site_discovery_summary';

    if v_summary_result not like '%no_news_source_count bigint%'
       or v_summary_result not like '%news_source_count bigint%'
       or v_summary_result not like '%active_source_relationship_count bigint%'
       or v_summary_result like '%feed_count bigint%' then
        raise exception 'discovery summary retained feed-specific output names';
    end if;
end;
$$;
