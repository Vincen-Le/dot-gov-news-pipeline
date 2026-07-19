---
name: clustering-autoresearch
description: Use when asked to autonomously run and iterate clustering/aggregation experiments in this repo — overnight tuning runs, threshold sweeps, extraction or prompt changes, "improve clustering quality while I'm gone", or any loop of experiment → evaluate → keep/revert on the episodes/storylines/themes pipeline.
---

# Clustering Autoresearch

Autonomous researcher loop for the aggregation pipeline (entries → episodes → storylines → themes). Change one thing, run an experiment, judge the artifacts, keep or revert, repeat until the human stops you.

**REQUIRED BACKGROUND (read before iteration 0):**
- `docs/superpowers/plans/2026-07-18-clustering-eval-loop.md` — the five evaluation vectors, targets, scorecard schema, and tuning playbook. That doc is the metric; this skill is the loop. **Its 10-iteration budget does NOT apply here** — this loop is unbounded (see NEVER STOP).
- `docs/operations/clustering-experimentation-spec-2026-07-18.md` — ranked experiment catalog (your idea backlog).
- `docs/operations/clustering-lab.md` — lab/CLI mechanics (quick guide).
- `docs/operations/evaluation-harness.md` — full harness runbook. Consult it when you need: guard coverage (only `sync`/`reset`/`experiment` are local-DSN-guarded — `prepare`/`reextract`/`cluster`/`rank` are not, and `rank fit --write` is a real DB write), cache policy and `--no-cache`, topology-curated datasets, run-name rules, report-section interpretation, and the Troubleshooting/recovery section when a run fails or leaves partial state.

## Setup

1. **Run tag + branch**: propose a tag from today's date (e.g. `jul18`). `git checkout -b autoresearch/<tag>` from main — the branch must not already exist. All kept code changes commit here; main stays clean overnight.
2. **Environment**: local Supabase on port **57422**. Export per command, never in `.env` (breaks `tests/test_cache.py`):
   ```bash
   export DATABASE_URL='postgresql://postgres:postgres@127.0.0.1:57422/postgres'
   ```
   No `psql` on this machine — reads go through `pipeline.db.Db` one-liners.
3. **Bench idle check**: record the newest `public.experiment_runs` row. If a run you didn't start appears mid-loop, STOP and tell the human. Never run two experiments concurrently.
4. **Corpus ready**: entries synced (`pipeline.cli sync`) and featured (`pipeline.cli prepare`). If not, do that once first.
5. **Ledger**: ensure `docs/eval/loop/scorecard.csv` (header per the eval-loop plan) and `docs/eval/loop/journal.md` exist. Both stay untracked by the experiment commits' subject matter but ARE committed — they're the deliverable.
6. **Baseline first**: iteration 0 is always the unmodified config:
   ```bash
   TOPICS_ENABLED=true DATABASE_URL=... uv run python -m pipeline.cli experiment <tag>-00-baseline --out docs/eval
   ```
   Full five-vector crawl, scorecard row, journal entry. Nothing is tuned yet.

## What you CAN change

- **Tier 1 (free)** — env knobs on the `experiment` command. The complete wired list (`pipeline/config.py`): `NEAR_DUP_THRESHOLD`, `CLUSTER_JOIN_THRESHOLD`, `AMBIENT_EMA_CEILING`, `EPISODE_DORMANCY_HOURS`, `DEDUPE_WINDOW_HOURS`, `TAU_SECONDS`, `THEME_SIM_FLOOR`, `THEME_STICK_FLOOR`, `THEME_KNN_K`, plus model/version keys. **A knob not in `load_config()` does not exist** — e.g. `STORYLINE_SIM_FLOOR` appears in older docs AND the operator harness `--set` whitelist (evaluation-harness runbook), but `load_config()` never reads it; setting it is a silent no-op. Verify in `pipeline/config.py` before sweeping anything.
- **Tier 2 (free, no LLM)** — `pipeline/extraction.py` changes: bump `EXTRACTOR_VERSION`, `uv run pytest tests/test_extraction.py` green, `pipeline.cli reextract` once, then `experiment`.
- **Tier 3 (moderate LLM cost)** — prompt changes in `pipeline/prompts.py`: bump `PROMPT_VERSION`; affected calls miss cache.
- **Clustering logic** — `pipeline/episodes.py`, `pipeline/storylines.py`, `pipeline/topics.py`: tests green before the run.

