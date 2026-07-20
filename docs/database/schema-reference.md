# Database Schema Reference

This is the human-readable catalog produced by the committed migration chain
through `20260720040000_add_atomic_golden_overview_publish.sql`. The migration
files remain authoritative for executable DDL, exact check expressions,
indexes, grants, triggers, and RPC bodies.

Every table below is in the `public` schema and has row-level security enabled.
Columns are nullable unless marked `NOT NULL`. `PK`, `UK`, and `FK` mean
primary key, unique key, and foreign key. Timestamps are `timestamptz`.

## Inventory and pipeline control

### `pipeline_events`

Idempotent diagnostic and lifecycle events emitted by pipeline components.
This is an audit stream, not authoritative queue or domain state.

```text
id               uuid        PK
schema_version   smallint    NOT NULL
event_type       text        NOT NULL
idempotency_key  text        NOT NULL UK
occurred_at      timestamptz NOT NULL
payload          jsonb       NOT NULL DEFAULT '{}'
artifact_key     text
created_at       timestamptz NOT NULL DEFAULT now()
```

Important invariants: schema versions are positive, payloads are JSON objects,
and event type, idempotency key, and any artifact key cannot be blank.

### `inventory_sync_runs`

One auditable attempt to ingest and reconcile a GSA inventory snapshot.

```text
id                 uuid        PK DEFAULT gen_random_uuid()
source             text        NOT NULL
status             text        NOT NULL DEFAULT 'running'
source_url         text        NOT NULL
source_etag        text
source_sha256      text
raw_artifact_key   text
source_row_count   integer
staged_count       integer     NOT NULL DEFAULT 0
inserted_count     integer     NOT NULL DEFAULT 0
updated_count      integer     NOT NULL DEFAULT 0
reactivated_count  integer     NOT NULL DEFAULT 0
deactivated_count  integer     NOT NULL DEFAULT 0
eligible_count     integer     NOT NULL DEFAULT 0
error_code         text
error_detail       text
started_at         timestamptz NOT NULL DEFAULT now()
completed_at       timestamptz
```

Status, completion fields, checksums, counters, and error fields are checked
for consistency. Inventory RPCs own this lifecycle.

### `government_sites`

The normalized, historical GSA website inventory. Ineligible and inactive rows
are retained for audit.

```text
id                    uuid        PK DEFAULT gen_random_uuid()
source                text        NOT NULL DEFAULT 'gsa_federal_website_index'
source_initial_url    text        NOT NULL
initial_url           text
base_domain           text
top_level_domain      text        NOT NULL
branch                text
agency                text
bureau                text
gsa_filtered          boolean     NOT NULL
inventory_usable      boolean     NOT NULL
exclusion_reason      text
inventory_active      boolean     NOT NULL DEFAULT true
source_row_hash       text        NOT NULL
discovery_input_hash  text        NOT NULL
first_seen_at         timestamptz NOT NULL DEFAULT now()
last_seen_at          timestamptz NOT NULL DEFAULT now()
deactivated_at        timestamptz
last_sync_run_id      uuid        NOT NULL FK -> inventory_sync_runs.id
```

Unique key: `(source, source_initial_url)`. Hashes are lowercase SHA-256.
Usability and deactivation fields must agree: usable rows have normalized URL
and domain values with no exclusion reason; inactive rows have a deactivation
timestamp.

### `site_discovery_state`

The durable, lease-safe backlog for discovering news sources from usable
government sites.

```text
site_id                    uuid        PK FK -> government_sites.id ON DELETE CASCADE
status                     text        NOT NULL
next_discovery_at          timestamptz
lease_token                uuid
lease_owner                uuid
lease_until                timestamptz
last_started_at            timestamptz
last_completed_at          timestamptz
last_result                text
failure_count              integer     NOT NULL DEFAULT 0
successful_discovery_count integer     NOT NULL DEFAULT 0
last_error_code            text
last_error_detail          text
updated_at                 timestamptz NOT NULL DEFAULT now()
last_final_url             text
last_http_status           integer
last_duration_ms           integer
last_policy_version        integer
last_checked_source_types  text[]      NOT NULL DEFAULT '{}'
```

Statuses are `pending`, `leased`, `succeeded`, `no_news_source`, `backoff`, or
`disabled`. Lease fields must all be present only while leased. HTTP codes,
durations, counters, policy versions, and source-type values are bounded.

