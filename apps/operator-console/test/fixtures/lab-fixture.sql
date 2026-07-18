-- Deterministic clustering + run-history state for LabQueries integration tests.
-- Applied inside a transaction by the test; never committed to the DB.
insert into public.news_sources (id, canonical_url, source_type, title) values
  ('00000000-0000-4000-8000-000000000001', 'https://fda.gov/press.xml', 'rss', 'FDA Press'),
  ('00000000-0000-4000-8000-000000000002', 'https://hhs.gov/news.xml', 'rss', 'HHS News');

-- fp16 embeddings: '\x003c003c' = [1,1]; '\x003c0000' = [1,0]
insert into public.news_entries
  (id, news_source_id, url, url_canonical, title, summary, published_at, content_hash,
   embedding, embedding_model, entity_set, event_keys, extractor_version) values
  ('00000000-0000-4000-8000-000000000011', '00000000-0000-4000-8000-000000000001',
   'https://fda.gov/a', 'https://fda.gov/a', 'FDA recalls Valsatrex', 'Sundexo recall.',
   '2026-05-14T14:00:00Z', repeat('ab', 32), '\x003c003c', 'stub', array['valsatrex'], array['z-2026-0143'], 1),
  ('00000000-0000-4000-8000-000000000012', '00000000-0000-4000-8000-000000000002',
   'https://hhs.gov/b', 'https://hhs.gov/b', 'HHS on Valsatrex', 'Sundexo recall.',
   '2026-05-14T16:00:00Z', repeat('ab', 32), '\x003c003c', 'stub', array['valsatrex'], '{}', 1),
  ('00000000-0000-4000-8000-000000000013', '00000000-0000-4000-8000-000000000001',
   'https://fda.gov/c', 'https://fda.gov/c', 'FDA expands Valsatrex recall', 'All lots.',
   '2026-05-17T15:00:00Z', repeat('cd', 32), '\x003c0000', 'stub', array['valsatrex'], array['z-2026-0143'], 1),
  ('00000000-0000-4000-8000-000000000014', '00000000-0000-4000-8000-000000000001',
   'https://fda.gov/d', 'https://fda.gov/d', 'SSA opens field office', 'Tulsa office.',
   '2026-05-18T09:00:00Z', repeat('ef', 32), null, null, array['tulsa'], '{}', 1);

insert into public.storylines
  (id, entity_set, event_keys, agency_ids, distinct_feeds, entry_count, episode_count,
   first_entry_at, newest_entry_at) values
  ('00000000-0000-4000-8000-000000000021', array['valsatrex'], array['z-2026-0143'],
   array['fda.gov', 'hhs.gov'], 2, 3, 2, '2026-05-14T14:00:00Z', '2026-05-17T15:00:00Z'),
  ('00000000-0000-4000-8000-000000000022', array['tulsa'], '{}', array['fda.gov'], 1, 1, 1,
   '2026-05-18T09:00:00Z', '2026-05-18T09:00:00Z');

insert into public.episodes
  (id, storyline_id, status, entity_set, event_keys, entry_count,
   first_entry_at, newest_entry_at, attach_method, attach_similarity, attach_reason) values
  ('00000000-0000-4000-8000-000000000031', '00000000-0000-4000-8000-000000000021', 'dormant',
   array['valsatrex'], array['z-2026-0143'], 2, '2026-05-14T14:00:00Z', '2026-05-14T16:00:00Z',
   'new_storyline', null, null),
  ('00000000-0000-4000-8000-000000000032', '00000000-0000-4000-8000-000000000021', 'dormant',
   array['valsatrex'], array['z-2026-0143'], 1, '2026-05-17T15:00:00Z', '2026-05-17T15:00:00Z',
   'event_key', 0.82, 'shared recall number'),
  ('00000000-0000-4000-8000-000000000033', '00000000-0000-4000-8000-000000000022', 'open',
   array['tulsa'], '{}', 1, '2026-05-18T09:00:00Z', '2026-05-18T09:00:00Z',
   'new_storyline', null, null);

insert into public.episode_entries
  (episode_id, entry_id, is_syndicated, attach_method, similarity, matched_entry_id,
   threshold_used, embedding_model) values
  ('00000000-0000-4000-8000-000000000031', '00000000-0000-4000-8000-000000000011',
   false, 'new_cluster', null, null, null, 'stub'),
  ('00000000-0000-4000-8000-000000000031', '00000000-0000-4000-8000-000000000012',
   true, 'content_hash', 0.91, '00000000-0000-4000-8000-000000000011', 0.90, 'stub'),
  ('00000000-0000-4000-8000-000000000032', '00000000-0000-4000-8000-000000000013',
   false, 'near_dup', 0.915, '00000000-0000-4000-8000-000000000011', 0.90, 'stub'),
  ('00000000-0000-4000-8000-000000000033', '00000000-0000-4000-8000-000000000014',
   false, 'new_cluster', null, null, null, 'stub');

