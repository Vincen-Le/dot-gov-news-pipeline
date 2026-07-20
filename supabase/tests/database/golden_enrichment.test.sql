begin;

select plan(23);

select has_table('public', 'images', 'shared images table exists');
select has_table(
    'public', 'golden_storyline_thumbnails',
    'golden storyline-thumbnail association exists'
);
select has_table(
    'public', 'golden_event_card_article_overviews',
    'golden event-card article overviews remain card scoped'
);
select has_view(
    'public', 'golden_event_card_thumbnails',
    'legacy card-thumbnail name is a compatibility view'
);

select hasnt_column(
    'public', 'storylines', 'image_id',
    'live storylines do not store an image foreign key'
);
select hasnt_column(
    'public', 'golden_storylines', 'image_id',
    'golden storylines do not store an image foreign key'
);

select is(
    (
        select count(*)
        from pg_catalog.pg_constraint
        where conrelid = 'public.golden_storyline_thumbnails'::regclass
          and contype = 'f'
    ),
    1::bigint,
    'storyline thumbnail association references only its image asset'
);
select is(
    (
        select count(*)
        from pg_catalog.pg_constraint
        where conrelid = 'public.golden_event_card_article_overviews'::regclass
          and contype = 'f'
    ),
    0::bigint,
    'article-overview card identity intentionally has no foreign key'
);

select ok(
    exists (
        select 1
        from pg_catalog.pg_indexes
        where schemaname = 'public'
          and tablename = 'images'
          and indexdef like '%(input_hash, enrichment_version)%'
    )
    and exists (
        select 1
        from pg_catalog.pg_indexes
        where schemaname = 'public'
          and tablename = 'golden_event_card_article_overviews'
          and indexdef like '%(input_hash, enrichment_version)%'
    ),
    'image and article provenance remain indexed'
);

select ok(
    (select relrowsecurity from pg_catalog.pg_class where oid = 'public.images'::regclass),
    'image RLS is enabled'
);
select ok(
    (
        select relrowsecurity
        from pg_catalog.pg_class
        where oid = 'public.golden_storyline_thumbnails'::regclass
    ),
    'storyline-thumbnail RLS is enabled'
);
select ok(
    (
        select relrowsecurity
        from pg_catalog.pg_class
        where oid = 'public.golden_event_card_article_overviews'::regclass
    ),
    'article-overview RLS is enabled'
);

select ok(
    has_table_privilege('service_role', 'public.images', 'select')
    and has_table_privilege('service_role', 'public.images', 'insert')
    and not has_table_privilege('service_role', 'public.images', 'update')
    and not has_table_privilege('service_role', 'public.images', 'delete'),
    'service role can insert immutable image assets without changing them'
);
select ok(
    has_table_privilege('service_role', 'public.golden_storyline_thumbnails', 'select')
    and has_table_privilege('service_role', 'public.golden_storyline_thumbnails', 'insert')
    and not has_table_privilege('service_role', 'public.golden_storyline_thumbnails', 'update')
    and not has_table_privilege('service_role', 'public.golden_storyline_thumbnails', 'delete'),
    'storyline thumbnail choices are insert-once for service writers'
);
select ok(
    has_table_privilege('service_role', 'public.golden_event_card_article_overviews', 'select')
    and has_table_privilege('service_role', 'public.golden_event_card_article_overviews', 'insert')
    and has_table_privilege('service_role', 'public.golden_event_card_article_overviews', 'update')
    and not has_table_privilege('service_role', 'public.golden_event_card_article_overviews', 'delete'),
    'article overviews retain their card-scoped service permissions'
);
select ok(
    has_table_privilege('service_role', 'public.golden_event_card_thumbnails', 'select')
    and not has_table_privilege('service_role', 'public.golden_event_card_thumbnails', 'insert'),
    'legacy card-thumbnail projection is read only'
);
select ok(
    not has_table_privilege('anon', 'public.images', 'select')
    and not has_table_privilege('authenticated', 'public.images', 'select')
    and not has_table_privilege('anon', 'public.golden_storyline_thumbnails', 'select')
    and not has_table_privilege('authenticated', 'public.golden_storyline_thumbnails', 'select')
    and not has_table_privilege('anon', 'public.golden_event_card_article_overviews', 'select')
    and not has_table_privilege('authenticated', 'public.golden_event_card_article_overviews', 'select'),
    'client roles cannot read golden enrichment assets'
);