### `usable_government_sites` view

Read model for active, unfiltered, usable discovery inputs. It exposes:

```text
id, source, source_initial_url, initial_url, base_domain, top_level_domain,
branch, agency, bureau, first_seen_at, last_seen_at, last_sync_run_id
```

It filters `government_sites` to `inventory_active = true`,
`gsa_filtered = false`, and `inventory_usable = true`.

## News sources and corpus

### `news_sources`

Canonical source endpoints across feeds, publisher APIs, HTML archives, and
sitemaps.

```text
id                     uuid        PK DEFAULT gen_random_uuid()
canonical_url          text        NOT NULL UK
source_type            text        NOT NULL
title                  text
home_page_url          text
status                 text        NOT NULL DEFAULT 'active'
last_http_status       integer
backfill_supported     boolean     NOT NULL DEFAULT false
earliest_available_at  timestamptz
latest_observed_at     timestamptz
adapter_config         jsonb       NOT NULL DEFAULT '{}'
quality_flags          text[]      NOT NULL DEFAULT '{}'
first_seen_at          timestamptz NOT NULL DEFAULT now()
last_seen_at           timestamptz NOT NULL DEFAULT now()
last_validated_at      timestamptz NOT NULL DEFAULT now()
created_at             timestamptz NOT NULL DEFAULT now()
updated_at             timestamptz NOT NULL DEFAULT now()
```

Source types are `rss`, `atom`, `json_feed`, `publisher_api`, `html_archive`,
or `sitemap`. Statuses are `active`, `invalid`, `gone`, or `suppressed`.
Adapter config must be a bounded JSON object and observation timestamps must
form a valid window.

### `government_site_news_sources`

Many-to-many discovery provenance between inventory sites and canonical news
sources.

```text
site_id                uuid        PK FK -> government_sites.id ON DELETE CASCADE
news_source_id         uuid        PK FK -> news_sources.id ON DELETE CASCADE
discovery_method       text        NOT NULL
discovery_url          text        NOT NULL
active                 boolean     NOT NULL DEFAULT true
missing_success_count  integer     NOT NULL DEFAULT 0
first_seen_at          timestamptz NOT NULL DEFAULT now()
last_seen_at           timestamptz NOT NULL DEFAULT now()
updated_at             timestamptz NOT NULL DEFAULT now()
```

Discovery methods include HTTP/header links, anchors, conventional paths, root
or API documents, archives, sitemaps, and manual attribution.

### `news_source_fetch_state`

One lease and conditional-fetch checkpoint per canonical source.

```text
news_source_id   uuid        PK FK -> news_sources.id ON DELETE CASCADE
status           text        NOT NULL DEFAULT 'pending'
next_fetch_at    timestamptz
lease_token      uuid
lease_owner      uuid
lease_until      timestamptz
etag             text
last_modified    text
last_success_at  timestamptz
last_new_item_at timestamptz
failure_count    integer     NOT NULL DEFAULT 0
updated_at       timestamptz NOT NULL DEFAULT now()
```

Statuses are `pending`, `leased`, `active`, `backoff`, or `disabled`. Lease
fields follow the same all-or-none rule as discovery state.

### `news_source_publishers`

The normalized publisher identity observed for a source. It is one-to-one with
`news_sources`.

```text
news_source_id   uuid        PK FK -> news_sources.id ON DELETE CASCADE
publisher_key    text        NOT NULL
first_observed_at timestamptz NOT NULL DEFAULT now()
updated_at       timestamptz NOT NULL DEFAULT now()
```

### `news_entries`

Canonical normalized articles and their current enrichment/clustering
features.

```text
id                uuid        PK DEFAULT gen_random_uuid()
news_source_id    uuid        NOT NULL FK -> news_sources.id ON DELETE RESTRICT
url               text        NOT NULL
url_canonical     text        NOT NULL UK
title             text
summary           text
published_at      timestamptz
fetched_at        timestamptz NOT NULL DEFAULT now()
content_hash      text        NOT NULL
embedding         bytea
embedding_model   text
enriched_text     text
enricher_version  integer
entity_set        text[]      NOT NULL DEFAULT '{}'
event_keys        text[]      NOT NULL DEFAULT '{}'
extractor_version integer
created_at        timestamptz NOT NULL DEFAULT now()
episode_id        uuid        FK -> episodes.id
body_text         text
```

