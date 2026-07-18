# Clustering Data Model (Tables) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Create every Postgres table (with indexes, constraints, RLS, grants, and pgTAP tests) required by the v2 storyline/event-cards clustering design plus the granularity-hardening additions (hard event keys, entity stats).

**Architecture:** Five Supabase migrations, one per coherent table group, in FK-dependency order: `news_entries` → `entity_stats` → `storylines`/`episodes`/`episode_entries` → `event_cards` → `rubric_weights`. Tables only — attach RPCs, enrichment, and ranking functions are separate follow-up plans. Circular references (`storylines.latest_card_id` ↔ `event_cards.storyline_id`; `news_entries.episode_id` ↔ `episodes`) are resolved by adding the dependent column in the later migration.

**Tech Stack:** Supabase (Postgres 15+), pgTAP tests via `supabase test db`, migrations in `supabase/migrations/`.

**Specs this implements:** `docs/superpowers/specs/2026-07-18-storyline-event-cards-design.md` (schema section, lines 91–158) and the surviving audit-trail/junction model from `docs/superpowers/specs/2026-07-17-ranking-pipeline-design.md` (lines 205–262). Granularity additions (event_keys, entity_stats) from the 2026-07-18 X-clustering analysis discussion.

**Naming note:** both specs say `feed_entries` (and v1 says `news_items`); this plan uses **`news_entries`** to match the generalized `news_*` family established by `20260718000300_generalize_news_sources.sql` (`news_sources`, `news_source_fetch_state`). Update the spec name when v2 is next revised.

## Global Constraints

- Every migration: single `begin; … commit;` transaction, lowercase SQL, `public.` schema-qualified relations.
- Every table: `enable row level security`, then `revoke all privileges … from public, anon, authenticated, service_role`, then `grant select … to service_role`. Writes come later via `security definer` RPCs — **no insert/update/delete grants in this plan**. Serving-layer (anon) grants are explicitly out of scope.
- Enumerations are `text` + `check (… in (…))` constraints, never Postgres enums (house style; widening a check is easier than widening an enum).
- Every text column gets a bounded `length()` check; every array column gets `cardinality()` + `array_position(col, null) is null` checks; every count gets a nonnegative check.
- Every table and non-obvious column gets a `comment on`.
- Timestamps are `timestamptz`; defaults use `now()`.
- Test files live in `supabase/tests/database/<name>.test.sql`, pgTAP style: `begin;` → `select plan(N);` → assertions → `select * from finish();` → `rollback;`.
- Migration filenames continue the existing sequence: `20260718000400` onward.
- Run tests with: `pnpm supabase test db` (requires local stack: `pnpm supabase start`; apply migrations with `pnpm supabase db reset`).
- Commit after every green task. Commit messages end with `Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>`.

---

### Task 1: `news_entries` table

The atomic unit of the pipeline: one normalized feed item from a `news_sources` endpoint. Carries dedupe keys (`url_canonical`, `content_hash`), the embedding, enrichment output, and the two deterministic identity anchors (`entity_set`, `event_keys`).

**Files:**

- Create: `supabase/migrations/20260718000400_create_news_entries.sql`
- Test: `supabase/tests/database/news_entries.test.sql`

**Interfaces:**

- Consumes: `public.news_sources(id)` (exists, from `20260718000300_generalize_news_sources.sql`).
- Produces: `public.news_entries(id uuid PK)` — referenced by Task 3 (`episode_entries.entry_id`, `episode_entries.matched_entry_id`) and Task 4 (`event_cards.representative_entry_id`). Columns later tasks/RPCs rely on: `url_canonical text unique`, `content_hash text`, `entity_set text[]`, `event_keys text[]`, `embedding bytea`, `embedding_model text`, `enriched_text text`, `enricher_version int`, `published_at timestamptz`, `fetched_at timestamptz`. `episode_id` is **not** in this migration — Task 3 adds it.

- [ ] **Step 1: Write the failing test**

