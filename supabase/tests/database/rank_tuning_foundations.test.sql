begin;

select plan(22);

select has_table('public', 'rank_system_versions', 'rank system catalog exists');
select has_table('public', 'rank_experiments', 'rank experiments exist');
select has_table('public', 'snapshot_rank_rows', 'immutable rank rows exist');
select has_table('public', 'rank_position_opinions', 'rank opinions exist');
select has_table('public', 'golden_rank_state', 'active rank singleton exists');
select has_view('public', 'golden_rank_rows', 'active rank view exists');

select is(
    (
        select version_number
        from public.rank_system_versions
        where id = '00000000-0000-4000-8000-00000000a001'
    ),
    1::bigint,
    'current rank system is seeded as v1'
);

select is(
    (
        select contract_hash
        from public.rank_system_versions
        where id = '00000000-0000-4000-8000-00000000a001'
    ),
    'sha256:871a8014438913574a0939b89c4c2d4e6b8a70a1cf38f908791f0bfcd77079f4',
    'database v1 contract matches the typed Python contract'
);

select throws_ok(
    $$
        update public.rank_system_versions
        set description = 'mutated'
        where id = '00000000-0000-4000-8000-00000000a001'
    $$,
    '55000',
    'rank system versions are immutable',
    'rank contracts cannot be updated'
);

insert into public.rank_experiments (
    id, rank_system_version_id, name, pipeline_namespace, source_run_id,
    status, config, config_hash, preprocessing_config, data_cutoff_at,
    data_snapshot_hash, context_set_hash, code_commit, started_at, finished_at,
    expected_row_count, cohort_card_ids, cohort_context_hashes
) values (
    '00000000-0000-4000-8000-00000000a101',
    '00000000-0000-4000-8000-00000000a001',
    'foundation test',
    'simple_v1',
    '00000000-0000-4000-8000-00000000a111',
    'calculated',
    '{"tau_seconds":124600}'::jsonb,
    'sha256:' || repeat('a', 64),
    '{}'::jsonb,
    '2026-05-14T14:00:00Z',
    'sha256:' || repeat('b', 64),
    'sha256:' || repeat('c', 64),
    'deadbeef',
    '2026-05-14T13:00:00Z',
    '2026-05-14T14:00:00Z',
    2,
    array[
        '00000000-0000-4000-8000-00000000a201'::uuid,
        '00000000-0000-4000-8000-00000000a202'::uuid
    ],
    array['md5:' || repeat('d', 32), 'md5:' || repeat('f', 32)]
);

select throws_ok(
    $$
        update public.rank_experiments
        set config = '{"tau_seconds":1}'::jsonb
        where id = '00000000-0000-4000-8000-00000000a101'
    $$,
    '55000',
    'rank experiment inputs and provenance are immutable',
    'experiment inputs cannot be retuned in place'
);

insert into public.snapshot_rank_rows (
    experiment_id, rank_system_version_id, golden_event_card_id,
    storyline_id, category_id, agency_ids, global_position,
    category_position, primary_rank_key, context_hash, rank_input,
    rank_input_hash, rank_terms, formula_trace, card_snapshot,
    context_snapshot
) values
    (
        '00000000-0000-4000-8000-00000000a101',
        '00000000-0000-4000-8000-00000000a001',
        '00000000-0000-4000-8000-00000000a201',
        '00000000-0000-4000-8000-00000000a211',
        '00000000-0000-4000-8000-00000000a221',
        array['fda'], 1, 1, 14001.0,
        'md5:' || repeat('d', 32),
        '{"tau_seconds":124600}'::jsonb,
        'sha256:' || repeat('e', 64),
        '{"rubric_points":1,"agency_term":0,"feed_term":0,"source_term":0,"freshness_term":14000}'::jsonb,
        '{"formula":"v1"}'::jsonb,
        '{"headline":"First"}'::jsonb,
        '{
            "episode_ids":[],
            "capture_method":"source_run_replay",
            "source_run_id":"00000000-0000-4000-8000-00000000a111"
        }'::jsonb
    ),
    (
        '00000000-0000-4000-8000-00000000a101',
        '00000000-0000-4000-8000-00000000a001',
        '00000000-0000-4000-8000-00000000a202',
        '00000000-0000-4000-8000-00000000a212',
        '00000000-0000-4000-8000-00000000a221',
        array['doj'], 2, 2, 14000.0,
        'md5:' || repeat('f', 32),
        '{"tau_seconds":124600}'::jsonb,
        'sha256:' || repeat('0', 64),
        '{"rubric_points":0,"agency_term":0,"feed_term":0,"source_term":0,"freshness_term":14000}'::jsonb,
        '{"formula":"v1"}'::jsonb,
        '{"headline":"Second"}'::jsonb,
        '{
            "episode_ids":[],
            "capture_method":"source_run_replay",
            "source_run_id":"00000000-0000-4000-8000-00000000a111"
        }'::jsonb
    );

select is(
    (
        select count(*)::integer
        from public.snapshot_rank_rows
        where experiment_id = '00000000-0000-4000-8000-00000000a101'
    ),
    2,
    'one canonical row per ranked storyline is stored'
);