`content_hash` is lowercase SHA-256. An embedding requires an embedding-model
name; embedding bytes, enriched text, arrays, URLs, title, and version numbers
are bounded. `episode_id` is the denormalized current assignment, while
`episode_entries` records assignment evidence.

### `news_entry_origins`

All source observations that contributed to one canonical entry, preserving
syndication and external identifiers.

```text
news_entry_id     uuid        PK FK -> news_entries.id ON DELETE CASCADE
news_source_id    uuid        PK FK -> news_sources.id ON DELETE RESTRICT
external_item_id  text
news_subtype      text        NOT NULL
first_observed_at timestamptz NOT NULL DEFAULT now()
last_observed_at  timestamptz NOT NULL DEFAULT now()
```

Subtypes are `press_release`, `agency_news`, `advisory`, or `release`.

## Backfill control and audit

These tables make manifest-driven historical collection resumable and
explainable. They can be omitted when importing an already normalized,
read-only corpus.

### `news_backfill_runs`

```text
id              uuid        PK DEFAULT gen_random_uuid()
run_key         text        NOT NULL UK
cohort_id       text        NOT NULL
manifest_sha256 text        NOT NULL
window_start    timestamptz NOT NULL
window_end      timestamptz NOT NULL
status          text        NOT NULL DEFAULT 'pending'
counters        jsonb       NOT NULL DEFAULT '{}'
started_at      timestamptz NOT NULL DEFAULT now()
completed_at    timestamptz
created_at      timestamptz NOT NULL DEFAULT now()
updated_at      timestamptz NOT NULL DEFAULT now()
```

The manifest hash is SHA-256; window, status, timestamps, and counter-object
shape are checked.

### `news_backfill_targets`

One source adapter/checkpoint within a run.

```text
id                              uuid        PK DEFAULT gen_random_uuid()
run_id                          uuid        NOT NULL FK -> news_backfill_runs.id ON DELETE CASCADE
publisher_key                   text        NOT NULL
source_key                      text        NOT NULL
news_source_id                  uuid        NOT NULL FK -> news_sources.id ON DELETE RESTRICT
adapter                         text        NOT NULL
status                          text        NOT NULL DEFAULT 'pending'
cursor                          jsonb       NOT NULL DEFAULT '{}'
candidates_seen                 integer     NOT NULL DEFAULT 0
inserted_count                  integer     NOT NULL DEFAULT 0
existing_count                  integer     NOT NULL DEFAULT 0
rejected_count                  integer     NOT NULL DEFAULT 0
conflict_count                  integer     NOT NULL DEFAULT 0
oldest_published_at             timestamptz
newest_published_at             timestamptz
coverage_reached_at             timestamptz
stop_reason                     text
coverage_evidence_artifact_key  text
last_error_code                 text
last_error_detail               text
started_at                      timestamptz
completed_at                    timestamptz
created_at                      timestamptz NOT NULL DEFAULT now()
updated_at                      timestamptz NOT NULL DEFAULT now()
```

Unique key: `(run_id, publisher_key, source_key)`. Counters are nonnegative;
status, timestamps, cursor shape, adapter values, and coverage evidence are
checked.

### `news_backfill_run_entries`

Successful candidate-to-entry decisions.

```text
target_id         uuid        PK FK -> news_backfill_targets.id ON DELETE CASCADE
candidate_key     text        PK
news_entry_id     uuid        NOT NULL FK -> news_entries.id ON DELETE RESTRICT
disposition       text        NOT NULL
raw_artifact_key  text        NOT NULL
extractor_version integer     NOT NULL
observed_at       timestamptz NOT NULL DEFAULT now()
```

### `news_backfill_candidate_outcomes`

Terminal outcome for every attempted candidate, including rejected records.

```text
target_id        uuid        PK FK -> news_backfill_targets.id ON DELETE CASCADE
candidate_key    text        PK
disposition      text        NOT NULL
news_entry_id    uuid        FK -> news_entries.id ON DELETE RESTRICT
error_code       text
raw_artifact_key text        NOT NULL
created_at       timestamptz NOT NULL DEFAULT now()
```