```sql
-- supabase/tests/database/news_entries.test.sql
begin;

select plan(10);

select has_table('public', 'news_entries', 'news_entries table exists');

select ok(
    (
        select relrowsecurity
        from pg_catalog.pg_class
        join pg_catalog.pg_namespace
          on pg_namespace.oid = pg_class.relnamespace
        where pg_namespace.nspname = 'public'
          and pg_class.relname = 'news_entries'
    ),
    'RLS enabled on news_entries'
);

select ok(
    not has_table_privilege('anon', 'public.news_entries', 'select')
    and not has_table_privilege('authenticated', 'public.news_entries', 'select'),
    'anon and authenticated cannot read news_entries'
);

select ok(
    has_table_privilege('service_role', 'public.news_entries', 'select')
    and not has_table_privilege('service_role', 'public.news_entries', 'insert'),
    'service_role is read-only on news_entries'
);

-- constraint behavior: use a fixture source
insert into public.news_sources (id, canonical_url, source_type)
values ('00000000-0000-0000-0000-00000000feed', 'https://example.gov/feed.xml', 'rss');

select lives_ok(
    $$insert into public.news_entries
        (news_source_id, url, url_canonical, title, summary, content_hash, published_at)
      values
        ('00000000-0000-0000-0000-00000000feed',
         'https://example.gov/a?utm=1', 'https://example.gov/a',
         'FDA recalls Valsatrex', 'Contamination found.',
         repeat('ab', 32), now())$$,
    'valid entry inserts'
);

select throws_ok(
    $$insert into public.news_entries
        (news_source_id, url, url_canonical, content_hash)
      values
        ('00000000-0000-0000-0000-00000000feed',
         'https://example.gov/b', 'https://example.gov/a',
         repeat('cd', 32))$$,
    '23505',
    null,
    'duplicate url_canonical rejected'
);

select throws_ok(
    $$insert into public.news_entries
        (news_source_id, url, url_canonical, content_hash)
      values
        ('00000000-0000-0000-0000-00000000feed',
         'https://example.gov/c', 'https://example.gov/c', 'not-a-sha')$$,
    '23514',
    null,
    'malformed content_hash rejected'
);

select throws_ok(
    $$insert into public.news_entries
        (news_source_id, url, url_canonical, content_hash, embedding)
      values
        ('00000000-0000-0000-0000-00000000feed',
         'https://example.gov/d', 'https://example.gov/d',
         repeat('ef', 32), '\x0102')$$,
    '23514',
    null,
    'embedding without embedding_model rejected'
);

select ok(
    exists (
        select 1 from pg_catalog.pg_indexes
        where schemaname = 'public' and tablename = 'news_entries'
          and indexdef like '%gin%entity_set%'
    ),
    'GIN index on entity_set exists'
);

select ok(
    exists (
        select 1 from pg_catalog.pg_indexes
        where schemaname = 'public' and tablename = 'news_entries'
          and indexdef like '%gin%event_keys%'
    ),
    'GIN index on event_keys exists'
);

select * from finish();

rollback;
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm supabase test db`
Expected: FAIL — `news_entries table exists` fails (`relation "public.news_entries" does not exist` cascade).

- [ ] **Step 3: Write the migration**

```sql
-- supabase/migrations/20260718000400_create_news_entries.sql
begin;

create table public.news_entries (
    id uuid primary key default gen_random_uuid(),
    news_source_id uuid not null
        references public.news_sources(id) on delete cascade,
    url text not null,
    url_canonical text not null unique,
    title text,
    summary text,
    published_at timestamptz,
    fetched_at timestamptz not null default now(),
    content_hash text not null,
    embedding bytea,
    embedding_model text,
    enriched_text text,
    enricher_version integer,
    entity_set text[] not null default '{}'::text[],
    event_keys text[] not null default '{}'::text[],
    extractor_version integer,
    created_at timestamptz not null default now(),
    constraint news_entries_url_bounded
        check (length(url) between 1 and 2048),
    constraint news_entries_url_canonical_bounded
        check (length(url_canonical) between 1 and 2048),
    constraint news_entries_title_bounded
        check (title is null or length(title) <= 1024),
    constraint news_entries_summary_bounded
        check (summary is null or length(summary) <= 16384),
    constraint news_entries_content_hash_valid
        check (content_hash ~ '^[0-9a-f]{64}$'),
    constraint news_entries_embedding_bounded
        check (embedding is null or octet_length(embedding) between 2 and 4096),
    constraint news_entries_embedding_model_present
        check (embedding is null or embedding_model is not null),
    constraint news_entries_embedding_model_bounded
        check (embedding_model is null or length(embedding_model) <= 256),
    constraint news_entries_enriched_text_bounded
        check (enriched_text is null or length(enriched_text) <= 16384),
    constraint news_entries_enricher_version_valid
        check (enricher_version is null or enricher_version >= 1),
    constraint news_entries_entity_set_valid
        check (
            cardinality(entity_set) <= 64
            and array_position(entity_set, null) is null
        ),
    constraint news_entries_event_keys_valid
        check (
            cardinality(event_keys) <= 16
            and array_position(event_keys, null) is null
        ),
    constraint news_entries_extractor_version_valid
        check (extractor_version is null or extractor_version >= 1)
);

comment on table public.news_entries is
    'Normalized feed items; the atomic clustering unit. Dedupe keys, embedding, enrichment, and deterministic identity anchors live here.';
comment on column public.news_entries.content_hash is
    'sha256 hex of normalized(title)||normalized(summary); dedupe layer 2 and enrichment cache key.';
comment on column public.news_entries.embedding is
    'fp16 vector bytes; always computed from enriched_text when present, else raw title+summary. embedding_model records provenance.';
comment on column public.news_entries.entity_set is
    'Salient discriminator entities extracted from RAW title/summary only (never enriched text). Versioned by extractor_version.';
comment on column public.news_entries.event_keys is
    'Hard deterministic event identifiers (FR doc numbers, docket IDs, recall numbers, CVEs) from RAW text. Strongest attach tier.';

create index news_entries_content_hash_idx
    on public.news_entries (content_hash);
create index news_entries_published_at_idx
    on public.news_entries (published_at);
create index news_entries_fetched_at_idx
    on public.news_entries (fetched_at);
create index news_entries_source_idx
    on public.news_entries (news_source_id, fetched_at);
create index news_entries_entity_set_idx
    on public.news_entries using gin (entity_set);
create index news_entries_event_keys_idx
    on public.news_entries using gin (event_keys);

alter table public.news_entries enable row level security;

revoke all privileges on table public.news_entries
    from public, anon, authenticated, service_role;

grant select on table public.news_entries to service_role;

commit;
```

