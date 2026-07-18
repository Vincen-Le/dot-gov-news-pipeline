begin;

create or replace function public.register_curated_news_source(
    p_canonical_url text,
    p_source_type text,
    p_title text default null,
    p_home_page_url text default null,
    p_adapter_config jsonb default '{}'::jsonb,
    p_quality_flags text[] default '{}'::text[],
    p_earliest_available_at timestamptz default null,
    p_latest_observed_at timestamptz default null,
    p_site_id uuid default null,
    p_discovery_url text default null
)
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
    v_source_id uuid;
begin
    if p_canonical_url is null
       or length(pg_catalog.btrim(p_canonical_url)) not between 1 and 2048
       or p_canonical_url !~ '^https?://' then
        raise exception using errcode = '22023',
            message = 'canonical source URL is invalid';
    end if;
    if p_source_type is null or p_source_type not in (
        'rss', 'atom', 'json_feed', 'publisher_api', 'html_archive', 'sitemap'
    ) then
        raise exception using errcode = '22023',
            message = 'source type is invalid';
    end if;
    if p_adapter_config is null
       or pg_catalog.jsonb_typeof(p_adapter_config) <> 'object'
       or pg_catalog.pg_column_size(p_adapter_config) > 32768 then
        raise exception using errcode = '22023',
            message = 'adapter config is invalid';
    end if;
    if p_quality_flags is null
       or pg_catalog.cardinality(p_quality_flags) > 32
       or pg_catalog.array_position(p_quality_flags, null) is not null then
        raise exception using errcode = '22023',
            message = 'quality flags are invalid';
    end if;
    if p_earliest_available_at is not null
       and p_latest_observed_at is not null
       and p_earliest_available_at > p_latest_observed_at then
        raise exception using errcode = '22023',
            message = 'source availability window is invalid';
    end if;
    if p_site_id is not null
       and (
           p_discovery_url is null
           or length(pg_catalog.btrim(p_discovery_url)) not between 1 and 2048
       ) then
        raise exception using errcode = '22023',
            message = 'discovery URL is required with a site ID';
    end if;

    insert into public.news_sources (
        canonical_url,
        source_type,
        title,
        home_page_url,
        status,
        backfill_supported,
        earliest_available_at,
        latest_observed_at,
        adapter_config,
        quality_flags,
        last_seen_at,
        last_validated_at,
        updated_at
    ) values (
        pg_catalog.btrim(p_canonical_url),
        p_source_type,
        p_title,
        p_home_page_url,
        'active',
        true,
        p_earliest_available_at,
        p_latest_observed_at,
        p_adapter_config,
        p_quality_flags,
        pg_catalog.now(),
        pg_catalog.now(),
        pg_catalog.now()
    )
    on conflict (canonical_url) do update
    set source_type = excluded.source_type,
        title = coalesce(excluded.title, news_sources.title),
        home_page_url = coalesce(
            excluded.home_page_url,
            news_sources.home_page_url
        ),
        backfill_supported = true,
        earliest_available_at = coalesce(
            excluded.earliest_available_at,
            news_sources.earliest_available_at
        ),
        latest_observed_at = coalesce(
            excluded.latest_observed_at,
            news_sources.latest_observed_at
        ),
        adapter_config = excluded.adapter_config,
        quality_flags = excluded.quality_flags,
        last_seen_at = pg_catalog.now(),
        last_validated_at = pg_catalog.now(),
        updated_at = pg_catalog.now()
    returning id into v_source_id;

    if p_site_id is not null then
        insert into public.government_site_news_sources (
            site_id,
            news_source_id,
            discovery_method,
            discovery_url,
            active,
            missing_success_count,
            last_seen_at,
            updated_at
        ) values (
            p_site_id,
            v_source_id,
            'manual',
            p_discovery_url,
            true,
            0,
            pg_catalog.now(),
            pg_catalog.now()
        )
        on conflict (site_id, news_source_id) do update
        set discovery_method = 'manual',
            discovery_url = excluded.discovery_url,
            active = true,
            missing_success_count = 0,
            last_seen_at = pg_catalog.now(),
            updated_at = pg_catalog.now();
    end if;

    return v_source_id;
end;
$$;