### `news_backfill_identity_conflicts`

Cases where URL identity and external-item identity resolve to different
canonical entries.

```text
target_id              uuid        PK FK -> news_backfill_targets.id ON DELETE CASCADE
candidate_key          text        PK
url_news_entry_id      uuid        NOT NULL FK -> news_entries.id ON DELETE RESTRICT
external_news_entry_id uuid        NOT NULL FK -> news_entries.id ON DELETE RESTRICT
raw_artifact_key       text        NOT NULL
created_at             timestamptz NOT NULL DEFAULT now()
resolved_at            timestamptz
resolution             text
```

## Clustering, topics, and cards

### `entity_stats`

Corpus-frequency state used by entity normalization and weighting.

```text
entity         text        PK
first_seen_at  timestamptz NOT NULL DEFAULT now()
last_seen_at   timestamptz NOT NULL DEFAULT now()
total_count    integer     NOT NULL DEFAULT 1
daily_ema      real        NOT NULL DEFAULT 0
ema_updated_at timestamptz NOT NULL DEFAULT now()
```

### `topic_categories`

Stable broad taxonomy categories.

```text
id               uuid        PK DEFAULT gen_random_uuid()
display_name     text        NOT NULL
origin           text        NOT NULL
proposal_reason  text
created_at       timestamptz NOT NULL DEFAULT now()
```

`origin` is `seed` or `llm`. Display names are unique case-insensitively via an
index defined in the migration.

### `topic_themes`

Evolving groups of related storylines within an optional category.

```text
id                  uuid        PK DEFAULT gen_random_uuid()
display_name        text        NOT NULL
centroid            bytea
category_id         uuid        FK -> topic_categories.id
storyline_count     integer     NOT NULL DEFAULT 0
first_storyline_at  timestamptz
newest_storyline_at timestamptz
merged_into         uuid        FK -> topic_themes.id
name_model          text
created_at          timestamptz NOT NULL DEFAULT now()
inclusion_criterion text
demoted_at          timestamptz
```

### `storylines`

Long-lived clusters that connect one or more event episodes.

```text
id                   uuid        PK DEFAULT gen_random_uuid()
entity_set           text[]      NOT NULL DEFAULT '{}'
event_keys           text[]      NOT NULL DEFAULT '{}'
centroid             bytea
topic                text
cluster_topic        text
agency_ids           text[]      NOT NULL DEFAULT '{}'
distinct_feeds       integer     NOT NULL DEFAULT 0
entry_count          integer     NOT NULL DEFAULT 0
episode_count        integer     NOT NULL DEFAULT 0
source_weight_max    real        NOT NULL DEFAULT 1.0
first_entry_at       timestamptz NOT NULL
newest_entry_at      timestamptz NOT NULL
latest_card_id       uuid        FK -> event_cards.id
merged_into          uuid        FK -> storylines.id
created_at           timestamptz NOT NULL DEFAULT now()
theme_id             uuid        FK -> topic_themes.id
theme_attach_method  text
theme_similarity     real
theme_reason         text
category_id          uuid        FK -> topic_categories.id
category_method      text
category_reason      text
```

Counts are nonnegative, time windows are ordered, embeddings/arrays are
bounded, and similarity is between -1 and 1. Theme/category methods and their
explanations are constrained provenance fields.

### `episodes`

Time-bounded event clusters within a storyline.

```text
id                 uuid        PK DEFAULT gen_random_uuid()
storyline_id       uuid        NOT NULL FK -> storylines.id
status             text        NOT NULL DEFAULT 'open'
centroid           bytea
entity_set         text[]      NOT NULL DEFAULT '{}'
event_keys         text[]      NOT NULL DEFAULT '{}'
entry_count        integer     NOT NULL DEFAULT 0
first_entry_at     timestamptz NOT NULL
newest_entry_at    timestamptz NOT NULL
attach_method      text        NOT NULL
attach_similarity  real
attach_reason      text
adjudicator_model  text
created_at         timestamptz NOT NULL DEFAULT now()
```

Status is `open` or `dormant`. Time windows, counts, embeddings, arrays,
similarity, attach method, and explanation lengths are checked.

### `episode_entries`

Membership plus the evidence used to attach an entry to an episode.

