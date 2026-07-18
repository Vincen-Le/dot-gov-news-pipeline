begin;

select plan(9);

select has_table('public', 'event_cards', 'event_cards table exists');

select ok(
    (
        select relrowsecurity
        from pg_catalog.pg_class
        join pg_catalog.pg_namespace
          on pg_namespace.oid = pg_class.relnamespace
        where pg_namespace.nspname = 'public'
          and pg_class.relname = 'event_cards'
    ),
    'RLS enabled on event_cards'
);

select ok(
    exists (
        select 1
        from pg_catalog.pg_constraint
        where conname = 'storylines_latest_card_fk'
          and contype = 'f'
    ),
    'storylines.latest_card_id FK now closes the loop'
);

-- fixtures
insert into public.storylines (id, first_entry_at, newest_entry_at)
values ('00000000-0000-0000-0000-000000000052', now(), now());
insert into public.episodes
    (id, storyline_id, first_entry_at, newest_entry_at, attach_method)
values
    ('00000000-0000-0000-0000-0000000000e2',
     '00000000-0000-0000-0000-000000000052',
     now(), now(), 'new_storyline');

select lives_ok(
    $$insert into public.event_cards
        (storyline_id, kind, version, headline, summary, newest_entry_at, rank_key)
      values
        ('00000000-0000-0000-0000-000000000052', 'overview', 1,
         'Valsatrex recall widens', 'FDA expanded the recall.', now(), 12.5)$$,
    'overview card without episode_id inserts'
);

select throws_ok(
    $$insert into public.event_cards
        (storyline_id, kind, version, headline, summary, newest_entry_at, rank_key)
      values
        ('00000000-0000-0000-0000-000000000052', 'episode', 1,
         'Recall announced', 'Initial pulse.', now(), 11.0)$$,
    '23514',
    null,
    'episode card without episode_id rejected'
);

select throws_ok(
    $$insert into public.event_cards
        (storyline_id, episode_id, kind, version, headline, summary, newest_entry_at, rank_key)
      values
        ('00000000-0000-0000-0000-000000000052',
         '00000000-0000-0000-0000-0000000000e2', 'overview', 2,
         'Bad', 'Overview cards must not carry episode_id.', now(), 11.0)$$,
    '23514',
    null,
    'overview card with episode_id rejected'
);

insert into public.event_cards
    (storyline_id, episode_id, kind, version, headline, summary, newest_entry_at, rank_key)
values
    ('00000000-0000-0000-0000-000000000052',
     '00000000-0000-0000-0000-0000000000e2', 'episode', 1,
     'Recall announced', 'Initial pulse.', now(), 11.0);

select throws_ok(
    $$insert into public.event_cards
        (storyline_id, episode_id, kind, version, headline, summary, newest_entry_at, rank_key)
      values
        ('00000000-0000-0000-0000-000000000052',
         '00000000-0000-0000-0000-0000000000e2', 'episode', 2,
         'Dup', 'Episode cards are 1:1 with episodes.', now(), 11.0)$$,
    '23505',
    null,
    'second card for one episode rejected (1:1 invariant)'
);

select throws_ok(
    $$insert into public.event_cards
        (storyline_id, kind, version, headline, summary, newest_entry_at, rank_key)
      values
        ('00000000-0000-0000-0000-000000000052', 'teaser', 1,
         'Bad kind', 'x', now(), 1.0)$$,
    '23514',
    null,
    'invalid kind rejected'
);

select ok(
    exists (
        select 1 from pg_catalog.pg_indexes
        where schemaname = 'public' and tablename = 'event_cards'
          and indexdef like '%rank_key DESC%'
          and indexdef like '%superseded_by IS NULL%'
    ),
    'partial serving index on rank_key exists'
);

select * from finish();

rollback;
