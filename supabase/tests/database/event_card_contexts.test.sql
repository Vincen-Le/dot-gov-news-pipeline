begin;

select plan(23);

select has_table('public', 'event_card_contexts', 'event_card_contexts exists');
select has_table(
    'public', 'golden_event_card_contexts',
    'golden event-card context mirror exists'
);

select has_function(
    'public', 'insert_event_card',
    array[
        'uuid', 'uuid', 'text', 'text', 'text', 'jsonb', 'jsonb', 'integer',
        'text', 'uuid', 'text', 'integer', 'bytea', 'double precision', 'uuid',
        'integer'
    ],
    'card RPC accepts preallocated run and publisher-weight provenance'
);

insert into public.news_sources (id, canonical_url, source_type)
values
    ('00000000-0000-4000-8000-00000000c101', 'https://context-one.example.gov/rss', 'rss'),
    ('00000000-0000-4000-8000-00000000c102', 'https://context-two.example.gov/rss', 'rss');

insert into public.news_source_publishers (news_source_id, publisher_key)
values
    ('00000000-0000-4000-8000-00000000c101', 'fda'),
    ('00000000-0000-4000-8000-00000000c102', 'doj');

insert into public.news_entries (
    id, news_source_id, url, url_canonical, title, summary, content_hash,
    published_at, entity_set, event_keys
) values
    (
        '00000000-0000-4000-8000-00000000c111',
        '00000000-0000-4000-8000-00000000c101',
        'https://context-one.example.gov/one',
        'https://context-one.example.gov/one',
        'First event', 'First event summary', repeat('ab', 32),
        '2026-05-01T12:00:00Z', array['first'], array['event-1']
    ),
    (
        '00000000-0000-4000-8000-00000000c112',
        '00000000-0000-4000-8000-00000000c102',
        'https://context-two.example.gov/two',
        'https://context-two.example.gov/two',
        'Second event', 'Second event summary', repeat('cd', 32),
        '2026-05-10T12:00:00Z', array['second'], array['event-2']
    );

insert into public.storylines (
    id, first_entry_at, newest_entry_at, episode_count
) values (
    '00000000-0000-4000-8000-00000000c121',
    '2026-05-01T12:00:00Z', '2026-05-01T12:00:00Z', 1
);

insert into public.episodes (
    id, storyline_id, first_entry_at, newest_entry_at, attach_method
) values (
    '00000000-0000-4000-8000-00000000c131',
    '00000000-0000-4000-8000-00000000c121',
    '2026-05-01T12:00:00Z', '2026-05-01T12:00:00Z', 'new_storyline'
);

select public.attach_entry_to_episode(
    '00000000-0000-4000-8000-00000000c111',
    '00000000-0000-4000-8000-00000000c131',
    'fda', false, 'new_cluster', null, null, null, null, null,
    '2026-05-01T12:00:00Z', 1
);

select public.insert_event_card(
    p_storyline_id => '00000000-0000-4000-8000-00000000c121',
    p_episode_id => null,
    p_kind => 'overview',
    p_headline => 'First overview',
    p_summary => 'The first state.',
    p_timeline => '[]'::jsonb,
    p_rubric => null,
    p_rubric_version => null,
    p_interest_reason => null,
    p_representative_entry_id => '00000000-0000-4000-8000-00000000c111',
    p_judge_model => null,
    p_prompt_version => 1,
    p_overview_embedding => null,
    p_tau => 124600.0,
    p_source_run_id => '00000000-0000-4000-8000-00000000c141',
    p_publisher_weight_version => 1
);

select is(
    (
        select entry_count
        from public.event_card_contexts context
        join public.event_cards card on card.id = context.event_card_id
        where card.storyline_id = '00000000-0000-4000-8000-00000000c121'
          and card.kind = 'overview' and card.version = 1
    ),
    1,
    'first overview freezes one source entry'
);

select is(
    (
        select episode_count
        from public.event_card_contexts context
        join public.event_cards card on card.id = context.event_card_id
        where card.storyline_id = '00000000-0000-4000-8000-00000000c121'
          and card.kind = 'overview' and card.version = 1
    ),
    1,
    'first overview freezes one episode'
);