```text
episode_id       uuid        PK FK -> episodes.id
entry_id         uuid        PK FK -> news_entries.id
is_syndicated    boolean     NOT NULL DEFAULT false
attach_method    text        NOT NULL
similarity       real
matched_entry_id uuid        FK -> news_entries.id
threshold_used   real
embedding_model  text
attached_at      timestamptz NOT NULL DEFAULT now()
```

Similarities and thresholds are between -1 and 1. Attach methods distinguish
exact/duplicate, event-key, vector, entity-community, adjudicated, new-cluster,
and consolidation decisions.

### `event_cards`

Versioned generated presentation records for either one episode or an overview
of a storyline.

```text
id                      uuid             PK DEFAULT gen_random_uuid()
storyline_id            uuid             NOT NULL FK -> storylines.id
episode_id              uuid             FK -> episodes.id
kind                    text             NOT NULL
version                 integer          NOT NULL
headline                text             NOT NULL
summary                 text             NOT NULL
timeline                jsonb
rubric                  jsonb
rubric_version          integer
interest_reason         text
og                      jsonb
representative_entry_id uuid             FK -> news_entries.id
newest_entry_at         timestamptz      NOT NULL
rank_key                double precision NOT NULL
superseded_by           uuid             FK -> event_cards.id
judge_model             text
prompt_version          integer
generated_at            timestamptz      NOT NULL DEFAULT now()
```

`kind` is `overview` or `episode`; only episode cards carry `episode_id`.
Versions are dense and positive. JSON shapes and text sizes are bounded.

### `rubric_weights`

```text
rubric_version integer     PK
criterion      text        PK
weight         real        NOT NULL
updated_at     timestamptz NOT NULL DEFAULT now()
```

### `publisher_weights`

```text
weight_version integer     PK
publisher_key  text        PK
tier           text        NOT NULL
weight         real        NOT NULL
created_at     timestamptz NOT NULL DEFAULT now()
```

Publisher tier is `cabinet`, `independent`, `sub_office`, or `default`; weight
is between 1 and 10.

## Experiments, ranking, and labels

### Experiment run families

`complex_v1_experiment_runs` and `simple_v1_experiment_runs` have the same
schema but intentionally separate pipelines and foreign-key domains.

```text
id             uuid        PK DEFAULT gen_random_uuid()
name           text        NOT NULL
started_at     timestamptz NOT NULL
finished_at    timestamptz NOT NULL
config         jsonb
cluster_report jsonb
summary        jsonb
cache_hits     integer     NOT NULL DEFAULT 0
cache_misses   integer     NOT NULL DEFAULT 0
created_at     timestamptz NOT NULL DEFAULT now()
```

Run windows are ordered, counts are nonnegative, and the optional JSON objects
have bounded storage sizes.

### Experiment snapshot families

`complex_v1_experiment_cluster_snapshots` references
`complex_v1_experiment_runs`; `simple_v1_experiment_cluster_snapshots`
references `simple_v1_experiment_runs`. Each run has at most one immutable
payload snapshot.

```text
run_id         uuid        PK FK -> matching experiment_runs.id ON DELETE CASCADE
schema_version integer     NOT NULL DEFAULT 1
snapshot       jsonb       NOT NULL
row_counts     jsonb       NOT NULL
note           text
reward         jsonb
is_best        boolean     NOT NULL DEFAULT false
created_at     timestamptz NOT NULL DEFAULT now()
updated_at     timestamptz NOT NULL DEFAULT now()
```

Triggers reject mutation of the captured snapshot payload; annotation fields
remain updateable through namespaced RPCs.

### Rank snapshot families

`rank_snapshots` belongs to `complex_v1_experiment_runs` and
`simple_v1_rank_snapshots` belongs to `simple_v1_experiment_runs`.

```text
run_id            uuid             PK FK -> matching experiment_runs.id ON DELETE CASCADE
facet_type        text             PK
facet_key         text             PK DEFAULT ''
position          integer          PK
storyline_id      uuid             NOT NULL
card_id           uuid             NOT NULL
rank_key          double precision NOT NULL
terms             jsonb            NOT NULL
judged            boolean          NOT NULL
headline          text
summary           text
rubric            jsonb
interest_reason   text
agencies          integer          NOT NULL DEFAULT 0
feeds             integer          NOT NULL DEFAULT 0
entry_count       integer          NOT NULL DEFAULT 0
newest_entry_at   timestamptz
created_at        timestamptz      NOT NULL DEFAULT now()
```