create or replace function public.begin_news_backfill_run(
    p_run_key text,
    p_cohort_id text,
    p_manifest_sha256 text,
    p_window_start timestamptz,
    p_window_end timestamptz
)
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
    v_run public.news_backfill_runs%rowtype;
begin
    if p_run_key is null
       or length(pg_catalog.btrim(p_run_key)) not between 1 and 256
       or p_cohort_id is null
       or length(pg_catalog.btrim(p_cohort_id)) not between 1 and 128 then
        raise exception using errcode = '22023',
            message = 'run key and cohort ID are required';
    end if;
    if p_manifest_sha256 is null
       or p_manifest_sha256 !~ '^[0-9a-f]{64}$' then
        raise exception using errcode = '22023',
            message = 'manifest sha256 is invalid';
    end if;
    if p_window_start is null
       or p_window_end is null
       or p_window_start >= p_window_end then
        raise exception using errcode = '22023',
            message = 'backfill window is invalid';
    end if;

    insert into public.news_backfill_runs (
        run_key,
        cohort_id,
        manifest_sha256,
        window_start,
        window_end,
        status
    ) values (
        pg_catalog.btrim(p_run_key),
        pg_catalog.btrim(p_cohort_id),
        p_manifest_sha256,
        p_window_start,
        p_window_end,
        'running'
    )
    on conflict (run_key) do nothing;

    select *
    into strict v_run
    from public.news_backfill_runs
    where run_key = pg_catalog.btrim(p_run_key);

    if v_run.cohort_id <> pg_catalog.btrim(p_cohort_id)
       or v_run.manifest_sha256 <> p_manifest_sha256
       or v_run.window_start <> p_window_start
       or v_run.window_end <> p_window_end then
        raise exception using errcode = '22023',
            message = 'run key already exists with different immutable inputs';
    end if;

    return v_run.id;
end;
$$;

create or replace function public.ensure_news_backfill_target(
    p_run_id uuid,
    p_publisher_key text,
    p_source_key text,
    p_news_source_id uuid,
    p_adapter text
)
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
    v_target_id uuid;
begin
    if p_run_id is null or p_news_source_id is null then
        raise exception using errcode = '22004',
            message = 'run ID and source ID are required';
    end if;
    if p_publisher_key is null
       or length(pg_catalog.btrim(p_publisher_key)) not between 1 and 128
       or p_source_key is null
       or length(pg_catalog.btrim(p_source_key)) not between 1 and 128 then
        raise exception using errcode = '22023',
            message = 'publisher and source keys are invalid';
    end if;
    if p_adapter is null or p_adapter not in (
        'syndication', 'wordpress', 'publisher_api', 'sitemap', 'html_archive'
    ) then
        raise exception using errcode = '22023',
            message = 'adapter is invalid';
    end if;
    if not exists (
        select 1
        from public.news_backfill_runs
        where id = p_run_id and status in ('pending', 'running')
    ) then
        raise exception using errcode = '22023',
            message = 'backfill run is not active';
    end if;

    insert into public.news_backfill_targets (
        run_id,
        publisher_key,
        source_key,
        news_source_id,
        adapter,
        status,
        started_at
    ) values (
        p_run_id,
        pg_catalog.btrim(p_publisher_key),
        pg_catalog.btrim(p_source_key),
        p_news_source_id,
        p_adapter,
        'running',
        pg_catalog.now()
    )
    on conflict (run_id, publisher_key, source_key) do update
    set updated_at = pg_catalog.now()
    returning id into v_target_id;

    update public.news_backfill_runs
    set status = 'running', updated_at = pg_catalog.now()
    where id = p_run_id and status = 'pending';

    return v_target_id;
end;
$$;

