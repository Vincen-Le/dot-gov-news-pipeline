begin;

select plan(50);

select is(
    (
        select count(*)::integer
        from pg_catalog.pg_class
        join pg_catalog.pg_namespace
          on pg_namespace.oid = pg_class.relnamespace
        where pg_namespace.nspname = 'public'
          and pg_class.relkind = 'r'
          and pg_class.relname in (
              'news_backfill_runs',
              'news_backfill_targets',
              'news_entry_origins',
              'news_backfill_run_entries',
              'news_backfill_candidate_outcomes',
              'news_backfill_identity_conflicts'
          )
    ),
    6,
    'creates every backfill control and provenance table'
);

select is(
    (
        select count(*)::integer
        from pg_catalog.pg_class
        join pg_catalog.pg_namespace
          on pg_namespace.oid = pg_class.relnamespace
        where pg_namespace.nspname = 'public'
          and pg_class.relrowsecurity
          and pg_class.relname in (
              'news_backfill_runs',
              'news_backfill_targets',
              'news_entry_origins',
              'news_backfill_run_entries',
              'news_backfill_candidate_outcomes',
              'news_backfill_identity_conflicts'
          )
    ),
    6,
    'enables RLS on every backfill table'
);

select ok(
    not has_table_privilege('anon', 'public.news_backfill_runs', 'select')
    and not has_table_privilege(
        'authenticated',
        'public.news_backfill_targets',
        'select'
    ),
    'client roles cannot read backfill control state'
);

select ok(
    has_table_privilege('service_role', 'public.news_backfill_runs', 'select')
    and has_table_privilege(
        'service_role',
        'public.news_backfill_candidate_outcomes',
        'select'
    ),
    'service role can audit backfill state'
);

select ok(
    not has_table_privilege('service_role', 'public.news_backfill_runs', 'insert')
    and not has_table_privilege(
        'service_role',
        'public.news_backfill_targets',
        'update'
    )
    and not has_table_privilege(
        'service_role',
        'public.news_entry_origins',
        'delete'
    ),
    'service role cannot write backfill tables directly'
);

select is(
    (
        select constraint_row.confdeltype::text
        from pg_catalog.pg_constraint as constraint_row
        where constraint_row.conname = 'news_entries_news_source_id_fkey'
    ),
    'r',
    'news entry source deletion is restricted'
);

select ok(
    has_function_privilege(
        'service_role',
        'public.register_curated_news_source(text,text,text,text,jsonb,text[],timestamptz,timestamptz,uuid,text)',
        'execute'
    )
    and has_function_privilege(
        'service_role',
        'public.begin_news_backfill_run(text,text,text,timestamptz,timestamptz)',
        'execute'
    )
    and has_function_privilege(
        'service_role',
        'public.ensure_news_backfill_target(uuid,text,text,uuid,text)',
        'execute'
    )
    and has_function_privilege(
        'service_role',
        'public.ingest_news_entries(uuid,jsonb)',
        'execute'
    ),
    'service role can execute the backfill database functions'
);

select ok(
    not has_function_privilege(
        'anon',
        'public.ingest_news_entries(uuid,jsonb)',
        'execute'
    )
    and not has_function_privilege(
        'authenticated',
        'public.begin_news_backfill_run(text,text,text,timestamptz,timestamptz)',
        'execute'
    ),
    'client roles cannot execute backfill database functions'
);

select ok(
    has_function_privilege(
        'service_role',
        'public.cancel_news_backfill_run(uuid,text)',
        'execute'
    )
    and has_function_privilege(
        'service_role',
        'public.purge_cancelled_backfill_target_entries(uuid)',
        'execute'
    )
    and has_function_privilege(
        'service_role',
        'public.reopen_news_backfill_target(uuid,text)',
        'execute'
    ),
    'service role can execute corrective backfill maintenance functions'
);