Facet types are `global`, `category`, `theme`, or `agency`; positions are
positive and counts are nonnegative. Storyline and card IDs are snapshot
identifiers rather than foreign keys so experiments remain inspectable after
live clustering state is reset.

### `rank_audit_runs`

Complex-v1 audit metadata and aggregate judge metrics.

```text
id         uuid        PK DEFAULT gen_random_uuid()
run_id     uuid        NOT NULL FK -> complex_v1_experiment_runs.id ON DELETE CASCADE
config     jsonb
metrics    jsonb
created_at timestamptz NOT NULL DEFAULT now()
```

### `rank_audit_pairs`

Pairwise disagreements or confirmations between formula order and an LLM
judge.

```text
id              uuid        PK DEFAULT gen_random_uuid()
run_id          uuid        NOT NULL FK -> complex_v1_experiment_runs.id ON DELETE CASCADE
facet_type      text        NOT NULL
facet_key       text        NOT NULL DEFAULT ''
position_a      integer     NOT NULL
position_b      integer     NOT NULL
storyline_a     uuid        NOT NULL
storyline_b     uuid        NOT NULL
formula_prefers text        NOT NULL DEFAULT 'a'
llm_prefers     text        NOT NULL
llm_reason      text
judge_model     text
prompt_version  integer
sampled_at      timestamptz NOT NULL DEFAULT now()
```

Unique key: `(run_id, facet_type, facet_key, position_a, position_b)`.
`position_a < position_b`; LLM preference is `a`, `b`, or `inconsistent`.

### `topology_label_sets`

Versioned dataset-building sessions for expected storyline/episode topology.

```text
id               uuid        PK DEFAULT gen_random_uuid()
name             text        NOT NULL
labeling_method  text        NOT NULL
labeling_version integer     NOT NULL
parameters       jsonb       NOT NULL DEFAULT '{}'
status           text        NOT NULL DEFAULT 'building'
entry_count      integer     NOT NULL DEFAULT 0
created_at       timestamptz NOT NULL DEFAULT now()
completed_at     timestamptz
```

Statuses are `building`, `complete`, or `superseded`; completion timestamps
must agree with status.

### `news_entry_topology_labels`

Expected cluster identifiers, counts, confidence, and evidence for one entry
inside a label set.

```text
label_set_id                uuid        PK FK -> topology_label_sets.id ON DELETE CASCADE
news_entry_id               uuid        PK FK -> news_entries.id ON DELETE CASCADE
content_hash_at_labeling    text        NOT NULL
proposed_storyline_key      text        NOT NULL
proposed_episode_key        text        NOT NULL
storyline_entry_count       integer     NOT NULL
storyline_episode_count     integer     NOT NULL
episode_entry_count         integer     NOT NULL
topic_category_id           uuid        FK -> topic_categories.id
category_confidence         text
topology_confidence         real
evidence                    jsonb       NOT NULL DEFAULT '{}'
topology_class              text
is_multi_episode_storyline  boolean
is_multi_entry_episode      boolean
created_at                  timestamptz NOT NULL DEFAULT now()
```

The content hash locks the label to a reviewed article revision. Counts must
describe a possible topology; confidence is bounded and evidence is a bounded
JSON object.

## Golden review and enrichment

Golden tables preserve reviewed inputs and a self-contained clustering
snapshot. They are separate from disposable live clustering state.

### `golden_news_entries`

The human-review ledger anchored to canonical `news_entries`.

```text
news_entry_id         uuid        PK FK -> news_entries.id ON DELETE RESTRICT
content_hash_at_review text       NOT NULL
ordinal               integer     NOT NULL UK
batch_number          integer     NOT NULL
review_status         text        NOT NULL DEFAULT 'pending'
gold_episode_id       uuid
gold_episode_label    text
gold_storyline_id     uuid
gold_storyline_label  text
gold_theme_id         uuid
gold_theme_name       text
gold_category_id      uuid
is_syndicated         boolean     NOT NULL DEFAULT false
notes                 text
proposed_at           timestamptz
reviewed_at           timestamptz
created_at            timestamptz NOT NULL DEFAULT now()
updated_at            timestamptz NOT NULL DEFAULT now()
```