create or replace function public.checkpoint_news_backfill_target(
    p_target_id uuid,
    p_cursor jsonb,
    p_coverage_reached_at timestamptz default null,
    p_coverage_evidence_artifact_key text default null
)
returns boolean
language plpgsql
security definer
set search_path = ''
as $$
begin
    if p_target_id is null then
        raise exception using errcode = '22004', message = 'target ID is required';
    end if;
    if p_cursor is null
       or pg_catalog.jsonb_typeof(p_cursor) <> 'object'
       or pg_catalog.pg_column_size(p_cursor) > 32768 then
        raise exception using errcode = '22023', message = 'cursor is invalid';
    end if;
    if p_coverage_evidence_artifact_key is not null
       and length(p_coverage_evidence_artifact_key) not between 1 and 2048 then
        raise exception using errcode = '22023',
            message = 'coverage evidence artifact key is invalid';
    end if;

    update public.news_backfill_targets
    set cursor = p_cursor,
        coverage_reached_at = case
            when p_coverage_reached_at is null then coverage_reached_at
            when coverage_reached_at is null then p_coverage_reached_at
            else least(coverage_reached_at, p_coverage_reached_at)
        end,
        coverage_evidence_artifact_key = coalesce(
            p_coverage_evidence_artifact_key,
            coverage_evidence_artifact_key
        ),
        updated_at = pg_catalog.now()
    where id = p_target_id and status = 'running';

    return found;
end;
$$;

create or replace function public.ingest_news_entries(
    p_target_id uuid,
    p_entries jsonb
)
returns table (
    item_index integer,
    news_entry_id uuid,
    disposition text,
    error_code text
)
language plpgsql
security definer
set search_path = ''
as $$
declare
    v_target public.news_backfill_targets%rowtype;
    v_run public.news_backfill_runs%rowtype;
    v_item jsonb;
    v_ordinal bigint;
    v_candidate_key text;
    v_url text;
    v_url_canonical text;
    v_title text;
    v_summary text;
    v_content_hash text;
    v_external_item_id text;
    v_news_subtype text;
    v_raw_artifact_key text;
    v_published_at timestamptz;
    v_fetched_at timestamptz;
    v_extractor_version integer;
    v_url_entry_id uuid;
    v_external_entry_id uuid;
    v_entry_id uuid;
    v_disposition text;
    v_existing_outcome public.news_backfill_candidate_outcomes%rowtype;
