begin;

select plan(17);

select has_table(
    'public', 'golden_event_card_thumbnails',
    'golden event-card thumbnails table exists'
);

select has_table(
    'public', 'golden_event_card_article_overviews',
    'golden event-card article overviews table exists'
);

select is(
    (
        select count(*)
        from pg_catalog.pg_constraint
        where conrelid = 'public.golden_event_card_thumbnails'::regclass
          and contype = 'f'
    ),
    0::bigint,
    'thumbnail card identity intentionally has no foreign key'
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
          and tablename = 'golden_event_card_thumbnails'
          and indexdef like '%(input_hash, enrichment_version)%'
    )
    and exists (
        select 1
        from pg_catalog.pg_indexes
        where schemaname = 'public'
          and tablename = 'golden_event_card_article_overviews'
          and indexdef like '%(input_hash, enrichment_version)%'
    ),
    'both serving tables index their idempotency provenance'
);

select ok(
    (
        select relrowsecurity
        from pg_catalog.pg_class relations
        join pg_catalog.pg_namespace namespaces
          on namespaces.oid = relations.relnamespace
        where namespaces.nspname = 'public'
          and relations.relname = 'golden_event_card_thumbnails'
    ),
    'thumbnail RLS is enabled'
);

select ok(
    (
        select relrowsecurity
        from pg_catalog.pg_class relations
        join pg_catalog.pg_namespace namespaces
          on namespaces.oid = relations.relnamespace
        where namespaces.nspname = 'public'
          and relations.relname = 'golden_event_card_article_overviews'
    ),
    'article-overview RLS is enabled'
);

select ok(
    has_table_privilege('service_role', 'public.golden_event_card_thumbnails', 'select')
    and has_table_privilege('service_role', 'public.golden_event_card_thumbnails', 'insert')
    and has_table_privilege('service_role', 'public.golden_event_card_thumbnails', 'update')
    and not has_table_privilege('service_role', 'public.golden_event_card_thumbnails', 'delete'),
    'service role can read and write, but not delete, thumbnails'
);

select ok(
    has_table_privilege('service_role', 'public.golden_event_card_article_overviews', 'select')
    and has_table_privilege('service_role', 'public.golden_event_card_article_overviews', 'insert')
    and has_table_privilege('service_role', 'public.golden_event_card_article_overviews', 'update')
    and not has_table_privilege('service_role', 'public.golden_event_card_article_overviews', 'delete'),
    'service role can read and write, but not delete, article overviews'
);

select ok(
    not has_table_privilege('anon', 'public.golden_event_card_thumbnails', 'select')
    and not has_table_privilege('authenticated', 'public.golden_event_card_thumbnails', 'select')
    and not has_table_privilege('anon', 'public.golden_event_card_article_overviews', 'select')
    and not has_table_privilege('authenticated', 'public.golden_event_card_article_overviews', 'select'),
    'client roles cannot read golden enrichment'
);

select lives_ok(
    $$insert into public.golden_event_card_thumbnails (
          event_card_id, input_hash, enrichment_version, source_card_version,
          source_entry_ids, image_concept,
          r2_master_key, r2_card_key, r2_social_key,
          master_sha256, card_sha256, social_sha256,
          master_mime_type, card_mime_type, social_mime_type,
          master_width, master_height, card_width, card_height,
          social_width, social_height, alt_text, focal_x, focal_y,
          model, prompt_version, prompt_hash, generated_at
      ) values (
          '00000000-0000-4000-8000-00000000f601', repeat('11', 32), 1, 3,
          array['00000000-0000-4000-8000-00000000f602'::uuid],
          '{"subject":"Layered public records","metaphor":"A precise civic diagram"}'::jsonb,
          'golden/f601/master.png', 'golden/f601/card.webp', 'golden/f601/social.webp',
          repeat('21', 32), repeat('22', 32), repeat('23', 32),
          'image/png', 'image/webp', 'image/webp',
          1536, 1024, 1200, 675, 1200, 630,
          'Geometric paper records arranged around a precise civic diagram.',
          0.5, 0.5, 'image-model', 1, repeat('31', 32), now()
      )$$,
    'a complete thumbnail artifact inserts without a golden-card FK'
);

select throws_ok(
    $$insert into public.golden_event_card_thumbnails (
          event_card_id, input_hash, enrichment_version, source_card_version,
          source_entry_ids, image_concept,
          r2_master_key, r2_card_key, r2_social_key,
          master_sha256, card_sha256, social_sha256,
          master_mime_type, card_mime_type, social_mime_type,
          master_width, master_height, card_width, card_height,
          social_width, social_height, alt_text, focal_x, focal_y,
          model, prompt_version, prompt_hash, generated_at
      ) values (
          '00000000-0000-4000-8000-00000000f603', repeat('12', 32), 1, 3,
          array['00000000-0000-4000-8000-00000000f602'::uuid], '{}'::jsonb,
          'master', 'card', 'social', repeat('21', 32), repeat('22', 32), repeat('23', 32),
          'image/png', 'image/webp', 'image/webp', 1536, 1024, 1200, 675, 1200, 630,
          'Bad focal point', 1.1, 0.5, 'image-model', 1, repeat('31', 32), now()
      )$$,
    '23514', null,
    'thumbnail focal points are normalized'
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
    'a structured article overview inserts without a golden-card FK'
);

select throws_ok(
    $$insert into public.golden_event_card_article_overviews (
          event_card_id, input_hash, enrichment_version, source_card_version,
          source_entry_ids, source_content_hashes, article_overview,
          model, prompt_version, prompt_hash, generated_at
      ) values (
          '00000000-0000-4000-8000-00000000f604', repeat('42', 32), 1, 3,
          array['00000000-0000-4000-8000-00000000f602'::uuid],
          array[repeat('ab', 32), repeat('cd', 32)], '{}'::jsonb,
          'content-model', 1, repeat('52', 32), now()
      )$$,
    '23514', null,
    'source IDs and source content versions remain positionally aligned'
);

select throws_ok(
    $$insert into public.golden_event_card_article_overviews (
          event_card_id, input_hash, enrichment_version, source_card_version,
          source_entry_ids, source_content_hashes, article_overview,
          model, prompt_version, prompt_hash, generated_at
      ) values (
          '00000000-0000-4000-8000-00000000f605', repeat('43', 32), 1, 3,
          array['00000000-0000-4000-8000-00000000f602'::uuid],
          array['not-a-content-hash'], '{}'::jsonb,
          'content-model', 1, repeat('53', 32), now()
      )$$,
    '23514', null,
    'source content versions must be sha256 hashes'
);

select lives_ok(
    $$update public.golden_event_card_thumbnails
      set r2_card_key = 'golden/f601/card-v2.webp',
          enrichment_version = 2,
          updated_at = now()
      where event_card_id = '00000000-0000-4000-8000-00000000f601'$$,
    'service writers can replace a card-scoped thumbnail with a newer enrichment version'
);

select lives_ok(
    $$update public.golden_event_card_article_overviews
      set enrichment_version = 2,
          article_overview = '{"lead":"A regenerated source-grounded overview.","key_details":[]}'::jsonb,
          updated_at = now()
      where event_card_id = '00000000-0000-4000-8000-00000000f601'$$,
    'service writers can replace a card-scoped overview with a newer enrichment version'
);

select * from finish();

rollback;