Statuses are `pending`, `proposed`, or `reviewed`. Reviewed rows require the
episode, storyline, category, and review timestamp fields; theme ID/name are
both present or both absent. Ordinals and batch numbers are positive, and the
review hash is SHA-256.

### Golden mirror tables

The following tables copy the named live table's columns, defaults, primary
keys, and check constraints documented above:

| Golden table              | Column pattern     | Difference from live table                                          |
| ------------------------- | ------------------ | ------------------------------------------------------------------- |
| `golden_topic_categories` | `topic_categories` | No foreign keys into live state                                     |
| `golden_topic_themes`     | `topic_themes`     | No foreign keys into live state                                     |
| `golden_storylines`       | `storylines`       | No foreign keys into live state                                     |
| `golden_episodes`         | `episodes`         | No foreign keys into live state                                     |
| `golden_event_cards`      | `event_cards`      | Adds `source_run_id uuid NOT NULL`; no foreign keys into live state |

The IDs inside this family still form a logical graph, but PostgreSQL does not
enforce cross-table foreign keys. This is deliberate: importing a reviewed
snapshot must not depend on current live clustering rows. Validate the golden
graph with the curation and database test workflows before publishing it.

### `golden_event_card_article_overviews`

Atomic, reproducible article-level overview enrichment for a golden event
card.

```text
event_card_id          uuid        PK
input_hash             text        NOT NULL
enrichment_version     integer     NOT NULL
source_card_version    integer     NOT NULL
source_entry_ids       uuid[]      NOT NULL
source_content_hashes  text[]      NOT NULL
article_overview       jsonb       NOT NULL
model                  text        NOT NULL
prompt_version         integer     NOT NULL
prompt_hash            text        NOT NULL
generated_at           timestamptz NOT NULL
created_at             timestamptz NOT NULL DEFAULT now()
updated_at             timestamptz NOT NULL DEFAULT now()
```

Input and prompt hashes, and every source content hash, are lowercase SHA-256.
Source ID/hash arrays are nonempty, bounded, aligned, and null-free. Versions
are positive and the overview is a bounded JSON object. Publication is owned
by `publish_golden_event_card_article_overview`.

### `golden_event_card_thumbnails`

Reproducible image metadata and R2 object references for master, card, and
social variants.

```text
event_card_id       uuid        PK
input_hash          text        NOT NULL
enrichment_version  integer     NOT NULL
source_card_version integer     NOT NULL
source_entry_ids    uuid[]      NOT NULL
image_concept       jsonb       NOT NULL
r2_master_key       text        NOT NULL
r2_card_key         text        NOT NULL
r2_social_key       text        NOT NULL
master_sha256       text        NOT NULL
card_sha256         text        NOT NULL
social_sha256       text        NOT NULL
master_mime_type    text        NOT NULL
card_mime_type      text        NOT NULL
social_mime_type    text        NOT NULL
master_width        integer     NOT NULL
master_height       integer     NOT NULL
card_width          integer     NOT NULL
card_height         integer     NOT NULL
social_width        integer     NOT NULL
social_height       integer     NOT NULL
alt_text            text        NOT NULL
focal_x             numeric     NOT NULL
focal_y             numeric     NOT NULL
model               text        NOT NULL
prompt_version      integer     NOT NULL
prompt_hash         text        NOT NULL
generated_at        timestamptz NOT NULL
created_at          timestamptz NOT NULL DEFAULT now()
updated_at          timestamptz NOT NULL DEFAULT now()
```

Hashes are SHA-256; versions and dimensions are positive and bounded; focal
coordinates are between 0 and 1. MIME types are AVIF, JPEG, PNG, or WebP.
Source IDs are nonempty and null-free, R2 keys and alt text are bounded, and
the concept is a bounded JSON object.

## Access summary

All tables above have RLS enabled. The only direct read policy available to a
non-service role is `corpus_read`, which permits `anon` and `corpus_reader` to
select from:

- `news_sources`;
- `news_source_publishers`;
- `news_entries`.

Other relations require explicit service-role grants and, for most writes, a
service-only RPC. See the migration that creates a relation for its exact
grants and the [database guide](README.md#roles-and-row-level-security) for the
role model.