begin
    if p_target_id is null then
        raise exception using errcode = '22004', message = 'target ID is required';
    end if;
    if p_entries is null
       or pg_catalog.jsonb_typeof(p_entries) <> 'array'
       or pg_catalog.jsonb_array_length(p_entries) not between 1 and 100
       or pg_catalog.pg_column_size(p_entries) > 1048576 then
        raise exception using errcode = '22023',
            message = 'entries must be an array of 1 to 100 bounded items';
    end if;

    select * into strict v_target
    from public.news_backfill_targets
    where id = p_target_id and status = 'running';

    select * into strict v_run
    from public.news_backfill_runs
    where id = v_target.run_id and status = 'running';

    for v_item, v_ordinal in
        select item.value, item.ordinality
        from pg_catalog.jsonb_array_elements(p_entries)
            with ordinality as item(value, ordinality)
    loop
        v_candidate_key := v_item ->> 'candidate_key';
        if v_candidate_key is null
           or v_candidate_key !~ '^[0-9a-f]{64}$' then
            raise exception using errcode = '22023',
                message = 'every candidate key must be a sha256 hex string';
        end if;

        select * into v_existing_outcome
        from public.news_backfill_candidate_outcomes as outcome
        where outcome.target_id = p_target_id
          and outcome.candidate_key = v_candidate_key;

        if found then
            item_index := v_ordinal::integer;
            news_entry_id := v_existing_outcome.news_entry_id;
            disposition := v_existing_outcome.disposition;
            error_code := v_existing_outcome.error_code;
            return next;
            continue;
        end if;

        v_raw_artifact_key := v_item ->> 'raw_artifact_key';
        if v_raw_artifact_key is null
           or length(v_raw_artifact_key) not between 1 and 2048 then
            v_raw_artifact_key := 'invalid/' || v_candidate_key;
        end if;

        begin
            if pg_catalog.jsonb_typeof(v_item) <> 'object' then
                raise exception using errcode = '22023', message = 'item is not an object';
            end if;

            v_url := v_item ->> 'url';
            v_url_canonical := v_item ->> 'url_canonical';
            v_title := v_item ->> 'title';
            v_summary := nullif(v_item ->> 'summary', '');
            v_content_hash := v_item ->> 'content_hash';
            v_external_item_id := nullif(v_item ->> 'external_item_id', '');
            v_news_subtype := v_item ->> 'news_subtype';
            v_published_at := (v_item ->> 'published_at')::timestamptz;
            v_fetched_at := coalesce(
                (v_item ->> 'fetched_at')::timestamptz,
                pg_catalog.now()
            );
            v_extractor_version := coalesce(
                (v_item ->> 'extractor_version')::integer,
                1
            );

            if v_url is null
               or length(v_url) not between 1 and 2048
               or v_url !~ '^https?://'
               or v_url_canonical is null
               or length(v_url_canonical) not between 1 and 2048
               or v_url_canonical !~ '^https?://'
               or v_title is null
               or length(pg_catalog.btrim(v_title)) not between 1 and 1024
               or (v_summary is not null and length(v_summary) > 16384)
               or v_content_hash is null
               or v_content_hash !~ '^[0-9a-f]{64}$'
               or (
                   v_external_item_id is not null
                   and length(v_external_item_id) > 2048
               )
               or v_news_subtype is null
               or v_news_subtype not in (
                   'press_release', 'agency_news', 'advisory', 'release'
               )
               or v_extractor_version < 1
               or v_raw_artifact_key like 'invalid/%' then
                raise exception using errcode = '22023',
                    message = 'normalized entry fields are invalid';
            end if;
            if v_published_at < v_run.window_start
               or v_published_at >= v_run.window_end then
                raise exception using errcode = '22023',
                    message = 'published_at is outside the run window';
            end if;

            v_url_entry_id := null;
            v_external_entry_id := null;

            select entry.id into v_url_entry_id
            from public.news_entries as entry
            where entry.url_canonical = v_url_canonical;

            if v_external_item_id is not null then
                select origin.news_entry_id into v_external_entry_id
                from public.news_entry_origins as origin
                where origin.news_source_id = v_target.news_source_id
                  and origin.external_item_id = v_external_item_id;
            end if;

            if v_url_entry_id is not null
               and v_external_entry_id is not null
               and v_url_entry_id <> v_external_entry_id then
                insert into public.news_backfill_identity_conflicts (
                    target_id,
                    candidate_key,
                    url_news_entry_id,
                    external_news_entry_id,
                    raw_artifact_key
                ) values (
                    p_target_id,
                    v_candidate_key,
                    v_url_entry_id,
                    v_external_entry_id,
                    v_raw_artifact_key
                );

                insert into public.news_backfill_candidate_outcomes (
                    target_id,
                    candidate_key,
                    disposition,
                    error_code,
                    raw_artifact_key
                ) values (
                    p_target_id,
                    v_candidate_key,
                    'identity_conflict',
                    'identity_conflict',
                    v_raw_artifact_key
                );

                update public.news_backfill_targets
                set candidates_seen = candidates_seen + 1,
                    rejected_count = rejected_count + 1,
                    conflict_count = conflict_count + 1,
                    updated_at = pg_catalog.now()
                where id = p_target_id;

                item_index := v_ordinal::integer;
                news_entry_id := null;
                disposition := 'identity_conflict';
                error_code := 'identity_conflict';
                return next;
                continue;
            end if;

            if v_external_entry_id is not null then
                v_entry_id := v_external_entry_id;
                v_disposition := 'existing_external_id';
            elsif v_url_entry_id is not null then
                v_entry_id := v_url_entry_id;
                v_disposition := 'existing_url';
            else
                insert into public.news_entries (
                    news_source_id,
                    url,
                    url_canonical,
                    title,
                    summary,
                    published_at,
                    fetched_at,
                    content_hash,
                    extractor_version
                ) values (
                    v_target.news_source_id,
                    v_url,
                    v_url_canonical,
                    pg_catalog.btrim(v_title),
                    v_summary,
                    v_published_at,
                    v_fetched_at,
                    v_content_hash,
                    v_extractor_version
                )
                on conflict (url_canonical) do nothing
                returning id into v_entry_id;

                if v_entry_id is null then
                    select entry.id into strict v_entry_id
                    from public.news_entries as entry
                    where entry.url_canonical = v_url_canonical;
                    v_disposition := 'existing_url';
                else
                    v_disposition := 'inserted';
                end if;
            end if;

            insert into public.news_entry_origins (
                news_entry_id,
                news_source_id,
                external_item_id,
                news_subtype,
                first_observed_at,
                last_observed_at
            ) values (
                v_entry_id,
                v_target.news_source_id,
                v_external_item_id,
                v_news_subtype,
                v_fetched_at,
                v_fetched_at
            )
            on conflict on constraint news_entry_origins_pkey do update
            set external_item_id = coalesce(
                    news_entry_origins.external_item_id,
                    excluded.external_item_id
                ),
                news_subtype = excluded.news_subtype,
                last_observed_at = greatest(
                    news_entry_origins.last_observed_at,
                    excluded.last_observed_at
                );

            insert into public.news_backfill_run_entries (
                target_id,
                candidate_key,
                news_entry_id,
                disposition,
                raw_artifact_key,
                extractor_version
            ) values (
                p_target_id,
                v_candidate_key,
                v_entry_id,
                v_disposition,
                v_raw_artifact_key,
                v_extractor_version
            );

            insert into public.news_backfill_candidate_outcomes (
                target_id,
                candidate_key,
                disposition,
                news_entry_id,
                raw_artifact_key
            ) values (
                p_target_id,
                v_candidate_key,
                v_disposition,
                v_entry_id,
                v_raw_artifact_key
            );

            update public.news_backfill_targets
            set candidates_seen = candidates_seen + 1,
                inserted_count = inserted_count
                    + case when v_disposition = 'inserted' then 1 else 0 end,
                existing_count = existing_count
                    + case when v_disposition <> 'inserted' then 1 else 0 end,
                oldest_published_at = case
                    when oldest_published_at is null then v_published_at
                    else least(oldest_published_at, v_published_at)
                end,
                newest_published_at = case
                    when newest_published_at is null then v_published_at
                    else greatest(newest_published_at, v_published_at)
                end,
                updated_at = pg_catalog.now()
            where id = p_target_id;

            item_index := v_ordinal::integer;
            news_entry_id := v_entry_id;
            disposition := v_disposition;
            error_code := null;
            return next;
        exception when others then
            insert into public.news_backfill_candidate_outcomes (
                target_id,
                candidate_key,
                disposition,
                error_code,
                raw_artifact_key
            ) values (
                p_target_id,
                v_candidate_key,
                'rejected',
                coalesce(sqlstate, 'unknown_error'),
                v_raw_artifact_key
            )
            on conflict (target_id, candidate_key) do nothing;

            update public.news_backfill_targets
            set candidates_seen = candidates_seen + 1,
                rejected_count = rejected_count + 1,
                updated_at = pg_catalog.now()
            where id = p_target_id;

            item_index := v_ordinal::integer;
            news_entry_id := null;
            disposition := 'rejected';
            error_code := coalesce(sqlstate, 'unknown_error');
            return next;
        end;
    end loop;