select ok(
    not has_function_privilege(
        'anon',
        'public.cancel_news_backfill_run(uuid,text)',
        'execute'
    )
    and not has_function_privilege(
        'authenticated',
        'public.purge_cancelled_backfill_target_entries(uuid)',
        'execute'
    )
    and not has_function_privilege(
        'authenticated',
        'public.reopen_news_backfill_target(uuid,text)',
        'execute'
    ),
    'client roles cannot execute corrective backfill maintenance functions'
);

create temporary table source_fixture as
select public.register_curated_news_source(
    'https://example.gov/news/feed.xml',
    'rss',
    'Example News',
    'https://example.gov/news',
    '{"adapter":"syndication"}'::jsonb,
    '{}'::text[]
) as source_id;

select ok(
    (select source_id is not null from source_fixture),
    'registers a curated news source'
);

select is(
    public.register_curated_news_source(
        'https://example.gov/news/feed.xml',
        'rss',
        'Example News',
        'https://example.gov/news',
        '{"adapter":"syndication"}'::jsonb,
        '{}'::text[]
    ),
    (select source_id from source_fixture),
    'source registration is idempotent by canonical URL'
);

create temporary table run_fixture as
select public.begin_news_backfill_run(
    'top-20-test-2026',
    'top-20-diversity-v1',
    repeat('1', 64),
    '2025-07-18 00:00:00+00'::timestamptz,
    '2026-07-18 00:00:00+00'::timestamptz
) as run_id;

select ok(
    (select run_id is not null from run_fixture),
    'begins a fixed-window backfill run'
);

select is(
    public.begin_news_backfill_run(
        'top-20-test-2026',
        'top-20-diversity-v1',
        repeat('1', 64),
        '2025-07-18 00:00:00+00'::timestamptz,
        '2026-07-18 00:00:00+00'::timestamptz
    ),
    (select run_id from run_fixture),
    'begin run is idempotent for immutable inputs'
);

create temporary table target_one_fixture as
select public.ensure_news_backfill_target(
    (select run_id from run_fixture),
    'example',
    'primary-feed',
    (select source_id from source_fixture),
    'syndication'
) as target_id;

select ok(
    (select target_id is not null from target_one_fixture),
    'creates a resumable source target'
);

create temporary table first_ingest as
select *
from public.ingest_news_entries(
    (select target_id from target_one_fixture),
    pg_catalog.jsonb_build_array(
        pg_catalog.jsonb_build_object(
            'candidate_key', repeat('a', 64),
            'url', 'https://example.gov/news/a?utm_source=test',
            'url_canonical', 'https://example.gov/news/a',
            'title', 'Agency announces program A',
            'summary', 'The agency announced a nationwide program.',
            'published_at', '2026-05-01T12:00:00Z',
            'fetched_at', '2026-07-18T00:00:00Z',
            'content_hash', repeat('b', 64),
            'external_item_id', 'item-a',
            'news_subtype', 'press_release',
            'extractor_version', 1,
            'raw_artifact_key', 'news-backfill/test/a.json'
        )
    )
);

select is(
    (select disposition from first_ingest),
    'inserted',
    'inserts a valid normalized candidate'
);

select is(
    (select count(*)::integer from public.news_entries),
    1,
    'creates one canonical news entry'
);

select is(
    (select count(*)::integer from public.news_backfill_run_entries),
    1,
    'records exact run membership'
);

create temporary table replay_ingest as
select *
from public.ingest_news_entries(
    (select target_id from target_one_fixture),
    pg_catalog.jsonb_build_array(
        pg_catalog.jsonb_build_object(
            'candidate_key', repeat('a', 64),
            'url', 'https://example.gov/news/a?utm_source=test',
            'url_canonical', 'https://example.gov/news/a',
            'title', 'Agency announces program A',
            'summary', 'The agency announced a nationwide program.',
            'published_at', '2026-05-01T12:00:00Z',
            'content_hash', repeat('b', 64),
            'external_item_id', 'item-a',
            'news_subtype', 'press_release',
            'extractor_version', 1,
            'raw_artifact_key', 'news-backfill/test/a.json'
        )
    )
);