- [ ] **Step 4: Apply and run tests**

Run: `pnpm supabase db reset && pnpm supabase test db`
Expected: PASS — all 10 assertions green; existing test files still green.

- [ ] **Step 5: Commit**

```bash
git add supabase/migrations/20260718000400_create_news_entries.sql supabase/tests/database/news_entries.test.sql
git commit -m "feat: add news_entries table with dedupe keys and identity anchors

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 2: `entity_stats` table

One row per distinct entity/event-key string. Powers novelty signal (`first_seen_at`) and promiscuity down-weighting (`daily_ema`, decayed on touch — no sweep jobs, mirroring the rank_key philosophy).

**Files:**

- Create: `supabase/migrations/20260718000500_create_entity_stats.sql`
- Test: `supabase/tests/database/entity_stats.test.sql`

**Interfaces:**

- Consumes: nothing (standalone).
- Produces: `public.entity_stats(entity text PK, first_seen_at, last_seen_at, total_count int, daily_ema real, ema_updated_at)`. The ingest RPC (future plan) upserts here; overlap-scoring reads `daily_ema` to down-weight ambient entities.

- [ ] **Step 1: Write the failing test**

```sql
-- supabase/tests/database/entity_stats.test.sql
begin;

select plan(6);

select has_table('public', 'entity_stats', 'entity_stats table exists');

select ok(
    (
        select relrowsecurity
        from pg_catalog.pg_class
        join pg_catalog.pg_namespace
          on pg_namespace.oid = pg_class.relnamespace
        where pg_namespace.nspname = 'public'
          and pg_class.relname = 'entity_stats'
    ),
    'RLS enabled on entity_stats'
);

select ok(
    not has_table_privilege('anon', 'public.entity_stats', 'select')
    and has_table_privilege('service_role', 'public.entity_stats', 'select')
    and not has_table_privilege('service_role', 'public.entity_stats', 'insert'),
    'grants: service_role read-only, anon nothing'
);

select lives_ok(
    $$insert into public.entity_stats (entity) values ('valsatrex')$$,
    'minimal insert works with defaults'
);

select throws_ok(
    $$insert into public.entity_stats (entity) values ('')$$,
    '23514',
    null,
    'empty entity rejected'
);

select throws_ok(
    $$insert into public.entity_stats (entity, daily_ema) values ('fda', -1.0)$$,
    '23514',
    null,
    'negative daily_ema rejected'
);

select * from finish();

rollback;
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm supabase test db`
Expected: FAIL — `entity_stats table exists`.

- [ ] **Step 3: Write the migration**

```sql
-- supabase/migrations/20260718000500_create_entity_stats.sql
begin;

create table public.entity_stats (
    entity text primary key,
    first_seen_at timestamptz not null default now(),
    last_seen_at timestamptz not null default now(),
    total_count integer not null default 1,
    daily_ema real not null default 0,
    ema_updated_at timestamptz not null default now(),
    constraint entity_stats_entity_bounded
        check (length(entity) between 1 and 256),
    constraint entity_stats_total_count_positive
        check (total_count >= 1),
    constraint entity_stats_daily_ema_nonnegative
        check (daily_ema >= 0),
    constraint entity_stats_seen_window_valid
        check (first_seen_at <= last_seen_at)
);