insert into public.episodes (
    id, storyline_id, first_entry_at, newest_entry_at, attach_method
) values (
    '00000000-0000-4000-8000-00000000c132',
    '00000000-0000-4000-8000-00000000c121',
    '2026-05-10T12:00:00Z', '2026-05-10T12:00:00Z', 'new_storyline'
);

update public.storylines
set episode_count = 2
where id = '00000000-0000-4000-8000-00000000c121';

select public.attach_entry_to_episode(
    '00000000-0000-4000-8000-00000000c112',
    '00000000-0000-4000-8000-00000000c132',
    'doj', false, 'new_cluster', null, null, null, null, null,
    '2026-05-10T12:00:00Z', 1
);

select public.insert_event_card(
    p_storyline_id => '00000000-0000-4000-8000-00000000c121',
    p_episode_id => null,
    p_kind => 'overview',
    p_headline => 'Second overview',
    p_summary => 'The later state.',
    p_timeline => '[]'::jsonb,
    p_rubric => null,
    p_rubric_version => null,
    p_interest_reason => null,
    p_representative_entry_id => '00000000-0000-4000-8000-00000000c112',
    p_judge_model => null,
    p_prompt_version => 1,
    p_overview_embedding => null,
    p_tau => 124600.0,
    p_source_run_id => '00000000-0000-4000-8000-00000000c141',
    p_publisher_weight_version => 1
);

select results_eq(
    $$
        select card.version, context.entry_count, context.episode_count
        from public.event_card_contexts context
        join public.event_cards card on card.id = context.event_card_id
        where card.storyline_id = '00000000-0000-4000-8000-00000000c121'
          and card.kind = 'overview'
        order by card.version
    $$,
    $$values (1, 1, 1), (2, 2, 2)$$,
    'later storyline growth creates a new context without mutating the old one'
);

select is(
    (
        select source_run_id
        from public.event_card_contexts context
        join public.event_cards card on card.id = context.event_card_id
        where card.storyline_id = '00000000-0000-4000-8000-00000000c121'
          and card.kind = 'overview' and card.version = 1
    ),
    '00000000-0000-4000-8000-00000000c141'::uuid,
    'preallocated run provenance is captured at card birth'
);

select ok(
    (
        select context_hash ~ '^md5:[0-9a-f]{32}$'
        from public.event_card_contexts context
        join public.event_cards card on card.id = context.event_card_id
        where card.storyline_id = '00000000-0000-4000-8000-00000000c121'
          and card.kind = 'overview' and card.version = 1
    ),
    'context has a deterministic integrity receipt'
);

select ok(
    (
        select rank_input @> '{
            "input_schema_version": 1,
            "distinct_agencies": 1,
            "distinct_feeds": 1,
            "publisher_weight_version": 1
        }'::jsonb
        from public.event_card_contexts context
        join public.event_cards card on card.id = context.event_card_id
        where card.storyline_id = '00000000-0000-4000-8000-00000000c121'
          and card.kind = 'overview' and card.version = 1
    ),
    'card context freezes the exact formula input rather than inferring it later'
);

select ok(
    (
        select abs(
            context.captured_rank_key
            - (
                (context.rank_terms ->> 'rubric_points')::float8
                + (context.rank_terms ->> 'agency_term')::float8
                + (context.rank_terms ->> 'feed_term')::float8
                + (context.rank_terms ->> 'source_term')::float8
                + (context.rank_terms ->> 'freshness_term')::float8
            )
        ) < 0.000001
        and context.captured_rank_key = card.rank_key
        from public.event_card_contexts context
        join public.event_cards card on card.id = context.event_card_id
        where card.storyline_id = '00000000-0000-4000-8000-00000000c121'
          and card.kind = 'overview' and card.version = 1
    ),
    'captured terms reproduce the exact card rank key'
);

select throws_ok(
    $$
        update public.event_card_contexts
        set entry_count = entry_count + 1
        where storyline_id = '00000000-0000-4000-8000-00000000c121'
    $$,
    '55000',
    'event card contexts are immutable',
    'captured context cannot be updated'
);