update public.news_entries set episode_id = '00000000-0000-4000-8000-000000000031'
  where id in ('00000000-0000-4000-8000-000000000011', '00000000-0000-4000-8000-000000000012');
update public.news_entries set episode_id = '00000000-0000-4000-8000-000000000032'
  where id = '00000000-0000-4000-8000-000000000013';
update public.news_entries set episode_id = '00000000-0000-4000-8000-000000000033'
  where id = '00000000-0000-4000-8000-000000000014';

insert into public.event_cards
  (id, storyline_id, episode_id, kind, version, headline, summary, timeline,
   newest_entry_at, rank_key, superseded_by, judge_model) values
  ('00000000-0000-4000-8000-000000000041', '00000000-0000-4000-8000-000000000021',
   '00000000-0000-4000-8000-000000000031', 'episode', 1, 'FDA recalls Valsatrex',
   'Recall pulse.', null, '2026-05-14T16:00:00Z', 4.1, null, 'stub'),
  ('00000000-0000-4000-8000-000000000042', '00000000-0000-4000-8000-000000000021',
   '00000000-0000-4000-8000-000000000032', 'episode', 1, 'FDA expands Valsatrex recall',
   'Expansion pulse.', null, '2026-05-17T15:00:00Z', 4.3, null, 'stub'),
  ('00000000-0000-4000-8000-000000000043', '00000000-0000-4000-8000-000000000021',
   null, 'overview', 1, 'Valsatrex recall', 'First cut.',
   '[{"episode_id": "00000000-0000-4000-8000-000000000031", "date": "2026-05-14", "text": "Recall announced"}]',
   '2026-05-14T16:00:00Z', 4.5, '00000000-0000-4000-8000-000000000044', 'stub'),
  ('00000000-0000-4000-8000-000000000044', '00000000-0000-4000-8000-000000000021',
   null, 'overview', 2, 'Valsatrex recall chain', 'Recall then expansion.',
   '[{"episode_id": "00000000-0000-4000-8000-000000000031", "date": "2026-05-14", "text": "Recall announced"},
     {"episode_id": "00000000-0000-4000-8000-000000000032", "date": "2026-05-17", "text": "Recall expanded"},
     {"episode_id": "99999999-9999-4999-8999-999999999999", "date": "2026-05-18", "text": "Uncited claim"}]',
   '2026-05-17T15:00:00Z', 5.2, null, 'stub');

update public.storylines set latest_card_id = '00000000-0000-4000-8000-000000000044'
  where id = '00000000-0000-4000-8000-000000000021';

insert into public.experiment_runs
  (id, name, started_at, finished_at, config, cluster_report, summary,
   cache_hits, cache_misses, created_at) values
  ('00000000-0000-4000-8000-0000000000a1', 'baseline',
   '2026-07-18T10:00:00Z', '2026-07-18T10:00:42Z',
   '{"near_dup_threshold": 0.9, "enrichment_enabled": true}',
   '{"processed": 4, "episodes_closed": 3}',
   '{"entries_clustered": 4, "episodes": 3, "storylines": 2, "cards": 4,
     "entry_attach_mix": {"new_cluster": 2, "content_hash": 1, "near_dup": 1},
     "episode_attach_mix": {"new_storyline": 2, "event_key": 1},
     "singleton_episode_rate": 0.667, "multi_episode_storylines": 1,
     "top_chains": [{"episodes": 2, "headline": "Valsatrex recall chain"}]}',
   0, 2, '2026-07-18T10:00:43Z'),
  ('00000000-0000-4000-8000-0000000000a2', 'near-dup-0.87',
   '2026-07-18T11:00:00Z', '2026-07-18T11:00:21Z',
   '{"near_dup_threshold": 0.87, "enrichment_enabled": true}',
   '{"processed": 4, "episodes_closed": 3}',
   '{"entries_clustered": 4, "episodes": 3, "storylines": 2, "cards": 4,
     "entry_attach_mix": {"new_cluster": 2, "content_hash": 1, "near_dup": 1},
     "episode_attach_mix": {"new_storyline": 2, "event_key": 1},
     "singleton_episode_rate": 0.667, "multi_episode_storylines": 1,
     "top_chains": [{"episodes": 2, "headline": "Valsatrex recall chain"}]}',
   2, 0, '2026-07-18T11:00:22Z');
