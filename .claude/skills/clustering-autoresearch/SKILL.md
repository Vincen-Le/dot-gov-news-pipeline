---
name: clustering-autoresearch
description: Use when asked to autonomously run and iterate clustering/aggregation experiments in this repo — overnight tuning runs, threshold sweeps, extraction or prompt changes, "improve clustering quality while I'm gone", or any loop of experiment → evaluate → keep/revert on the episodes/storylines/themes pipeline.
---

# Clustering Autoresearch

Autonomous researcher loop for the aggregation pipeline (entries → episodes → storylines → themes). **The goal is one number: maximize R**, the reward defined in the clustering-eval skill's `scoring.md`. Change one thing, run an experiment, have blinded judges score it, keep iff R rose, repeat until the human stops you.

**REQUIRED BACKGROUND (read before iteration 0):**
- The **clustering-eval skill** (`.claude/skills/clustering-eval/`) — the one-pass scoring machine this loop invokes every iteration. Its directory holds the authoritative rubrics: `scoring.md` (judge protocol, false-merge −2 weighting, V3/V5, gold recall via `pipeline/evals.py`, R_v2, scorecard schema, eval-report contract), `theme_scoring.md` (Themes axis), `multi-episode-scoring.md` (Storylines axis).
- `docs/superpowers/plans/2026-07-18-clustering-eval-loop.md` — crawl mechanics (queries, CSV formats, sampling seeds) and the tuning playbook. Where its judging prose conflicts with `scoring.md`, scoring.md wins. **Its 10-iteration budget does NOT apply here** — this loop is unbounded (see NEVER STOP).
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
3. **Bench idle check**: record the newest `public.complex_v1_experiment_runs` row. If a run you didn't start appears mid-loop, STOP and tell the human. Never run two experiments concurrently.
4. **Corpus ready**: entries synced (`pipeline.cli sync`) and featured (`pipeline.cli prepare`). If not, do that once first.
5. **Ledger**: ensure `docs/eval/loop/scorecard.csv` (header per the eval-loop plan) and `docs/eval/loop/journal.md` exist. Both stay untracked by the experiment commits' subject matter but ARE committed — they're the deliverable.
6. **Baseline first**: iteration 0 is always the unmodified config:
   ```bash
   TOPICS_ENABLED=true DATABASE_URL=... uv run python -m pipeline.cli experiment <tag>-00-baseline --out docs/eval
   ```
   Full seven-vector crawl (blinded judges, `scoring.md`), scorecard row, journal entry. Nothing is tuned yet.

## What you CAN change

