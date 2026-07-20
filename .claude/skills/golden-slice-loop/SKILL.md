---
name: golden-slice-loop
description: Use when asked to run the next slice, continue the golden dataset, or advance the simple_v1 curation loop — the recurring 3-day-window cycle of run → eval → human QA → promote → mirror on this repo's spine pipeline.
---

# Golden Slice Loop

One slice = run the simple_v1 (spine) pipeline over the next 3-day window
of `news_entries`, eval it, stop for Vincent's QA, then freeze the QAed
image into the golden tables and mirror to hosted. This file is the
executable runbook; do not re-derive it from the codebase.

**Constants:** DSN `postgresql://postgres:postgres@127.0.0.1:57422/simple_v1_db`
(export per command, NEVER in .env); `LAB_ENGINE=spine`; repo root; hosted
Supabase project `qdqmahimrnwhzdjlcont` (creds in .env). Run names:
`simple-v1-days-NNN-NNN`; next window = last run's `--until` + 3 days
(query `simple_v1_experiment_runs` for the newest run, don't guess).

## 1. Preflight

- `find pipeline spine -name __pycache__ -type d -exec rm -rf {} +` —
  stale bytecode once ran a whole slice with an outdated prompt. Then
  verify any config you changed is live: `uv run python -c "from
  pipeline.shared.config import load_config; print(load_config().prompt_version)"`.
- Coverage: count `news_entries` in window with `embedding is null`; if
  > 0, `pipeline.cli prepare --limit <n>` and re-check until 0.

## 2. Run

```bash
DATABASE_URL=<dsn> LAB_ENGINE=spine uv run python -m pipeline.cli \
  experiment simple-v1-days-NNN-NNN --until <window-end>T23:59:59Z --use-golden
```

Background it (~3s/entry). `--use-golden` = anchored continue: no reset,
replays only unclustered entries, verifies reviewed golden intact.
**Workers AI 429/5xx crash → just relaunch the same command** (safe by
design); if it crashes twice, add backoff to `pipeline/shared/ai.py` first.
Clean finish = `docs/eval/<run>/report.md` exists, its Golden anchor
section says "reviewed entries verified intact", LLM health shows
`model_errors: {}`.

## 3. Mirror ledger + eval

- `node scripts/eval/mirror_experiments_hosted.mjs`
- Invoke the **clustering-eval** skill with run name + run id + DSN, and
  instruct it to judge the **entire cumulative set** (reviewed golden ∪
  new slice), not just new entries. Standing caveats it must carry:
  same-family judge (pipeline sonnet-5 vs eval opus-4-8); judge CSVs need
  format reinforcement + trailing-comma rejoin, and large dispatches drop
  ~2 rows (same-rubric top-up, note the deviation).

## 4. STOP — Vincent's QA

Do not promote, do not touch cluster data until he rules. Present eval
concerns (worst chains, theme misfits, category verdicts) plus a sweep:
uncategorized storylines, aggregate drift, storyline pairs ≥ 0.82 cosine.
He rules item by item; apply surgeries directly in SQL (precedents in
[surgeries.md](surgeries.md) — merge, split, re-home, manual theme;
always `*_method='manual'` + dated reason).

## 5. Promote + mirror

```bash
DATABASE_URL=<dsn> LAB_ENGINE=spine uv run python -m pipeline.cli golden promote
npx supabase db push        # only if new migrations this slice
node scripts/eval/mirror_golden_hosted.mjs
```

Promote failure playbook:
- **"no run matches ranked card set"** — surgery changed the card set:
  `delete from simple_v1_rank_snapshots where run_id='<run-uuid>'`, then
  `pipeline.cli rank snapshot --run <run-uuid>` (the uuid from
  `simple_v1_experiment_runs.id`, never the run name), promote again.
- **"theme X maps to 2 parent values"** — golden requires one category
  per theme; align member categories (reader test) or detach the outlier.
- Promote also *refreshes* derived labels of already-reviewed rows —
  that's expected, it's how surgeries reach gold.

## 6. Close out

Commit only your own files (sibling sessions share this repo — never
`git add -A`; migration timestamps can collide with theirs: check
`ls supabase/migrations` before naming). Update the
`simple-v1-curation-loop` memory. Anchor ends 2025-08-31 — a slice past
Sep 1 needs Vincent's re-init decision first. `reextract` backfill
(extractor v4) pending his call.

## Not part of the loop

No drift-precheck SQL before the run (the run verifies its own anchor);
no `golden export` per slice; no sign-off needed for routine `db push`
of your own slice migrations.