select is(
    (select disposition from replay_ingest),
    'inserted',
    'replay returns the original disposition'
);

select is(
    (select count(*)::integer from public.news_entries),
    1,
    'replay does not duplicate the canonical entry'
);

select is(
    (
        select candidates_seen
        from public.news_backfill_targets
        where id = (select target_id from target_one_fixture)
    ),
    1,
    'replay does not increment target counters'
);

create temporary table source_two_fixture as
select public.register_curated_news_source(
    'https://other.gov/archive',
    'html_archive',
    'Other News',
    'https://other.gov/news',
    '{"adapter":"html_archive"}'::jsonb,
    '{}'::text[]
) as source_id;

create temporary table target_two_fixture as
select public.ensure_news_backfill_target(
    (select run_id from run_fixture),
    'other',
    'archive',
    (select source_id from source_two_fixture),
    'html_archive'
) as target_id;

create temporary table duplicate_url_ingest as
select *
from public.ingest_news_entries(
    (select target_id from target_two_fixture),
    pg_catalog.jsonb_build_array(
        pg_catalog.jsonb_build_object(
            'candidate_key', repeat('c', 64),
            'url', 'https://example.gov/news/a',
            'url_canonical', 'https://example.gov/news/a',
            'title', 'Agency announces program A',
            'summary', 'Syndicated copy.',
            'published_at', '2026-05-01T12:00:00Z',
            'content_hash', repeat('d', 64),
            'external_item_id', 'other-item-a',
            'news_subtype', 'agency_news',
            'extractor_version', 1,
            'raw_artifact_key', 'news-backfill/test/other-a.json'
        )
    )
);

select is(
    (select disposition from duplicate_url_ingest),
    'existing_url',
    'deduplicates a canonical URL observed from another source'
);

select is(
    (select count(*)::integer from public.news_entry_origins),
    2,
    'preserves both source origins for a shared canonical URL'
);

create temporary table rejected_ingest as
select *
from public.ingest_news_entries(
    (select target_id from target_one_fixture),
    pg_catalog.jsonb_build_array(
        pg_catalog.jsonb_build_object(
            'candidate_key', repeat('e', 64),
            'url', 'https://example.gov/news/old',
            'url_canonical', 'https://example.gov/news/old',
            'title', 'Old announcement',
            'published_at', '2024-01-01T00:00:00Z',
            'content_hash', repeat('f', 64),
            'news_subtype', 'press_release',
            'extractor_version', 1,
            'raw_artifact_key', 'news-backfill/test/old.json'
        )
    )
);

select is(
    (select disposition from rejected_ingest),
    'rejected',
    'rejects an entry outside the fixed run window'
);

select is(
    (
        select rejected_count
        from public.news_backfill_targets
        where id = (select target_id from target_one_fixture)
    ),
    1,
    'counts a rejected candidate once'
);

create temporary table second_entry_ingest as
select *
from public.ingest_news_entries(
    (select target_id from target_one_fixture),
    pg_catalog.jsonb_build_array(
        pg_catalog.jsonb_build_object(
            'candidate_key', repeat('2', 64),
            'url', 'https://example.gov/news/b',
            'url_canonical', 'https://example.gov/news/b',
            'title', 'Agency announces program B',
            'summary', 'A second program.',
            'published_at', '2026-06-01T12:00:00Z',
            'content_hash', repeat('3', 64),
            'news_subtype', 'press_release',
            'extractor_version', 1,
            'raw_artifact_key', 'news-backfill/test/b.json'
        )
    )
);

select is(
    (select disposition from second_entry_ingest),
    'inserted',
    'inserts a second distinct canonical entry'
);