select throws_ok(
    $$
        insert into public.snapshot_rank_rows (
            experiment_id, rank_system_version_id, golden_event_card_id,
            storyline_id, global_position, primary_rank_key, context_hash,
            card_snapshot
        ) values (
            '00000000-0000-4000-8000-00000000a101',
            '00000000-0000-4000-8000-00000000a001',
            '00000000-0000-4000-8000-00000000a203',
            '00000000-0000-4000-8000-00000000a211',
            3, 13999.0, 'legacy:test', '{"headline":"duplicate"}'::jsonb
        )
    $$,
    '23505',
    null,
    'an experiment cannot rank two cards for the same storyline cohort'
);

insert into public.rank_system_versions (
    id, name, formula_key, input_schema_version, term_schema_version,
    rubric_version, rubric_semantics_key, contract, contract_hash
) values (
    '00000000-0000-4000-8000-00000000a002',
    'test-v2', 'test_v2', 2, 2, 1, 'test_v2', '{}',
    'sha256:' || repeat('1', 64)
);

select throws_ok(
    $$
        insert into public.snapshot_rank_rows (
            experiment_id, rank_system_version_id, golden_event_card_id,
            storyline_id, global_position, primary_rank_key, context_hash,
            card_snapshot
        ) values (
            '00000000-0000-4000-8000-00000000a101',
            '00000000-0000-4000-8000-00000000a002',
            '00000000-0000-4000-8000-00000000a204',
            '00000000-0000-4000-8000-00000000a214',
            3, 13999.0, 'legacy:test', '{"headline":"wrong version"}'::jsonb
        )
    $$,
    '23503',
    null,
    'snapshot rows cannot claim a version different from their experiment'
);

select throws_ok(
    $$
        update public.snapshot_rank_rows
        set primary_rank_key = 0
        where golden_event_card_id = '00000000-0000-4000-8000-00000000a201'
    $$,
    '55000',
    'rank result rows are immutable',
    'rank rows cannot be updated'
);

insert into public.rank_position_opinions (
    experiment_id, rank_system_version_id, golden_event_card_id,
    category_id, current_category_position, suggested_category_position,
    position_delta, direction, status, reason, judge_model,
    prompt_version, input_hash
) values (
    '00000000-0000-4000-8000-00000000a101',
    '00000000-0000-4000-8000-00000000a001',
    '00000000-0000-4000-8000-00000000a201',
    '00000000-0000-4000-8000-00000000a221',
    1, 1, 0, 'stay', 'available', 'Correctly placed', 'test-judge', 1,
    'sha256:' || repeat('2', 64)
);

select lives_ok(
    $$
        insert into public.rank_position_opinions (
            experiment_id, rank_system_version_id, golden_event_card_id,
            category_id, current_category_position, suggested_category_position,
            position_delta, direction, status, reason
        ) values (
            '00000000-0000-4000-8000-00000000a101',
            '00000000-0000-4000-8000-00000000a001',
            '00000000-0000-4000-8000-00000000a202',
            '00000000-0000-4000-8000-00000000a221',
            2, null, -1, 'up', 'bounded', 'At least one position'
        )
    $$,
    'bounded opinions store a lower-bound movement without inventing a destination'
);

select ok(
    (public.validate_rank_experiment(
        '00000000-0000-4000-8000-00000000a101'
    ) ->> 'valid')::boolean,
    'complete experiment passes guarded validation'
);

select is(
    (
        public.promote_golden_rank(
            '00000000-0000-4000-8000-00000000a101',
            '00000000-0000-4000-8000-00000000a001',
            'pgtap'
        ) ->> 'rows'
    )::integer,
    2,
    'promotion revalidates and atomically selects the complete cohort'
);

select is(
    (select count(*)::integer from public.golden_rank_rows),
    2,
    'active view exposes the complete selected experiment'
);

select throws_ok(
    $$
        insert into public.golden_rank_state (
            id, active_experiment_id, active_rank_system_version_id
        ) values (
            'secondary',
            '00000000-0000-4000-8000-00000000a101',
            '00000000-0000-4000-8000-00000000a001'
        )
    $$,
    '23514',
    null,
    'singleton check makes a second state row impossible'
);

select ok(
    has_table_privilege('service_role', 'public.golden_rank_state', 'select')
    and not has_table_privilege('service_role', 'public.golden_rank_state', 'insert')
    and not has_table_privilege('service_role', 'public.golden_rank_state', 'update'),
    'service role cannot bypass the future promotion RPC by mutating active state'
);

insert into public.rank_experiments (
    id, rank_system_version_id, name, pipeline_namespace, status,
    config, config_hash
) values (
    '00000000-0000-4000-8000-00000000a102',
    '00000000-0000-4000-8000-00000000a001',
    'partial test', 'simple_v1', 'calculated', '{}',
    'sha256:' || repeat('3', 64)
);

select isnt(
    (public.validate_rank_experiment(
        '00000000-0000-4000-8000-00000000a102'
    ) ->> 'valid')::boolean,
    true,
    'partial experiment cannot claim validation'
);

select throws_ok(
    $$
        select public.promote_golden_rank(
            '00000000-0000-4000-8000-00000000a102',
            '00000000-0000-4000-8000-00000000a001',
            'pgtap'
        )
    $$,
    '23514',
    'rank experiment 00000000-0000-4000-8000-00000000a102 must be validated before promotion',
    'partial or rejected experiment cannot become active'
);

select * from finish();

rollback;
