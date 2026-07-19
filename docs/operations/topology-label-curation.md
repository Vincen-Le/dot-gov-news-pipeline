# Topology-label curation

Topology labels are provisional, versioned annotations beside `news_entries`.
They do not modify raw entry content or the production clustering columns.

## Data model

`topology_label_sets` records the method, version, parameters, completion state,
and corpus coverage for each labeling pass. Only `complete` sets are eligible
for experiment curation.

`news_entry_topology_labels` stores one row per entry and label set:

- `proposed_storyline_key` and `proposed_episode_key` keep estimated groups
  together.
- `content_hash_at_labeling` prevents stale labels from being sampled after an
  entry's raw content changes.
- `storyline_entry_count` and `storyline_episode_count` identify continuing
  stories.
- `episode_entry_count` identifies episodes covered by multiple entries.
- `topology_class` is generated as `multi_episode_storyline`,
  `multi_entry_single_episode`, or `singleton_episode_storyline`.
- `is_multi_entry_episode` is a separate generated flag because a multi-entry
  episode can also occur inside a multi-episode storyline.
- Optional seeded-category and confidence fields support narrower curation.

The tables use RLS. The service role can read them but cannot write them
directly; publishing goes through bounded, service-only RPCs. Completion checks
that every stored storyline and episode count matches the actual label rows.

## Publish a label set

The audit remains read-only unless `--publish` is explicitly supplied. Strict
labels are the recommended high-precision starting point:

```bash
.venv/bin/python scripts/audit-news-corpus.py \
  --mode strict \
  --publish \
  --publish-target local \
  --label-set-name corpus-topology-strict \
  --labeling-version 1
```

Publishing writes only `topology_label_sets` and
`news_entry_topology_labels`. It does not enrich entries, create embeddings,
run the aggregation pipeline, or modify `news_entries`.

`local` publishes to `DATABASE_URL`, falling back to the repository's local
Supabase port. Use `--publish-target hosted` only after the topology migration
has reached the hosted project.

List complete sets:

```sql
select id, name, labeling_version, entry_count, parameters, completed_at
from public.topology_label_sets
where status = 'complete'
order by completed_at desc;
```

## Run a topology-curated aggregation experiment

The following replay requests 1,000 entries with 40% from complete
multi-episode storylines, 5% from multi-entry single-episode storylines, and
the remaining 55% from singleton episode/storylines:

```bash
.venv/bin/python -m pipeline.cli experiment topology-40-5-55 \
  --limit 1000 \
  --topology-label-set LABEL_SET_UUID \
  --multi-episode-percent 40 \
  --multi-entry-single-episode-percent 5 \
  --topology-seed topology-40-5-55
```

For 40% multi-episode entries and 60% singleton entries, omit the multi-entry
option:

```bash
.venv/bin/python -m pipeline.cli experiment topology-40-0-60 \
  --limit 1000 \
  --topology-label-set LABEL_SET_UUID \
  --multi-episode-percent 40 \
  --topology-seed topology-40-0-60
```

No training/test split is created. The labels only select the replay corpus for
aggregation evaluation.

The curator is deterministic for a given label set and seed. It always keeps a
selected estimated storyline intact. Because storylines contain different
numbers of entries, a requested non-singleton percentage can have a small
packing shortfall; the function fills that shortfall with singleton entries so
the dataset has exactly `--limit` rows. The experiment report records both the
requested mix and actual expected-label counts.

## Query the orthogonal episode dimension

To inspect entries expected to belong to multi-entry episodes, including those
inside multi-episode storylines:

```sql
select labels.*, entries.title, entries.published_at
from public.news_entry_topology_labels labels
join public.news_entries entries on entries.id = labels.news_entry_id
where labels.label_set_id = 'LABEL_SET_UUID'
  and labels.is_multi_entry_episode
order by labels.proposed_storyline_key,
         labels.proposed_episode_key,
         entries.published_at;
```

The same fields can support a future episode-density sampler without changing
or relabeling the corpus.

## Interpretation

These labels bootstrap focused experiments; they are not adjudicated ground
truth. A run using the same rules to generate labels and score output would
measure agreement with the labeling heuristic. Use strict labels for
high-precision selection, balanced labels for broader exploratory coverage,
and review representative disagreements when judging aggregation quality.