create temporary table conflict_ingest as
select *
from public.ingest_news_entries(
    (select target_id from target_one_fixture),
    pg_catalog.jsonb_build_array(
        pg_catalog.jsonb_build_object(
            'candidate_key', repeat('4', 64),
            'url', 'https://example.gov/news/b',
            'url_canonical', 'https://example.gov/news/b',
            'title', 'Conflicting publisher identity',
            'published_at', '2026-06-01T12:00:00Z',
            'content_hash', repeat('5', 64),
            'external_item_id', 'item-a',
            'news_subtype', 'press_release',
            'extractor_version', 1,
            'raw_artifact_key', 'news-backfill/test/conflict.json'
        )
    )
);

select is(
    (select disposition from conflict_ingest),
    'identity_conflict',
    'quarantines conflicting canonical and publisher identities'
);

select is(
    (select count(*)::integer from public.news_backfill_identity_conflicts),
    1,
    'persists identity conflict evidence'
);

select throws_ok(
    format(
        'delete from public.news_sources where id = %L',
        (select source_id from source_fixture)
    ),
    '23503',
    null,
    'cannot delete a source that owns canonical entries'
);

select throws_ok(
    format(
        'select public.finish_news_backfill_run(%L)',
        (select run_id from run_fixture)
    ),
    '55000',
    'run still has active targets',
    'cannot finish a run with active targets'
);

select ok(
    public.complete_news_backfill_target(
        (select target_id from target_one_fixture),
        'succeeded',
        '{"page":4}'::jsonb,
        'window_boundary_reached',
        '2025-07-01 00:00:00+00'::timestamptz,
        'news-backfill/test/coverage-one.json'
    ),
    'completes the first target with traversal evidence'
);

select ok(
    public.complete_news_backfill_target(
        (select target_id from target_two_fixture),
        'succeeded',
        '{"page":1}'::jsonb,
        'window_boundary_reached',
        '2025-07-01 00:00:00+00'::timestamptz,
        'news-backfill/test/coverage-two.json'
    ),
    'completes the second target with traversal evidence'
);

select is(
    public.finish_news_backfill_run((select run_id from run_fixture)),
    'succeeded',
    'finishes a run after all targets succeed'
);

select is(
    (
        select (counters ->> 'inserted')::integer
        from public.news_backfill_runs
        where id = (select run_id from run_fixture)
    ),
    2,
    'materializes inserted count on the completed run'
);

select is(
    (
        select (counters ->> 'existing')::integer
        from public.news_backfill_runs
        where id = (select run_id from run_fixture)
    ),
    1,
    'materializes existing count on the completed run'
);

select is(
    (
        select (counters ->> 'conflicts')::integer
        from public.news_backfill_runs
        where id = (select run_id from run_fixture)
    ),
    1,
    'materializes conflict count on the completed run'
);

select is(
    (
        select coverage_reached_at
        from public.news_backfill_targets
        where id = (select target_id from target_one_fixture)
    ),
    '2025-07-01 00:00:00+00'::timestamptz,
    'stores the proven traversal boundary separately from item dates'
);

select is(
    (
        select stop_reason
        from public.news_backfill_targets
        where id = (select target_id from target_one_fixture)
    ),
    'window_boundary_reached',
    'stores the target stop reason'
);

create temporary table cancelled_run_fixture as
select public.begin_news_backfill_run(
    'top-20-cancelled-test-2026',
    'top-20-diversity-v2',
    repeat('9', 64),
    '2025-07-18 00:00:00+00'::timestamptz,
    '2026-07-18 00:00:00+00'::timestamptz
) as run_id;

create temporary table cancelled_target_fixture as
select public.ensure_news_backfill_target(
    (select run_id from cancelled_run_fixture),
    'example',
    'superseded-feed',
    (select source_id from source_fixture),
    'syndication'
) as target_id;