- **Tier 1 (free)** — env knobs on the `experiment` command. The complete wired list (`pipeline/config.py`): `NEAR_DUP_THRESHOLD`, `CLUSTER_JOIN_THRESHOLD`, `AMBIENT_EMA_CEILING`, `EPISODE_DORMANCY_HOURS`, `DEDUPE_WINDOW_HOURS`, `TAU_SECONDS`, `THEME_SIM_FLOOR`, `THEME_STICK_FLOOR`, `THEME_KNN_K`, plus model/version keys. **A knob not in `load_config()` does not exist** — e.g. `STORYLINE_SIM_FLOOR` appears in older docs AND the operator harness `--set` whitelist (evaluation-harness runbook), but `load_config()` never reads it; setting it is a silent no-op. Verify in `pipeline/config.py` before sweeping anything.
- **Tier 2 (free, no LLM)** — `pipeline/extraction.py` changes: bump `EXTRACTOR_VERSION`, `uv run pytest tests/test_extraction.py` green, `pipeline.cli reextract` once, then `experiment`.
- **Tier 3 (moderate LLM cost)** — prompt changes in `pipeline/prompts.py`: bump `PROMPT_VERSION`; affected calls miss cache.
- **Clustering logic** — `pipeline/episodes.py`, `pipeline/storylines.py`, `pipeline/topics.py`: tests green before the run.
- **Tier 4a (enrichment strategy — allowed, bounded subset only)** — how entry text is enriched before embedding: the enricher prompt (`build_enricher_prompt` in `pipeline/prompts.py`, bump `ENRICHER_VERSION`), embed-text composition (`_semantic_content` / `_fallback_text` / the `embed_texts` line in `pipeline/runner.py`), or `ENRICHMENT_ENABLED` on/off. The enriched text IS the embed text, so these change the vector space. Protocol (runbook "Feature and model A/B runs", direct sequence):
  ```bash
  uv run python -m pipeline.cli reset --features
  ENRICHER_VERSION=<n> uv run python -m pipeline.cli prepare --limit 1000
  TOPICS_ENABLED=true ENRICHER_VERSION=<n> uv run python -m pipeline.cli experiment <tag>-NN-<slug> --limit 1000 --out docs/eval
  ```
  Rules: (1) **`reset --features` is mandatory** — `prepare` skips any row that already has `enriched_text` (`pipeline/runner.py` `enrich_one`), so a version bump alone silently re-embeds nothing. (2) Bound `prepare` with `--limit`/`--per-agency`; never unbounded, and never via `pnpm ops lab run --clear-features` (whole-corpus). (3) Feature space changed → prior scorecard rows are NOT comparable; a fair A/B is two bounded prepares on the identical selection contract — incumbent enrichment first (reset → prepare → `experiment <tag>-NN-enrich-base`), then reset again and prepare the variant — and you compare only within that pair/series. (4) Same env on `prepare` and `experiment`. (5) Expect decision-cache misses (adjudicator keys on content). (6) `reset --features` wipes features for the whole local corpus — note in the journal that a full re-prepare is owed before non-tier-4a iterations resume.

## What you CANNOT do

- **`EMBEDDING_MODEL` / `ENRICHER_MODEL` swaps without explicit human opt-in** (tier 4b): new model = new vector space + real API cost across the corpus. Log the idea in the journal as `blocked-tier4` and move on.
- **`--stub`**: stub embeddings make every quality vector meaningless. Never, in this loop.
- **Modify the reward function or eval harness**: the clustering-eval skill's rubrics (`.claude/skills/clustering-eval/scoring.md`, `theme_scoring.md`, `multi-episode-scoring.md` — the rubrics and R formula), `pipeline/evals.py`, `pipeline/experiment.py` summarize/report, the judging rules in the eval-loop plan, `docs/eval/labels.csv`. R is ground truth; changing how R is measured to make R go up is reward hacking, not research. If the rubric seems wrong, journal it for the human.
- **Direct SQL writes or hosted DB**: the CLI owns all mutation; the pipeline is local-DSN-guarded — don't fight the guard.
- **Change two things at once**: one knob OR one code change per iteration. Attribution dies otherwise.

## The loop

LOOP UNTIL INTERRUPTED:

1. Read the scorecard; pick the vector with the most reward headroom (targets in the scoring files are diagnostics for this choice, not gates; tie-break V5 → V1 → V6 → V2 → V4 → V7 → V3; if a vector fails to move R 2 iterations running, attack the next one).
2. Journal the hypothesis BEFORE changing anything: iteration, vector, exact change, expected effect, cost tier.
3. Apply exactly one change. Code changes: tests green, then commit on the branch.
4. Run, redirected — never let output flood context:
   ```bash
   TOPICS_ENABLED=true <KNOB=value> DATABASE_URL=... \
     uv run python -m pipeline.cli experiment <tag>-NN-<slug> --out docs/eval > run.log 2>&1
   ```
   Name encodes the change (`jul18-03-join-0.82`). Read results from `docs/eval/<name>/report.md` + the crawl, not the log. If the run fails, `tail -n 50 run.log`, then the runbook's Troubleshooting section (`docs/operations/evaluation-harness.md`); dumb bug → fix and re-run; broken idea → journal `crash`, revert, move on. A run past ~30 min with no progress: kill, treat as crash; interrupted replays leave partial derived state — the next `experiment` resets it.