select ok(
    has_table_privilege('service_role', 'public.event_card_contexts', 'select')
    and not has_table_privilege('service_role', 'public.event_card_contexts', 'insert')
    and not has_table_privilege('service_role', 'public.event_card_contexts', 'update'),
    'service role reads contexts but can only write through card RPC'
);

insert into public.simple_v1_experiment_runs (
    id, name, started_at, finished_at
) values (
    '00000000-0000-4000-8000-00000000c141',
    'context snapshot test',
    '2026-05-01T00:00:00Z',
    '2026-05-11T00:00:00Z'
);

select public.simple_v1_capture_experiment_cluster_snapshot(
    '00000000-0000-4000-8000-00000000c141'
);

select is(
    (
        select schema_version
        from public.simple_v1_experiment_cluster_snapshots
        where run_id = '00000000-0000-4000-8000-00000000c141'
    ),
    3,
    'new experiment snapshots use the exact-rank replay schema version'
);

select is(
    (
        select (row_counts ->> 'event_card_contexts')::integer
        from public.simple_v1_experiment_cluster_snapshots
        where run_id = '00000000-0000-4000-8000-00000000c141'
    ),
    2,
    'experiment snapshot counts every captured card context'
);

select ok(
    (
        select bool_and(
            entry ? 'news_source_id'
            and entry ? 'content_hash'
        )
        from public.simple_v1_experiment_cluster_snapshots snapshot,
             lateral jsonb_array_elements(snapshot.snapshot -> 'news_entries') entry
        where snapshot.run_id = '00000000-0000-4000-8000-00000000c141'
          and entry ->> 'id' in (
              '00000000-0000-4000-8000-00000000c111',
              '00000000-0000-4000-8000-00000000c112'
          )
    ),
    'schema-v2 snapshot freezes source identity and content hashes'
);

insert into public.storylines (
    id, agency_ids, distinct_feeds, entry_count, episode_count,
    first_entry_at, newest_entry_at
) values (
    '00000000-0000-4000-8000-00000000c122',
    array['fda'], 1, 1, 1,
    '2026-05-01T12:00:00Z', '2026-05-01T12:00:00Z'
);
insert into public.episodes (
    id, storyline_id, entry_count, first_entry_at, newest_entry_at,
    attach_method
) values (
    '00000000-0000-4000-8000-00000000c133',
    '00000000-0000-4000-8000-00000000c122', 1,
    '2026-05-01T12:00:00Z', '2026-05-01T12:00:00Z', 'new_storyline'
);
insert into public.episode_entries (
    episode_id, entry_id, is_syndicated, attach_method, attached_at
) values (
    '00000000-0000-4000-8000-00000000c133',
    '00000000-0000-4000-8000-00000000c111', false, 'new_cluster',
    '2026-05-01T12:00:00Z'
);
insert into public.event_cards (
    id, storyline_id, episode_id, kind, version, headline, summary,
    newest_entry_at, rank_key, generated_at
) values (
    '00000000-0000-4000-8000-00000000c151',
    '00000000-0000-4000-8000-00000000c122',
    '00000000-0000-4000-8000-00000000c133', 'episode', 1,
    'Legacy episode card', 'Upgrade fixture episode',
    '2026-05-01T12:00:00Z', 0, '2026-05-01T13:00:00Z'
), (
    '00000000-0000-4000-8000-00000000c152',
    '00000000-0000-4000-8000-00000000c122', null, 'overview', 2,
    'Legacy card without context', 'Upgrade fixture',
    '2026-05-01T12:00:00Z',
    public.compute_rank_key(
        null, null, 1, 1,
        coalesce((
            select max(weight)
            from public.publisher_weights
            where publisher_key = 'fda' and weight_version = 1
        ), 1.0),
        '2026-05-01T12:00:00Z', 124600.0
    ),
    '2026-05-01T13:00:00Z'
);
insert into public.simple_v1_experiment_runs (
    id, name, started_at, finished_at
) values (
    '00000000-0000-4000-8000-00000000c142',
    'incomplete context snapshot test',
    '2026-05-01T00:00:00Z', '2026-05-11T00:00:00Z'
);