end;
$$;

create or replace function public.complete_news_backfill_target(
    p_target_id uuid,
    p_status text,
    p_cursor jsonb,
    p_stop_reason text,
    p_coverage_reached_at timestamptz default null,
    p_coverage_evidence_artifact_key text default null,
    p_error_code text default null,
    p_error_detail text default null
)
returns boolean
language plpgsql
security definer
set search_path = ''
as $$
begin
    if p_target_id is null then
        raise exception using errcode = '22004', message = 'target ID is required';
    end if;
    if p_status is null
       or p_status not in ('succeeded', 'partial', 'failed', 'cancelled') then
        raise exception using errcode = '22023', message = 'terminal status is invalid';
    end if;
    if p_cursor is null
       or pg_catalog.jsonb_typeof(p_cursor) <> 'object'
       or pg_catalog.pg_column_size(p_cursor) > 32768
       or p_stop_reason is null
       or length(pg_catalog.btrim(p_stop_reason)) not between 1 and 128 then
        raise exception using errcode = '22023',
            message = 'terminal cursor and stop reason are required';
    end if;

    update public.news_backfill_targets
    set status = p_status,
        cursor = p_cursor,
        stop_reason = pg_catalog.btrim(p_stop_reason),
        coverage_reached_at = p_coverage_reached_at,
        coverage_evidence_artifact_key = p_coverage_evidence_artifact_key,
        last_error_code = p_error_code,
        last_error_detail = p_error_detail,
        completed_at = pg_catalog.now(),
        updated_at = pg_catalog.now()
    where id = p_target_id and status in ('pending', 'running');

    return found;
