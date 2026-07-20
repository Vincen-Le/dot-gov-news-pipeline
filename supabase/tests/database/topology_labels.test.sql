begin;

select plan(20);

select has_table(
    'public', 'topology_label_sets',
    'topology_label_sets table exists'
);
select has_table(
    'public', 'news_entry_topology_labels',
    'news_entry_topology_labels table exists'
);

select ok(
    (
        select count(*) = 2
        from pg_catalog.pg_class relations
        join pg_catalog.pg_namespace namespaces
          on namespaces.oid = relations.relnamespace
        where namespaces.nspname = 'public'
          and relations.relname in (
              'topology_label_sets',
              'news_entry_topology_labels'
          )
          and relations.relrowsecurity
    ),
    'RLS is enabled on both topology tables'
);

select ok(
    not has_table_privilege('anon', 'public.topology_label_sets', 'select')
    and not has_table_privilege(
        'authenticated', 'public.news_entry_topology_labels', 'select')
    and has_table_privilege(
        'service_role', 'public.news_entry_topology_labels', 'select')
    and not has_table_privilege(
        'service_role', 'public.news_entry_topology_labels', 'insert'),
    'service role reads labels only; client roles have no table access'
);

select ok(
    has_function_privilege(
        'service_role',
        'public.begin_topology_label_set(text,text,integer,jsonb)',
        'execute'
    )
    and not has_function_privilege(
        'anon',
        'public.begin_topology_label_set(text,text,integer,jsonb)',
        'execute'
    ),
    'topology write RPCs are service-only'
);

insert into public.news_sources (id, canonical_url, source_type)
values (
    '00000000-0000-4000-8000-00000000f301',
    'https://topology-labels.example.gov/feed.xml',
    'rss'
);

insert into public.news_entries (
    id, news_source_id, url, url_canonical, content_hash,
    title, published_at
)
select
    ('00000000-0000-4000-8000-' || lpad(sequence::text, 12, '0'))::uuid,
    '00000000-0000-4000-8000-00000000f301'::uuid,
    'https://topology-labels.example.gov/' || sequence,
    'https://topology-labels.example.gov/' || sequence,
    repeat(lpad(to_hex(sequence), 2, '0'), 32),
    'Topology fixture ' || sequence,
    timestamptz '2026-07-18 00:00:00+00'
        + make_interval(hours => sequence)
from generate_series(1, 10) as sequence;

create temp table topology_test_state (
    label_set_id uuid not null
) on commit drop;

insert into topology_test_state (label_set_id)
select public.begin_topology_label_set(
    'pgTAP topology fixture',
    'deterministic-test',
    1,
    '{"mode":"strict"}'::jsonb
);

select is(
    (
        select status
        from public.topology_label_sets
        where id = (select label_set_id from topology_test_state)
    ),
    'building',
    'new label sets begin in building state'
);

create temp table topology_test_payload (
    news_entry_id uuid not null,
    content_hash_at_labeling text not null,
    proposed_storyline_key text not null,
    proposed_episode_key text not null,
    storyline_entry_count integer not null,
    storyline_episode_count integer not null,
    episode_entry_count integer not null,
    category_confidence text,
    evidence jsonb not null
) on commit drop;

-- Four entries in one two-episode storyline; both episodes contain two entries.
insert into topology_test_payload
select
    ('00000000-0000-4000-8000-' || lpad(sequence::text, 12, '0'))::uuid,
    repeat(lpad(to_hex(sequence), 2, '0'), 32),
    'storyline:multi',
    case when sequence <= 2 then 'episode:multi:a' else 'episode:multi:b' end,
    4,
    2,
    2,
    'high',
    '{"fixture":true}'::jsonb
from generate_series(1, 4) as sequence;

-- Two entries in one single-episode storyline.
insert into topology_test_payload
select
    ('00000000-0000-4000-8000-' || lpad(sequence::text, 12, '0'))::uuid,
    repeat(lpad(to_hex(sequence), 2, '0'), 32),
    'storyline:same-episode',
    'episode:same-episode',
    2,
    1,
    2,
    'high',
    '{"fixture":true}'::jsonb
from generate_series(5, 6) as sequence;

-- Four singleton episode/storylines.
insert into topology_test_payload
select
    ('00000000-0000-4000-8000-' || lpad(sequence::text, 12, '0'))::uuid,
    repeat(lpad(to_hex(sequence), 2, '0'), 32),
    'storyline:singleton:' || sequence,
    'episode:singleton:' || sequence,
    1,
    1,
    1,
    'medium',
    '{"fixture":true}'::jsonb
from generate_series(7, 10) as sequence;