5. Score the run via the **clustering-eval skill** — one full pass (artifact export → seven parallel blinded judges → `docs/eval/<name>/eval/score.json` + `eval-report.md`). Judges get artifact data + rubric ONLY, never the hypothesis or config delta; artifact IDs change every replay — never carry verdicts over. The eval skill stops at the report; ledger writes are THIS loop's job, tied to the experiment run:
   - append the scorecard row from score.json (the `run_id` column comes from `eval/artifacts/metadata.json`);
   - stamp the reward onto the artifact metadata's exact run UUID so the DB row carries its score: `uv run python scripts/eval/score_run.py --pipeline complex_v1 --verdicts ... --artifacts ... --write-reward` (add `--best` when a kept iteration becomes the new best — it clears the previous best flag);
   - journal entry. Compute vector scores mechanically from the verdict CSVs; append the scorecard row.
6. Compute R (formula in `scoring.md`, mechanical). **Keep iff ΔR exceeds the flipped-verdict quantum** — R strictly up beyond noise, nothing else to weigh (the −2 false-merge weighting inside the vectors already prices every tradeoff). Keep → branch advances (commit stays). Revert → drop the env var (tier 1) or revert ONLY the files the iteration touched (`git checkout <commit>~1 -- <files>` or `git revert`) — never `git reset --hard` if the tree carries pre-existing uncommitted work you didn't create. Journal the numbers either way.
7. Go to 1.

**Simplicity criterion** (carried from autoresearch): equal metrics + less code = keep. Small gain + hacky complexity = discard. A deletion that holds the line is a win.

**NEVER STOP.** The human may be asleep. There is no "done" — R has no ceiling worth declaring victory at; targets are diagnostics, not a finish line. Out of ideas? Re-read the experiment spec's catalog, mine `.cache/decisions.sqlite` verdicts for calibration signal, combine previous near-misses, try the next tier-1 sweep, hunt simplification wins (equal R, less code = keep). Do not ask "should I continue?" — the loop ends when the human ends it. When R plateaus (no kept iteration in ~5 attempts), run a `<tag>-checkpoint` verification (fresh run of best config, full crawl, R reproduces within quantum, `uv run pytest` green), refresh `docs/eval/loop/final-report.md`, then keep going.

## Red flags — STOP, you're rationalizing

| Thought | Reality |
|---|---|
| "Stub run just to iterate faster" | Stub metrics are noise. You'd keep/revert on garbage. |
| "These two knobs are related, sweep both" | Attribution dies. One per iteration. |
| "Skip the crawl, the report totals look better" | Attach mixes can't say a change *helped*. Judge the artifacts. |
| "Reuse yesterday's verdicts, artifacts barely changed" | IDs change every replay. Fresh crawl, every time. |
| "Just swap the embedding model — it's clearly the fix" | Model swaps (4b) are human-opt-in. Enrichment-strategy changes (4a) are your lever — bounded subset, fresh in-series baseline. |
| "Bumped ENRICHER_VERSION, re-ran prepare, done" | Prepare skips rows with existing `enriched_text`. Without `reset --features` you re-embedded nothing. |
| "Compare the new enrichment run to last week's baseline" | Different feature space. Only in-series comparisons on the identical subset count. |
| "Good stopping point, I'll check in" | The human is asleep. Loop. |
| "The knob is in the docs, so it must work" | Docs drift. `load_config()` is the truth. |
| "Faster to judge the artifacts myself" | You made the change; you don't grade it. Blinded subagent judges, every crawl. |
| "The judge needs context — tell it what I changed" | That's the bias the protocol isolates. Judges get artifacts + rubric, nothing else. |
| "Judge got this verdict wrong, I'll fix the CSV" | Verdicts stand. Disagreement goes in the journal. |
| "The rubric under-counts my win — tweak scoring.md" | That's reward hacking. The reward function is frozen; journal the critique for the human. |