## What you CANNOT do

- **Tier 4 without explicit human opt-in**: `EMBEDDING_MODEL` / `ENRICHMENT_ENABLED` / `ENRICHER_MODEL` changes re-embed ~9.6k entries. Log the idea in the journal as `blocked-tier4` and move on.
- **`--stub`**: stub embeddings make every quality vector meaningless. Never, in this loop.
- **Modify the eval harness**: `pipeline/experiment.py` summarize/report, the judging rules in the eval-loop plan, `docs/eval/labels.csv`. The metric is ground truth; if the metric seems wrong, journal it for the human.
- **Direct SQL writes or hosted DB**: the CLI owns all mutation; the pipeline is local-DSN-guarded — don't fight the guard.
- **Change two things at once**: one knob OR one code change per iteration. Attribution dies otherwise.

## The loop

LOOP UNTIL INTERRUPTED:

1. Read the scorecard; pick the worst vector vs target (tie-break V5 → V1 → V2 → V4 → V3; if a vector fails to improve 2 iterations running, move to the next-worst).
2. Journal the hypothesis BEFORE changing anything: iteration, vector, exact change, expected effect, cost tier.
3. Apply exactly one change. Code changes: tests green, then commit on the branch.
4. Run, redirected — never let output flood context:
   ```bash
   TOPICS_ENABLED=true <KNOB=value> DATABASE_URL=... \
     uv run python -m pipeline.cli experiment <tag>-NN-<slug> --out docs/eval > run.log 2>&1
   ```
   Name encodes the change (`jul18-03-join-0.82`). Read results from `docs/eval/<name>/report.md` + the crawl, not the log. If the run fails, `tail -n 50 run.log`, then the runbook's Troubleshooting section (`docs/operations/evaluation-harness.md`); dumb bug → fix and re-run; broken idea → journal `crash`, revert, move on. A run past ~30 min with no progress: kill, treat as crash; interrupted replays leave partial derived state — the next `experiment` resets it.
5. Re-crawl ALL five vectors fresh (artifact IDs change every replay — never carry verdicts over; judge from artifact content only). Append the scorecard row.
6. **Keep** iff the targeted metric improved beyond sample noise AND no other vector regressed past its target (always report `n` — tiny chain counts move purity in huge quanta). Keep → branch advances (commit stays). Revert → drop the env var (tier 1) or revert ONLY the files the iteration touched (`git checkout <commit>~1 -- <files>` or `git revert`) — never `git reset --hard` if the tree carries pre-existing uncommitted work you didn't create. Journal the numbers either way.
7. Go to 1.

**Simplicity criterion** (carried from autoresearch): equal metrics + less code = keep. Small gain + hacky complexity = discard. A deletion that holds the line is a win.

**NEVER STOP.** The human may be asleep. Out of ideas? Re-read the experiment spec's catalog, mine `.cache/decisions.sqlite` verdicts for calibration signal, combine previous near-misses, try the next tier-1 sweep. Do not ask "should I continue?" — the loop ends when the human ends it. If all targets are met, run `<tag>-final` verification (fresh run, full crawl, reproduce within noise, `uv run pytest` green), write `docs/eval/loop/final-report.md`, then keep hunting for simplification wins.

## Red flags — STOP, you're rationalizing

| Thought | Reality |
|---|---|
| "Stub run just to iterate faster" | Stub metrics are noise. You'd keep/revert on garbage. |
| "These two knobs are related, sweep both" | Attribution dies. One per iteration. |
| "Skip the crawl, the report totals look better" | Attach mixes can't say a change *helped*. Judge the artifacts. |
| "Reuse yesterday's verdicts, artifacts barely changed" | IDs change every replay. Fresh crawl, every time. |
| "Just this once, re-embed — it's clearly the fix" | Tier 4 is human-opt-in. Journal it, move on. |
| "Good stopping point, I'll check in" | The human is asleep. Loop. |
| "The knob is in the docs, so it must work" | Docs drift. `load_config()` is the truth. |