end;
$$;

create or replace function public.finish_news_backfill_run(p_run_id uuid)
returns text
language plpgsql
security definer
set search_path = ''
as $$
declare
    v_status text;
    v_target_count integer;
    v_active_count integer;
begin
    if p_run_id is null then
        raise exception using errcode = '22004', message = 'run ID is required';
    end if;

    select count(*)::integer,
        count(*) filter (where status in ('pending', 'running'))::integer
    into v_target_count, v_active_count
    from public.news_backfill_targets
    where run_id = p_run_id;

    if v_target_count = 0 then
        raise exception using errcode = '22023', message = 'run has no targets';
    end if;
    if v_active_count > 0 then
        raise exception using errcode = '55000', message = 'run still has active targets';
    end if;

    select case
        when bool_and(status = 'succeeded') then 'succeeded'
        when bool_or(status in ('succeeded', 'partial')) then 'partial'
        else 'failed'
    end
    into v_status
    from public.news_backfill_targets
    where run_id = p_run_id;

    update public.news_backfill_runs
    set status = v_status,
        counters = (
            select pg_catalog.jsonb_build_object(
                'targets', count(*),
                'candidates', sum(candidates_seen),
                'inserted', sum(inserted_count),
                'existing', sum(existing_count),
                'rejected', sum(rejected_count),
                'conflicts', sum(conflict_count)
            )
            from public.news_backfill_targets
            where run_id = p_run_id
        ),
        completed_at = pg_catalog.now(),
        updated_at = pg_catalog.now()
    where id = p_run_id and status in ('pending', 'running');

    if not found then
        select status into strict v_status
        from public.news_backfill_runs
        where id = p_run_id;
    end if;

    return v_status;
end;
$$;

comment on function public.register_curated_news_source is
    'Service-only curated source registration that does not require a discovery lease.';
comment on function public.begin_news_backfill_run is
    'Creates or resumes an immutable fixed-window news backfill run by run key.';
comment on function public.ensure_news_backfill_target is
    'Creates or resumes one publisher/source adapter target within an active run.';
comment on function public.checkpoint_news_backfill_target is
    'Persists an adapter cursor only after its preceding ingest batch has committed.';
comment on function public.ingest_news_entries is
    'Validates and idempotently ingests at most 100 normalized news candidates for an active target.';
comment on function public.complete_news_backfill_target is
    'Records terminal target coverage evidence and bounded failure details.';
comment on function public.finish_news_backfill_run is
    'Closes a run after every target is terminal and materializes aggregate counters.';

revoke execute on function public.register_curated_news_source(
    text, text, text, text, jsonb, text[], timestamptz, timestamptz, uuid, text
) from public, anon, authenticated;
revoke execute on function public.begin_news_backfill_run(
    text, text, text, timestamptz, timestamptz
) from public, anon, authenticated;
revoke execute on function public.ensure_news_backfill_target(
    uuid, text, text, uuid, text
) from public, anon, authenticated;
revoke execute on function public.checkpoint_news_backfill_target(
    uuid, jsonb, timestamptz, text
) from public, anon, authenticated;
revoke execute on function public.ingest_news_entries(uuid, jsonb)
    from public, anon, authenticated;
revoke execute on function public.complete_news_backfill_target(
    uuid, text, jsonb, text, timestamptz, text, text, text
) from public, anon, authenticated;
revoke execute on function public.finish_news_backfill_run(uuid)
    from public, anon, authenticated;

grant execute on function public.register_curated_news_source(
    text, text, text, text, jsonb, text[], timestamptz, timestamptz, uuid, text
) to service_role;
grant execute on function public.begin_news_backfill_run(
    text, text, text, timestamptz, timestamptz
) to service_role;
grant execute on function public.ensure_news_backfill_target(
    uuid, text, text, uuid, text
) to service_role;
grant execute on function public.checkpoint_news_backfill_target(
    uuid, jsonb, timestamptz, text
) to service_role;
grant execute on function public.ingest_news_entries(uuid, jsonb)
    to service_role;
grant execute on function public.complete_news_backfill_target(
    uuid, text, jsonb, text, timestamptz, text, text, text
) to service_role;
grant execute on function public.finish_news_backfill_run(uuid)
    to service_role;

commit;