select throws_ok(
    $$
        select public.simple_v1_capture_experiment_cluster_snapshot(
            '00000000-0000-4000-8000-00000000c142'
        )
    $$,
    '23514',
    null,
    'upgraded databases cannot label unbackfilled card snapshots schema-v3'
);

select is(
    (public.backfill_event_card_context(
        '00000000-0000-4000-8000-00000000c152',
        '00000000-0000-4000-8000-00000000c142', 1, 124600.0,
        false, false
    ) ->> 'status'),
    'requires_source_replay',
    'missing historical membership requires source replay instead of inference'
);

select is(
    (select count(*)::integer from public.event_card_contexts
     where event_card_id = '00000000-0000-4000-8000-00000000c152'),
    0,
    'context backfill is a dry run by default'
);

-- Simulate a context captured before exact rank-receipt columns existed. Its
-- membership/provenance is already immutable, so only the receipt may be
-- completed in place.
insert into public.event_card_contexts (
    event_card_id, storyline_id, snapshot_schema_version,
    knowledge_cutoff_at, source_run_id, capture_method, source_entry_ids,
    source_content_hashes, episode_ids, first_entry_at, newest_entry_at,
    entry_count, original_entry_count, syndicated_entry_count, episode_count,
    agency_ids, news_source_ids, distinct_feeds, source_weight_max,
    publisher_weight_version, entity_set, event_keys, category_id, theme_id,
    taxonomy_basis, context_hash, captured_at
)
select
    '00000000-0000-4000-8000-00000000c152',
    '00000000-0000-4000-8000-00000000c122', context.snapshot_schema_version,
    context.knowledge_cutoff_at,
    '00000000-0000-4000-8000-00000000c142', 'source_run_replay',
    context.source_entry_ids, context.source_content_hashes,
    array['00000000-0000-4000-8000-00000000c133'::uuid],
    context.first_entry_at, context.newest_entry_at, context.entry_count,
    context.original_entry_count, context.syndicated_entry_count, 1,
    context.agency_ids, context.news_source_ids, context.distinct_feeds,
    context.source_weight_max, context.publisher_weight_version,
    context.entity_set, context.event_keys, context.category_id,
    context.theme_id, 'source_run_final',
    'md5:' || repeat('9', 32), context.captured_at
from public.event_card_contexts context
join public.event_cards card on card.id = context.event_card_id
where card.storyline_id = '00000000-0000-4000-8000-00000000c121'
  and card.kind = 'overview' and card.version = 1;

select is(
    (public.backfill_event_card_context(
        '00000000-0000-4000-8000-00000000c152',
        '00000000-0000-4000-8000-00000000c142', 1, 124600.0,
        false, false
    ) ->> 'status'),
    'exact',
    'pre-receipt frozen overview context proves rank parity'
);

select is(
    (select rank_input is null from public.event_card_contexts
     where event_card_id = '00000000-0000-4000-8000-00000000c152'),
    true,
    'receipt upgrade remains a dry run until explicitly written'
);

select is(
    (public.backfill_event_card_context(
        '00000000-0000-4000-8000-00000000c152',
        '00000000-0000-4000-8000-00000000c142', 1, 124600.0,
        true, false
    ) ->> 'status'),
    'exact',
    'exact frozen context rank receipt can be written explicitly'
);

select ok(
    (select rank_input is not null
            and rank_terms is not null
            and captured_rank_key = card.rank_key
     from public.event_card_contexts context
     join public.event_cards card on card.id = context.event_card_id
     where context.event_card_id = '00000000-0000-4000-8000-00000000c152'),
    'exact backfill stores a replayable rank receipt'
);

select is(
    (public.backfill_event_card_context(
        '00000000-0000-4000-8000-00000000c152',
        '00000000-0000-4000-8000-00000000c142', 1, 124600.0,
        true, false
    ) ->> 'status'),
    'already_captured',
    'backfill is idempotent and never overwrites a captured context'
);

select * from finish();

rollback;
