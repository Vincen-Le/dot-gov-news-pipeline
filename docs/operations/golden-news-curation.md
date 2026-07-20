# Golden news curation

The golden anchor is the contiguous historical prefix used to warm-start
later event-time experiments. Its fixed input contract is:

```text
2025-07-01T00:00:00Z <= published_at < 2025-09-01T00:00:00Z
order by published_at, news_entries.id
batch size 50
```

The current corpus begins on July 18, so this selects 1,181 entries in 24
chronological batches. Experiments using the completed anchor begin at
September 1. Do not distribute either the anchor or a replay sample across
non-contiguous months.

## Storage boundary

`golden_news_entries` is the durable source of truth. It maps one-to-one to
`news_entries` and stores stable human-reviewed episode, storyline, theme,
and seeded-category assignments. The stable grouping UUIDs deliberately do
not reference `episodes`, `storylines`, or `topic_themes`: those tables are a
disposable workspace and are rebuilt between batches and experiments.

`pipeline golden apply` reconstructs that workspace from reviewed rows using
the entries' current embeddings. This means an embedding-model change does
not invalidate human memberships; it regenerates their centroids in the new
space.

## Initialize once

Apply pending local migrations without resetting the populated database:

```bash
pnpm supabase migration up --local
```

Then initialize the chronological manifest:

```bash
DATABASE_URL='postgresql://postgres:postgres@127.0.0.1:57422/postgres' \
  uv run python -m pipeline.cli golden init
```

Initialization is idempotent. Once rows exist, it reports the existing
manifest instead of silently changing membership after a corpus sync.

## Review loop

Run one batch with the real models:

```bash
DATABASE_URL='postgresql://postgres:postgres@127.0.0.1:57422/postgres' \
  uv run python -m pipeline.cli golden run --batch 1
```

Use `--stub` only for a wiring check; stub labels are not quality proposals.
The command performs four steps:

1. Reset the disposable clustering workspace.
2. Reconstruct all previously reviewed golden rows.
3. Replay exactly the requested pending batch.
4. Capture its proposed hierarchy into `golden_news_entries` and pause.

Inspect the proposal:

```bash
uv run python -m pipeline.cli golden show --batch 1
```

During review, edit the proposed golden columns in local Postgres. Edits may
move an entry by copying an existing stable UUID or by assigning a newly
generated UUID. When changing a group label, update every row carrying that
group UUID so its label and parent remain consistent.

Refresh the dashboard from the corrected proposal without approving it:

```bash
uv run python -m pipeline.cli golden preview
```

The preview reconstructs the disposable cluster tables and deterministic
cards from proposed plus previously reviewed rows. It does not change any
`review_status` value.

Approve only after corrections:

```bash
uv run python -m pipeline.cli golden approve --batch 1
uv run python -m pipeline.cli golden export
uv run python -m pipeline.cli golden run --batch 2
```

Approval fails when an entry lacks any required level, references an
LLM-created rather than seeded category, has stale content, or creates an
episode/storyline/theme with inconsistent parents or labels. Earlier batches
must be reviewed before a later batch can run.

When promoting a QAed experiment image into the full golden render mirror,
record the rank snapshot that produced it:

```bash
uv run python -m pipeline.cli golden promote --source-run <simple_v1-run-uuid>
```

The run must have a global rank snapshot whose card set exactly matches the
live storyline card set. `--source-run` may be omitted when exactly one run
matches. The UUID is stored on `golden_event_cards`, allowing the Ranking tab
to join the durable cards to one canonical `simple_v1_rank_snapshots` run
without exposing experiment selection to the reader.

Useful receipts:

```bash
uv run python -m pipeline.cli golden status
uv run python -m pipeline.cli golden validate
uv run python -m pipeline.cli golden validate --complete
uv run python -m pipeline.cli golden apply
```

`golden export` atomically writes
`docs/eval/golden-news-entries.jsonl`. Export after every approved batch so a
local database reset cannot erase the only copy of human work.

## Anchored experiments

After all 1,181 rows are reviewed and complete validation passes:

```bash
uv run python -m pipeline.cli experiment september-baseline \
  --use-golden \
  --since 2025-09-01T00:00:00Z \
  --limit 500
```

`--use-golden` refuses to run until the entire anchor is reviewed. It resets
and materializes the anchor, then replays the September-forward entries in
event-time order. Omitting `--since` with `--use-golden` defaults it to
September 1.

The curation runner restores the already-reviewed 72-hour replay tail before
each batch. Therefore content duplicates and near-duplicates on either side
of a 50-entry pause behave as they would during one uninterrupted replay.