comment on table public.entity_stats is
    'Per-entity running stats. first_seen_at = novelty signal; daily_ema = ambient-entity (promiscuity) signal, decayed lazily on touch using ema_updated_at.';
comment on column public.entity_stats.daily_ema is
    'Exponential moving average of daily mention count. Updated on ingest: decay by elapsed days since ema_updated_at, then increment. No sweep jobs.';

alter table public.entity_stats enable row level security;

revoke all privileges on table public.entity_stats
    from public, anon, authenticated, service_role;

grant select on table public.entity_stats to service_role;

commit;
```

- [ ] **Step 4: Apply and run tests**

Run: `pnpm supabase db reset && pnpm supabase test db`
Expected: PASS — 6 assertions green.

- [ ] **Step 5: Commit**

```bash
git add supabase/migrations/20260718000500_create_entity_stats.sql supabase/tests/database/entity_stats.test.sql
git commit -m "feat: add entity_stats table for novelty and ambient-entity signals

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 3: `storylines`, `episodes`, `episode_entries` (+ `news_entries.episode_id`)

The clustering core: storylines (unbounded entity-anchored chains), episodes (one development pulse), and the audit-carrying junction to entries. Also adds the denormalized `news_entries.episode_id` back-reference (v1 spec's `news_items.cluster_id` pattern).

**Files:**

- Create: `supabase/migrations/20260718000600_create_storylines_episodes.sql`
- Test: `supabase/tests/database/storylines_episodes.test.sql`

**Interfaces:**

- Consumes: `public.news_entries(id)` from Task 1.
- Produces:
  - `public.storylines(id uuid PK, entity_set text[], event_keys text[], centroid bytea, topic text, cluster_topic text, agency_ids text[], distinct_feeds int, entry_count int, episode_count int, source_weight_max real, first_entry_at, newest_entry_at, latest_card_id uuid (no FK yet — Task 4 adds it), merged_into uuid, created_at)`.
  - `public.episodes(id uuid PK, storyline_id uuid FK, status text 'open'|'dormant', centroid bytea, entity_set text[], event_keys text[], entry_count int, first_entry_at, newest_entry_at, attach_method, attach_similarity real, attach_reason text, adjudicator_model text)`.
  - `public.episode_entries(episode_id, entry_id) PK` junction with full attach-audit columns.
  - `public.news_entries.episode_id uuid` (nullable, FK to episodes).
  - Attach-method vocabularies (later RPCs must use exactly these):
    - episode→storyline: `'event_key' | 'entity_candidate' | 'adjudicated_join' | 'new_storyline' | 'consolidation_merge'`
    - entry→episode: `'exact_url' | 'content_hash' | 'near_dup' | 'event_key' | 'centroid_join' | 'entity_community' | 'adjudicated_join' | 'adjudicated_new' | 'new_cluster' | 'consolidation_merge' | 'consolidation_split'`

- [ ] **Step 1: Write the failing test**

```sql
-- supabase/tests/database/storylines_episodes.test.sql
begin;

select plan(12);

select has_table('public', 'storylines', 'storylines table exists');
select has_table('public', 'episodes', 'episodes table exists');
select has_table('public', 'episode_entries', 'episode_entries table exists');

select has_column('public', 'news_entries', 'episode_id',
    'news_entries gained denormalized episode_id');

select is(
    (
        select count(*)::integer
        from pg_catalog.pg_class
        join pg_catalog.pg_namespace
          on pg_namespace.oid = pg_class.relnamespace
        where pg_namespace.nspname = 'public'
          and pg_class.relname in ('storylines', 'episodes', 'episode_entries')
          and pg_class.relrowsecurity
    ),
    3,
    'RLS enabled on all three tables'
);

select ok(
    not has_table_privilege('anon', 'public.storylines', 'select')
    and not has_table_privilege('anon', 'public.episodes', 'select')
    and not has_table_privilege('anon', 'public.episode_entries', 'select'),
    'anon cannot read clustering tables'
);

-- fixtures
insert into public.storylines (id, first_entry_at, newest_entry_at)
values ('00000000-0000-0000-0000-000000000051', now(), now());

select lives_ok(
    $$insert into public.episodes
        (id, storyline_id, first_entry_at, newest_entry_at, attach_method)
      values
        ('00000000-0000-0000-0000-0000000000e1',
         '00000000-0000-0000-0000-000000000051',
         now(), now(), 'new_storyline')$$,
    'episode with valid attach_method inserts'
);

select throws_ok(
    $$insert into public.episodes
        (storyline_id, first_entry_at, newest_entry_at, attach_method)
      values
        ('00000000-0000-0000-0000-000000000051',
         now(), now(), 'vibes')$$,
    '23514',
    null,
    'invalid episode attach_method rejected'
);

select throws_ok(
    $$insert into public.episodes
        (storyline_id, status, first_entry_at, newest_entry_at, attach_method)
      values
        ('00000000-0000-0000-0000-000000000051',
         'closed', now(), now(), 'new_storyline')$$,
    '23514',
    null,
    'invalid episode status rejected'
);

insert into public.news_sources (id, canonical_url, source_type)
values ('00000000-0000-0000-0000-00000000fee2', 'https://example.gov/f2.xml', 'rss');
insert into public.news_entries (id, news_source_id, url, url_canonical, content_hash)
values ('00000000-0000-0000-0000-0000000000a1',
        '00000000-0000-0000-0000-00000000fee2',
        'https://example.gov/x', 'https://example.gov/x', repeat('aa', 32));

select lives_ok(
    $$insert into public.episode_entries
        (episode_id, entry_id, attach_method, similarity, threshold_used, embedding_model)
      values
        ('00000000-0000-0000-0000-0000000000e1',
         '00000000-0000-0000-0000-0000000000a1',
         'near_dup', 0.95, 0.93, 'bge-large-en-v1.5')$$,
    'junction row with audit evidence inserts'
);

select throws_ok(
    $$insert into public.episode_entries (episode_id, entry_id, attach_method)
      values
        ('00000000-0000-0000-0000-0000000000e1',
         '00000000-0000-0000-0000-0000000000a1',
         'exact_url')$$,
    '23505',
    null,
    'duplicate membership rejected'
);

select ok(
    exists (
        select 1 from pg_catalog.pg_indexes
        where schemaname = 'public' and tablename = 'storylines'
          and indexdef like '%gin%entity_set%'
    )
    and exists (
        select 1 from pg_catalog.pg_indexes
        where schemaname = 'public' and tablename = 'storylines'
          and indexdef like '%gin%event_keys%'
    ),
    'storyline candidate-generation GIN indexes exist'
);

select * from finish();

rollback;
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm supabase test db`
Expected: FAIL — `storylines table exists`.

- [ ] **Step 3: Write the migration**

```sql
-- supabase/migrations/20260718000600_create_storylines_episodes.sql
begin;

create table public.storylines (
    id uuid primary key default gen_random_uuid(),
    entity_set text[] not null default '{}'::text[],
    event_keys text[] not null default '{}'::text[],
    centroid bytea,
    topic text,
    cluster_topic text,
    agency_ids text[] not null default '{}'::text[],
    distinct_feeds integer not null default 0,
    entry_count integer not null default 0,
    episode_count integer not null default 0,
    source_weight_max real not null default 1.0,
    first_entry_at timestamptz not null,
    newest_entry_at timestamptz not null,
    latest_card_id uuid,
    merged_into uuid references public.storylines(id),
    created_at timestamptz not null default now(),
    constraint storylines_entity_set_valid
        check (
            cardinality(entity_set) <= 256
            and array_position(entity_set, null) is null
        ),
    constraint storylines_event_keys_valid
        check (
            cardinality(event_keys) <= 64
            and array_position(event_keys, null) is null
        ),
    constraint storylines_centroid_bounded
        check (centroid is null or octet_length(centroid) between 2 and 4096),
    constraint storylines_topic_bounded
        check (topic is null or length(topic) <= 128),
    constraint storylines_cluster_topic_bounded
        check (cluster_topic is null or length(cluster_topic) <= 256),
    constraint storylines_agency_ids_valid
        check (
            cardinality(agency_ids) <= 128
            and array_position(agency_ids, null) is null
        ),
    constraint storylines_counts_nonnegative
        check (
            distinct_feeds >= 0
            and entry_count >= 0
            and episode_count >= 0
        ),
    constraint storylines_source_weight_valid
        check (source_weight_max >= 0),
    constraint storylines_entry_window_valid
        check (first_entry_at <= newest_entry_at)
);

comment on table public.storylines is
    'Unbounded chains of episodes about one historical event. Candidate generation via entity/event-key GIN indexes — no scan ever depends on corpus age.';
comment on column public.storylines.entity_set is
    'Union of member episodes'' salient discriminators; the identity anchor and candidate index.';
comment on column public.storylines.event_keys is
    'Union of member episodes'' hard event identifiers; strongest storyline-attach tier.';
comment on column public.storylines.latest_card_id is
    'Current overview event_cards row. FK added in the event_cards migration (circular reference).';
comment on column public.storylines.merged_into is
    'Set by nightly consolidation; excluded from serving, permalink 301s to the winner.';

create index storylines_entity_set_idx
    on public.storylines using gin (entity_set);
create index storylines_event_keys_idx
    on public.storylines using gin (event_keys);
create index storylines_newest_entry_idx
    on public.storylines (newest_entry_at);

create table public.episodes (
    id uuid primary key default gen_random_uuid(),
    storyline_id uuid not null references public.storylines(id),
    status text not null default 'open',
    centroid bytea,
    entity_set text[] not null default '{}'::text[],
    event_keys text[] not null default '{}'::text[],
    entry_count integer not null default 0,
    first_entry_at timestamptz not null,
    newest_entry_at timestamptz not null,
    attach_method text not null,
    attach_similarity real,
    attach_reason text,
    adjudicator_model text,
    created_at timestamptz not null default now(),
    constraint episodes_status_valid
        check (status in ('open', 'dormant')),
    constraint episodes_centroid_bounded
        check (centroid is null or octet_length(centroid) between 2 and 4096),
    constraint episodes_entity_set_valid
        check (
            cardinality(entity_set) <= 128
            and array_position(entity_set, null) is null
        ),
    constraint episodes_event_keys_valid
        check (
            cardinality(event_keys) <= 32
            and array_position(event_keys, null) is null
        ),
    constraint episodes_entry_count_nonnegative
        check (entry_count >= 0),
    constraint episodes_entry_window_valid
        check (first_entry_at <= newest_entry_at),
    constraint episodes_attach_method_valid
        check (attach_method in (
            'event_key',
            'entity_candidate',
            'adjudicated_join',
            'new_storyline',
            'consolidation_merge'
        )),
    constraint episodes_attach_similarity_valid
        check (
            attach_similarity is null
            or (attach_similarity >= -1.0 and attach_similarity <= 1.0)
        ),
    constraint episodes_attach_reason_bounded
        check (attach_reason is null or length(attach_reason) <= 2048),
    constraint episodes_adjudicator_model_bounded
        check (adjudicator_model is null or length(adjudicator_model) <= 256)
);

comment on table public.episodes is
    'One development pulse: tight cluster from the v1 pipeline, closes after 4 h rolling quiet (EPISODE_DORMANCY). attach_* columns audit the episode→storyline decision.';

create index episodes_storyline_idx
    on public.episodes (storyline_id);
create index episodes_open_idx
    on public.episodes (newest_entry_at)
    where status = 'open';

create table public.episode_entries (
    episode_id uuid not null references public.episodes(id),
    entry_id uuid not null references public.news_entries(id),
    is_syndicated boolean not null default false,
    attach_method text not null,
    similarity real,
    matched_entry_id uuid references public.news_entries(id),
    threshold_used real,
    embedding_model text,
    attached_at timestamptz not null default now(),
    primary key (episode_id, entry_id),
    constraint episode_entries_attach_method_valid
        check (attach_method in (
            'exact_url',
            'content_hash',
            'near_dup',
            'event_key',
            'centroid_join',
            'entity_community',
            'adjudicated_join',
            'adjudicated_new',
            'new_cluster',
            'consolidation_merge',
            'consolidation_split'
        )),
    constraint episode_entries_similarity_valid
        check (similarity is null or (similarity >= -1.0 and similarity <= 1.0)),
    constraint episode_entries_threshold_valid
        check (threshold_used is null or (threshold_used >= -1.0 and threshold_used <= 1.0)),
    constraint episode_entries_embedding_model_bounded
        check (embedding_model is null or length(embedding_model) <= 256)
);

comment on table public.episode_entries is
    'Membership junction and audit record: every attach stores the method, similarity, matched entry, threshold, and model in force at decision time. Clustering QA is plain SQL.';

create index episode_entries_entry_idx
    on public.episode_entries (entry_id);

alter table public.news_entries
    add column episode_id uuid references public.episodes(id);

comment on column public.news_entries.episode_id is
    'Denormalized current episode (set by the attach RPC) so entry→episode is one hop; episode→entries goes through the junction.';

create index news_entries_episode_idx
    on public.news_entries (episode_id);

alter table public.storylines enable row level security;
alter table public.episodes enable row level security;
alter table public.episode_entries enable row level security;

revoke all privileges on table public.storylines
    from public, anon, authenticated, service_role;
revoke all privileges on table public.episodes
    from public, anon, authenticated, service_role;
revoke all privileges on table public.episode_entries
    from public, anon, authenticated, service_role;

grant select on table public.storylines,
    public.episodes,
    public.episode_entries
    to service_role;

commit;
```

- [ ] **Step 4: Apply and run tests**

Run: `pnpm supabase db reset && pnpm supabase test db`
Expected: PASS — 12 assertions green; Task 1/2 tests still green.

- [ ] **Step 5: Commit**

```bash
git add supabase/migrations/20260718000600_create_storylines_episodes.sql supabase/tests/database/storylines_episodes.test.sql
git commit -m "feat: add storylines, episodes, and audited episode_entries junction

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 4: `event_cards` table (+ close the `storylines.latest_card_id` loop)

Write-once serving surface: overview cards (superseded on regeneration) and immutable 1:1 episode cards. `rank_key` computed at birth, never updated.

**Files:**

- Create: `supabase/migrations/20260718000700_create_event_cards.sql`
- Test: `supabase/tests/database/event_cards.test.sql`

**Interfaces:**

- Consumes: `public.storylines(id, latest_card_id)`, `public.episodes(id)`, `public.news_entries(id)`.
- Produces: `public.event_cards(id uuid PK, storyline_id, episode_id nullable, kind 'overview'|'episode', version int, headline, summary, timeline jsonb, rubric jsonb, rubric_version int, interest_reason, og jsonb, representative_entry_id, newest_entry_at, rank_key float8, superseded_by uuid, judge_model, prompt_version int, generated_at)`. Serving query shape later code relies on: `WHERE superseded_by IS NULL AND newest_entry_at > now() - interval '7 days' ORDER BY rank_key DESC` — backed by the partial index created here. Also adds the deferred FK `storylines.latest_card_id → event_cards(id)`.

- [ ] **Step 1: Write the failing test**

```sql
-- supabase/tests/database/event_cards.test.sql
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
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm supabase test db`
Expected: FAIL — `event_cards table exists`.

- [ ] **Step 3: Write the migration**

```sql
-- supabase/migrations/20260718000700_create_event_cards.sql
begin;

create table public.event_cards (
    id uuid primary key default gen_random_uuid(),
    storyline_id uuid not null references public.storylines(id),
    episode_id uuid references public.episodes(id),
    kind text not null,
    version integer not null,
    headline text not null,
    summary text not null,
    timeline jsonb,
    rubric jsonb,
    rubric_version integer,
    interest_reason text,
    og jsonb,
    representative_entry_id uuid references public.news_entries(id),
    newest_entry_at timestamptz not null,
    rank_key float8 not null,
    superseded_by uuid references public.event_cards(id),
    judge_model text,
    prompt_version integer,
    generated_at timestamptz not null default now(),
    constraint event_cards_kind_valid
        check (kind in ('overview', 'episode')),
    constraint event_cards_kind_episode_consistent
        check (
            (kind = 'overview' and episode_id is null)
            or (kind = 'episode' and episode_id is not null)
        ),
    constraint event_cards_version_valid
        check (version >= 1),
    constraint event_cards_headline_bounded
        check (length(headline) between 1 and 512),
    constraint event_cards_summary_bounded
        check (length(summary) between 1 and 8192),
    constraint event_cards_timeline_valid
        check (
            timeline is null
            or (
                jsonb_typeof(timeline) = 'array'
                and pg_catalog.pg_column_size(timeline) <= 32768
            )
        ),
    constraint event_cards_rubric_valid
        check (
            rubric is null
            or (
                jsonb_typeof(rubric) = 'object'
                and pg_catalog.pg_column_size(rubric) <= 8192
            )
        ),
    constraint event_cards_rubric_version_valid
        check (rubric_version is null or rubric_version >= 1),
    constraint event_cards_interest_reason_bounded
        check (interest_reason is null or length(interest_reason) <= 2048),
    constraint event_cards_og_valid
        check (
            og is null
            or (
                jsonb_typeof(og) = 'object'
                and pg_catalog.pg_column_size(og) <= 8192
            )
        ),
    constraint event_cards_judge_model_bounded
        check (judge_model is null or length(judge_model) <= 256),
    constraint event_cards_prompt_version_valid
        check (prompt_version is null or prompt_version >= 1)
);

comment on table public.event_cards is
    'Write-once serving surface. Overview cards compress the chain-so-far and are superseded on regeneration; episode cards are immutable 1:1 with episodes. rank_key is computed exactly once at birth — rank refresh happens by supersession, never UPDATE.';
comment on column public.event_cards.superseded_by is
    'Newer overview card that replaced this one. Serving filters on IS NULL.';

create index event_cards_serving_idx
    on public.event_cards (rank_key desc)
    where superseded_by is null;
create index event_cards_storyline_version_idx
    on public.event_cards (storyline_id, version);
create unique index event_cards_episode_unique_idx
    on public.event_cards (episode_id)
    where episode_id is not null;

alter table public.storylines
    add constraint storylines_latest_card_fk
        foreign key (latest_card_id) references public.event_cards(id);

alter table public.event_cards enable row level security;

revoke all privileges on table public.event_cards
    from public, anon, authenticated, service_role;

grant select on table public.event_cards to service_role;

commit;
```

- [ ] **Step 4: Apply and run tests**

Run: `pnpm supabase db reset && pnpm supabase test db`
Expected: PASS — 9 assertions green; all prior suites green.

- [ ] **Step 5: Commit**

```bash
git add supabase/migrations/20260718000700_create_event_cards.sql supabase/tests/database/event_cards.test.sql
git commit -m "feat: add write-once event_cards serving table

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 5: `rubric_weights` table

Small dials table: `(rubric_version, criterion, weight)`. Bits are facts stored on cards; weights live in SQL so retuning is one UPDATE + recompute, zero LLM re-calls (v1 spec, line 200).

**Files:**

- Create: `supabase/migrations/20260718000800_create_rubric_weights.sql`
- Test: `supabase/tests/database/rubric_weights.test.sql`

**Interfaces:**

- Consumes: nothing (standalone).
- Produces: `public.rubric_weights(rubric_version int, criterion text, weight real, PK (rubric_version, criterion))`. The future `compute_rank_key(...)` SQL function reads this.

- [ ] **Step 1: Write the failing test**

```sql
-- supabase/tests/database/rubric_weights.test.sql
begin;

select plan(5);

select has_table('public', 'rubric_weights', 'rubric_weights table exists');

select ok(
    (
        select relrowsecurity
        from pg_catalog.pg_class
        join pg_catalog.pg_namespace
          on pg_namespace.oid = pg_class.relnamespace
        where pg_namespace.nspname = 'public'
          and pg_class.relname = 'rubric_weights'
    ),
    'RLS enabled on rubric_weights'
);

select lives_ok(
    $$insert into public.rubric_weights (rubric_version, criterion, weight)
      values (1, 'public_safety_impact', 2.0)$$,
    'weight row inserts'
);

select throws_ok(
    $$insert into public.rubric_weights (rubric_version, criterion, weight)
      values (1, 'public_safety_impact', 3.0)$$,
    '23505',
    null,
    'duplicate (version, criterion) rejected'
);

select throws_ok(
    $$insert into public.rubric_weights (rubric_version, criterion, weight)
      values (0, 'x', 1.0)$$,
    '23514',
    null,
    'rubric_version below 1 rejected'
);

select * from finish();

rollback;
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm supabase test db`
Expected: FAIL — `rubric_weights table exists`.

- [ ] **Step 3: Write the migration**

```sql
-- supabase/migrations/20260718000800_create_rubric_weights.sql
begin;

create table public.rubric_weights (
    rubric_version integer not null,
    criterion text not null,
    weight real not null,
    updated_at timestamptz not null default now(),
    primary key (rubric_version, criterion),
    constraint rubric_weights_version_valid
        check (rubric_version >= 1),
    constraint rubric_weights_criterion_bounded
        check (length(criterion) between 1 and 128)
);

comment on table public.rubric_weights is
    'Ranking dials. Judge-produced rubric bits are facts on cards; weights live here so retuning is one UPDATE recomputing rank_key from stored bits — zero LLM re-calls. Changing criteria bumps rubric_version.';

alter table public.rubric_weights enable row level security;

revoke all privileges on table public.rubric_weights
    from public, anon, authenticated, service_role;

grant select on table public.rubric_weights to service_role;

commit;
```

- [ ] **Step 4: Apply and run tests**

Run: `pnpm supabase db reset && pnpm supabase test db`
Expected: PASS — 5 assertions green; full suite green.

- [ ] **Step 5: Commit**

```bash
git add supabase/migrations/20260718000800_create_rubric_weights.sql supabase/tests/database/rubric_weights.test.sql
git commit -m "feat: add rubric_weights ranking dials table

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

## Deliberately out of scope (follow-up plans)

- Attach/upsert RPCs (`attach_entry_to_episode`, `attach_episode_to_storyline`, `compute_rank_key`) — need the processing design finalized first; the attach-method vocabularies these tables enforce are their contract.
- Serving-layer grants (anon read on `event_cards` serving columns) — belongs with the serving API work.
- Chroma collections (hot/search) — not Postgres.
- `pipeline_events` outbox integration for clustering stages — existing table, wiring is worker code.
- Entity/event-key extractor itself — TypeScript, separate plan; `extractor_version` column is its anchor.