select lives_ok(
    $$insert into public.images (
          id, input_hash, enrichment_version, source_card_version,
          source_entry_ids, image_concept,
          r2_master_key, r2_card_key, r2_social_key,
          master_sha256, card_sha256, social_sha256,
          master_mime_type, card_mime_type, social_mime_type,
          master_width, master_height, card_width, card_height,
          social_width, social_height, alt_text, focal_x, focal_y,
          model, prompt_version, prompt_hash, generated_at
      ) values (
          '00000000-0000-4000-8000-00000000f600',
          repeat('11', 32), 1, 3,
          array['00000000-0000-4000-8000-00000000f602'::uuid],
          '{"subject":"Layered public records","metaphor":"A precise civic diagram"}'::jsonb,
          'golden/f601/master.png', 'golden/f601/card.webp', 'golden/f601/social.webp',
          repeat('21', 32), repeat('22', 32), repeat('23', 32),
          'image/png', 'image/webp', 'image/webp',
          1536, 1024, 1200, 675, 1200, 630,
          'Geometric paper records arranged around a precise civic diagram.',
          0.5, 0.5, 'image-model', 1, repeat('31', 32), now()
      )$$,
    'a complete reusable image asset inserts'
);

select lives_ok(
    $$insert into public.golden_storyline_thumbnails (
          storyline_id, image_id, selection_source
      ) values (
          '00000000-0000-4000-8000-00000000f601',
          '00000000-0000-4000-8000-00000000f600',
          'generated'
      )$$,
    'a storyline selects one image without a storyline-table column'
);

select throws_ok(
    $$insert into public.golden_storyline_thumbnails (
          storyline_id, image_id, selection_source
      ) values (
          '00000000-0000-4000-8000-00000000f601',
          '00000000-0000-4000-8000-00000000f600',
          'generated'
      )$$,
    '23505', null,
    'a storyline cannot acquire a second thumbnail association'
);

select lives_ok(
    $$insert into public.golden_event_card_article_overviews (
          event_card_id, input_hash, enrichment_version, source_card_version,
          source_entry_ids, source_content_hashes, article_overview,
          model, prompt_version, prompt_hash, generated_at
      ) values (
          '00000000-0000-4000-8000-00000000f601', repeat('41', 32), 1, 3,
          array['00000000-0000-4000-8000-00000000f602'::uuid],
          array[repeat('ab', 32)],
          '{"lead":"The reviewed source establishes an agency action.","key_details":[]}'::jsonb,
          'content-model', 1, repeat('51', 32), now()
      )$$,
    'article synthesis remains independently card scoped'
);

select lives_ok(
    $$select public.publish_golden_storyline_thumbnail(
        jsonb_build_object(
            'input_hash', repeat('11', 32),
            'master_sha256', repeat('21', 32),
            'card_sha256', repeat('22', 32),
            'social_sha256', repeat('23', 32),
            'r2_master_key', 'golden/f601/master.png',
            'r2_card_key', 'golden/f601/card.webp',
            'r2_social_key', 'golden/f601/social.webp'
        ),
        '00000000-0000-4000-8000-00000000f601',
        'generated'
    )$$,
    'exact storyline-thumbnail retries are idempotent'
);

select throws_ok(
    $$select public.publish_golden_storyline_thumbnail(
        jsonb_build_object(
            'input_hash', repeat('11', 32),
            'master_sha256', repeat('ff', 32),
            'card_sha256', repeat('22', 32),
            'social_sha256', repeat('23', 32),
            'r2_master_key', 'golden/f601/master.png',
            'r2_card_key', 'golden/f601/card.webp',
            'r2_social_key', 'golden/f601/social.webp'
        ),
        '00000000-0000-4000-8000-00000000f601',
        'generated'
    )$$,
    'P0001', null,
    'a storyline thumbnail cannot be replaced with a different image'
);

select * from finish();

rollback;