select is(
    public.upsert_news_entry_topology_labels(
        (select label_set_id from topology_test_state),
        (
            select jsonb_agg(to_jsonb(payload))
            from topology_test_payload payload
        )
    ),
    10,
    'bulk label RPC writes the complete payload'
);

select is(
    (
        select count(*)::integer
        from public.news_entry_topology_labels
        where label_set_id = (select label_set_id from topology_test_state)
          and topology_class = 'multi_episode_storyline'
    ),
    4,
    'multi-episode topology class is generated from counts'
);

select is(
    (
        select count(*)::integer
        from public.news_entry_topology_labels
        where label_set_id = (select label_set_id from topology_test_state)
          and is_multi_entry_episode
    ),
    6,
    'multi-entry episode flag remains orthogonal to storyline class'
);

select is(
    public.complete_topology_label_set(
        (select label_set_id from topology_test_state),
        10
    ),
    10,
    'a count-consistent label set completes'
);

select is(
    (
        select status
        from public.topology_label_sets
        where id = (select label_set_id from topology_test_state)
    ),
    'complete',
    'completion publishes the label set for curation'
);

select throws_ok(
    format(
        'select public.upsert_news_entry_topology_labels(%L::uuid, %L::jsonb)',
        (select label_set_id from topology_test_state),
        '[{"news_entry_id":"00000000-0000-4000-8000-000000000001"}]'
    ),
    'P0001',
    null,
    'completed label sets are immutable through the write RPC'
);

select is(
    (
        select count(*)::integer
        from public.curate_news_entry_dataset_by_storyline_topology(
            (select label_set_id from topology_test_state),
            10,
            40,
            20,
            'fixture-seed'
        )
    ),
    10,
    'curation returns the requested exact dataset size'
);

select is(
    (
        select count(*)::integer
        from public.curate_news_entry_dataset_by_storyline_topology(
            (select label_set_id from topology_test_state),
            10,
            40,
            20,
            'fixture-seed'
        )
        where topology_class = 'multi_episode_storyline'
    ),
    4,
    'curation can target 40 percent multi-episode entries'
);

select is(
    (
        select count(*)::integer
        from public.curate_news_entry_dataset_by_storyline_topology(
            (select label_set_id from topology_test_state),
            10,
            40,
            20,
            'fixture-seed'
        )
        where topology_class = 'multi_entry_single_episode'
    ),
    2,
    'curation independently targets multi-entry single-episode entries'
);

select is(
    (
        select count(distinct proposed_storyline_key)::integer
        from public.curate_news_entry_dataset_by_storyline_topology(
            (select label_set_id from topology_test_state),
            10,
            40,
            20,
            'fixture-seed'
        )
        where topology_class = 'multi_episode_storyline'
    ),
    1,
    'curation keeps selected multi-episode storylines intact'
);

select is(
    (
        select array_agg(news_entry_id order by news_entry_id)
        from public.curate_news_entry_dataset_by_storyline_topology(
            (select label_set_id from topology_test_state),
            10,
            40,
            20,
            'fixture-seed'
        )
    ),
    (
        select array_agg(news_entry_id order by news_entry_id)
        from public.curate_news_entry_dataset_by_storyline_topology(
            (select label_set_id from topology_test_state),
            10,
            40,
            20,
            'fixture-seed'
        )
    ),
    'the same seed produces the same curated dataset'
);

select throws_ok(
    format(
        'select * from public.curate_news_entry_dataset_by_storyline_topology(%L::uuid, 10, 80, 30)',
        (select label_set_id from topology_test_state)
    ),
    'P0001',
    null,
    'curation rejects percentages totaling more than 100'
);

select throws_ok(
    $$insert into public.news_entry_topology_labels (
          label_set_id, news_entry_id, proposed_storyline_key,
          proposed_episode_key, content_hash_at_labeling, storyline_entry_count,
          storyline_episode_count, episode_entry_count
      ) values (
          (select label_set_id from topology_test_state),
          '00000000-0000-4000-8000-000000000010',
          'invalid', 'invalid', repeat('10', 32), 2, 1, 1
      )$$,
    '23514',
    null,
    'single-episode count inconsistencies are rejected at the table boundary'
);

update public.news_entries
set content_hash = repeat('ff', 32)
where id = '00000000-0000-4000-8000-000000000001';

select throws_ok(
    format(
        'select * from public.curate_news_entry_dataset_by_storyline_topology(%L::uuid, 10, 40, 20, %L)',
        (select label_set_id from topology_test_state),
        'stale-label-check'
    ),
    'P0001',
    null,
    'content changes make the complete labeled storyline ineligible'
);

select * from finish();

rollback;