select is(
    (
        select disposition
        from public.ingest_news_entries(
            (select target_id from cancelled_target_fixture),
            pg_catalog.jsonb_build_array(
                pg_catalog.jsonb_build_object(
                    'candidate_key', repeat('8', 64),
                    'url', 'https://example.gov/news/superseded',
                    'url_canonical', 'https://example.gov/news/superseded',
                    'title', 'Superseded extraction result',
                    'published_at', '2026-06-15T12:00:00Z',
                    'content_hash', repeat('7', 64),
                    'news_subtype', 'press_release',
                    'extractor_version', 1,
                    'raw_artifact_key', 'news-backfill/test/superseded.json'
                )
            )
        )
    ),
    'inserted',
    'creates an entry owned exclusively by the superseded target'
);

select ok(
    public.cancel_news_backfill_run(
        (select run_id from cancelled_run_fixture),
        'Superseded after an extraction defect was found.'
    ),
    'cancels an active backfill run'
);

select is(
    (
        select status
        from public.news_backfill_runs
        where id = (select run_id from cancelled_run_fixture)
    ),
    'cancelled',
    'marks the superseded run cancelled'
);

select is(
    (
        select status
        from public.news_backfill_targets
        where id = (select target_id from cancelled_target_fixture)
    ),
    'cancelled',
    'marks the active target cancelled with its run'
);

select is(
    public.purge_cancelled_backfill_target_entries(
        (select target_id from cancelled_target_fixture)
    ),
    1,
    'purges the entry owned exclusively by the cancelled target'
);

select is(
    (
        select count(*)::integer
        from public.news_entries
        where url_canonical = 'https://example.gov/news/superseded'
    ),
    0,
    'removes the superseded canonical entry'
);

select is(
    (
        select inserted_count
        from public.news_backfill_targets
        where id = (select target_id from cancelled_target_fixture)
    ),
    0,
    'resets the cancelled target counters after cleanup'
);

select throws_ok(
    format(
        'select public.purge_cancelled_backfill_target_entries(%L)',
        (select target_id from target_one_fixture)
    ),
    '55000',
    'only cancelled target entries can be purged',
    'refuses to purge a target that was not cancelled'
);

create temporary table reopen_run_fixture as
select public.begin_news_backfill_run(
    'top-20-reopen-test-2026',
    'top-20-diversity-v2',
    repeat('6', 64),
    '2025-07-18 00:00:00+00'::timestamptz,
    '2026-07-18 00:00:00+00'::timestamptz
) as run_id;

create temporary table reopen_target_fixture as
select public.ensure_news_backfill_target(
    (select run_id from reopen_run_fixture),
    'example',
    'failed-feed',
    (select source_id from source_fixture),
    'syndication'
) as target_id;

create temporary table reopen_active_target_fixture as
select public.ensure_news_backfill_target(
    (select run_id from reopen_run_fixture),
    'other',
    'active-feed',
    (select source_id from source_two_fixture),
    'syndication'
) as target_id;

select ok(
    public.complete_news_backfill_target(
        (select target_id from reopen_target_fixture),
        'failed',
        '{"page":2}'::jsonb,
        'publisher_failure',
        null,
        null,
        'publisher_failure',
        'Timed out before corrective filtering.'
    ),
    'creates a terminal failed target in an otherwise active run'
);

select ok(
    public.reopen_news_backfill_target(
        (select target_id from reopen_target_fixture),
        'Corrected archive filtering is ready.'
    ),
    'reopens a terminal target while its run remains active'
);

select is(
    (
        select status
        from public.news_backfill_targets
        where id = (select target_id from reopen_target_fixture)
    ),
    'running',
    'marks the corrected target running again'
);

select throws_ok(
    format(
        'select public.reopen_news_backfill_target(%L, %L)',
        (select target_id from target_one_fixture),
        'Completed run cannot be reopened.'
    ),
    '55000',
    'target run is already terminal',
    'refuses to reopen a target from a terminal run'
);

select * from finish();

rollback;
