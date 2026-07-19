begin;

-- Review decision (Vincent, 2026-07-19): golden is a PERFECT RENDITION of
-- the QAed production surface, not just entry labels. A reader must be able
-- to rebuild the dashboard view (storylines, episodes, event cards with
-- rank_key, themes, categories) from golden_* tables alone. Tables are
-- LIKE-copies of the live tables (defaults + check constraints, no FKs into
-- the disposable live tables — the golden namespace is self-contained).
-- NOTE: future schema migrations on a mirrored live table must alter its
-- golden twin in the same migration, or the mirror copy breaks.

create table public.golden_topic_categories
    (like public.topic_categories including defaults including constraints);
alter table public.golden_topic_categories add primary key (id);

create table public.golden_topic_themes
    (like public.topic_themes including defaults including constraints);
alter table public.golden_topic_themes add primary key (id);

create table public.golden_storylines
    (like public.storylines including defaults including constraints);
alter table public.golden_storylines add primary key (id);

create table public.golden_episodes
    (like public.episodes including defaults including constraints);
alter table public.golden_episodes add primary key (id);
create index golden_episodes_storyline_idx
    on public.golden_episodes (storyline_id);

create table public.golden_event_cards
    (like public.event_cards including defaults including constraints);
alter table public.golden_event_cards add primary key (id);
create index golden_event_cards_storyline_idx
    on public.golden_event_cards (storyline_id);

-- The golden namespace is self-contained: entry labels no longer FK into
-- the live taxonomy (whose ids differ between local and hosted); category
-- names render from golden_topic_categories instead.
alter table public.golden_news_entries
    drop constraint golden_news_entries_gold_category_id_fkey;

alter table public.golden_topic_categories enable row level security;
alter table public.golden_topic_themes enable row level security;
alter table public.golden_storylines enable row level security;
alter table public.golden_episodes enable row level security;
alter table public.golden_event_cards enable row level security;

revoke all privileges on table
    public.golden_topic_categories, public.golden_topic_themes,
    public.golden_storylines, public.golden_episodes,
    public.golden_event_cards
    from public, anon, authenticated, service_role;
grant select, insert, update, delete on table
    public.golden_topic_categories, public.golden_topic_themes,
    public.golden_storylines, public.golden_episodes,
    public.golden_event_cards
    to service_role;
grant insert, update, delete on table public.golden_news_entries
    to service_role;

commit;
