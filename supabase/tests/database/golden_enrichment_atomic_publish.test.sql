begin;

select plan(8);

select ok(
    to_regprocedure(
        'public.publish_golden_event_card_article_overview(jsonb,integer,uuid,timestamp with time zone,text,text,text,integer,integer,text[],uuid[])'
    ) is not null,
    'atomic article-overview publisher exists'
);

select ok(
    has_function_privilege(
        'service_role',
        'public.publish_golden_event_card_article_overview(jsonb,integer,uuid,timestamp with time zone,text,text,text,integer,integer,text[],uuid[])',
        'execute'
    )
    and not has_function_privilege(
        'authenticated',
        'public.publish_golden_event_card_article_overview(jsonb,integer,uuid,timestamp with time zone,text,text,text,integer,integer,text[],uuid[])',
        'execute'
    ),
    'only the service role can invoke the atomic publisher'
);

select lives_ok(
    $$select public.publish_golden_event_card_article_overview(
        '{"summary":{"text":"Initial","sourceEntryIds":["00000000-0000-4000-8000-00000000f712"]},"keyPoints":[]}'::jsonb,
        1,
        '00000000-0000-4000-8000-00000000f711'::uuid,
        '2026-07-20T02:00:00Z'::timestamptz,
        repeat('61', 32),
        'content-model-v1',
        repeat('71', 32),
        1,
        4,
        array[repeat('81', 32), repeat('82', 32)],
        array[
            '00000000-0000-4000-8000-00000000f712'::uuid,
            '00000000-0000-4000-8000-00000000f713'::uuid
        ]
    )$$,
    'atomic publisher inserts a new overview'
);

select ok(
    (
        select created_at = updated_at
        from public.golden_event_card_article_overviews
        where event_card_id = '00000000-0000-4000-8000-00000000f711'
    ),
    'the server owns consistent timestamps for a new row'
);

select lives_ok(
    $$select public.publish_golden_event_card_article_overview(
        '{"summary":{"text":"Upgraded","sourceEntryIds":["00000000-0000-4000-8000-00000000f712"]},"keyPoints":[{"text":"Point one","sourceEntryIds":["00000000-0000-4000-8000-00000000f712"]},{"text":"Point two","sourceEntryIds":["00000000-0000-4000-8000-00000000f713"]}]}'::jsonb,
        2,
        '00000000-0000-4000-8000-00000000f711'::uuid,
        '2026-07-20T03:00:00Z'::timestamptz,
        repeat('61', 32),
        'content-model-v2',
        repeat('72', 32),
        2,
        4,
        array[repeat('81', 32), repeat('82', 32)],
        array[
            '00000000-0000-4000-8000-00000000f712'::uuid,
            '00000000-0000-4000-8000-00000000f713'::uuid
        ]
    )$$,
    'atomic publisher upgrades a matching older version'
);

select is(
    (
        select concat_ws(
            '|',
            enrichment_version,
            source_entry_ids[1],
            source_content_hashes[1],
            source_entry_ids[2],
            source_content_hashes[2]
        )
        from public.golden_event_card_article_overviews
        where event_card_id = '00000000-0000-4000-8000-00000000f711'
    ),
    concat_ws(
        '|',
        2,
        '00000000-0000-4000-8000-00000000f712',
        repeat('81', 32),
        '00000000-0000-4000-8000-00000000f713',
        repeat('82', 32)
    ),
    'source IDs and hashes retain their positional provenance'
);

select throws_ok(
    $$select public.publish_golden_event_card_article_overview(
        '{"summary":{"text":"Same-version rewrite"},"keyPoints":[]}'::jsonb,
        2,
        '00000000-0000-4000-8000-00000000f711'::uuid,
        now(),
        repeat('61', 32),
        'content-model-v2',
        repeat('72', 32),
        2,
        4,
        array[repeat('81', 32), repeat('82', 32)],
        array[
            '00000000-0000-4000-8000-00000000f712'::uuid,
            '00000000-0000-4000-8000-00000000f713'::uuid
        ]
    )$$,
    'P0001',
    'article overview version is immutable for card 00000000-0000-4000-8000-00000000f711',
    'same-version rewrites are rejected'
);

select throws_ok(
    $$select public.publish_golden_event_card_article_overview(
        '{"summary":{"text":"Wrong source snapshot"},"keyPoints":[]}'::jsonb,
        3,
        '00000000-0000-4000-8000-00000000f711'::uuid,
        now(),
        repeat('62', 32),
        'content-model-v3',
        repeat('73', 32),
        3,
        4,
        array[repeat('81', 32), repeat('82', 32)],
        array[
            '00000000-0000-4000-8000-00000000f712'::uuid,
            '00000000-0000-4000-8000-00000000f713'::uuid
        ]
    )$$,
    'P0001',
    'article overview input hash conflict for card 00000000-0000-4000-8000-00000000f711',
    'source-snapshot changes cannot overwrite a card row'
);

select * from finish();

rollback;
