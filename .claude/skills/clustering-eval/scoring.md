# Scoring Guideline

General scoring rules for the autoresearch loop. The two product axes have
their own authoritative rubric files, which this file does not restate:

- **Themes** (V2, V4, cohesion router) → `theme_scoring.md`
- **Multi-Episode Storylines** (V1, V6, V7, embedding diagnostics) →
  `multi-episode-scoring.md`

Precedence: the axis files win for their vectors; this file wins for
everything cross-cutting (protocol, weighting, reward, scorecard, report);
all three win over the judging prose in
`docs/superpowers/plans/2026-07-18-clustering-eval-loop.md`, which still
owns crawl mechanics (queries, CSV locations, sampling seeds) unless
restated here.

Design principle throughout: **false merges cost double.** A wrong join
(unrelated episode in a chain, intruder or misfit in a theme, different
event in an episode, unsupported claim in an overview) is weighted −2
against +1 for a correct one. The pipeline is split-biased by design; the
score must be too, or the loop will learn to inflate joins.

## Judge protocol — bias isolation (mandatory)

- **Every vector is scored by a judge that is not the experimenter.** The
  experimenter chose the change; it does not grade it.
- **Judge model:** if `ANTHROPIC_API_KEY` is set (in `.env`), judges run as
  Anthropic API calls (latest Claude model; see the `claude-api` skill
  before wiring). Otherwise, spawned subagent judges. Either way the judge
  model must DIFFER from the pipeline's adjudicator/judge models
  (`config.py` — llama-3.3-70b): a judge grading its own model family's
  merge decisions inherits self-preference bias.
- **One judge per vector per crawl** (all cases for that vector batched into
  one dispatch; dispatch the vectors in parallel). Not one judge per case —
  per-case judges lose cross-case consistency and cost 100×.
- **Blinding is the point.** The judge input contains ONLY: the artifact
  data for its vector + that vector's rubric + the CSV output format. NEVER
  include: the hypothesis, the config delta, the iteration number, prior
  scores, which run is baseline vs variant, or any journal content. Planted
  intruder cases (theme_scoring.md V2 Part B) are shuffled in unlabeled.
- Experimenter computes vector scores mechanically from the returned verdict
  CSVs and never edits a verdict. Disagree with a verdict → note it in the
  journal; the verdict stands.
- Judge self-validation: the V2 judge's planted-intruder detection doubles
  as the validity check; corpus discrimination < 0.40 or easy-intruder
  detection < 7/10 → flag every V2/V4 number from that crawl as weak in the
  scorecard notes.

## V3 — categorization (per category↔storyline pair)

**Cases:** every (category, storyline) pair — each live storyline uses its
captured stream `category_id`, including storylines not yet promoted into a
theme. Judged against the FULL live category set (query `topic_categories` fresh — the taxonomy can gain
`origin='llm'` rows mid-loop). Not per theme: a theme can be filed correctly
overall while individual member storylines belong elsewhere; this vector
scores at the storyline grain. (Themes legitimately span categories —
theme_scoring.md; the category is a filing convenience, not a fence.)

Per pair: is the inherited category the **best available option** in the set
for THIS storyline? Best is judged by reader impact, not taxonomy fit alone —
ask: **"if I were a user clicking on a competing category, would I have cared
more to see this storyline there?"** A storyline can be defensible where it
is filed yet land harder for the audience of another category; that is
`better_option_exists`. Prefer the category of the affected domain over a
generalist category describing the government mechanism (an antitrust session
on drug prices belongs to Public Health, not Justice & Law Enforcement).
`correct | better_option_exists (name it) | ambiguous`
(two genuinely defensible). CSV: `category-verdicts.csv`
(`storyline_id,theme_id,filed_category,verdict,suggested_category,reason`;
`theme_id` is blank for an unthemed storyline).

Also: audit every `origin='llm'` category (does a seed category already
cover it?), and report themes whose members split across suggested
categories — cross-reference as a V2 mixed-theme signal.

**Score:** `V3 = (correct + ambiguous) / pairs_judged`. Target ≥ 0.90. Also
report uncategorized rate and unjustified-llm-category count.

## V5 — entity extraction validity

Plan doc mechanics unchanged (deterministic junk sweep of top `entity_stats`
+ 100-entry judged sample, seed 42, stratified by agency). Judge criteria per
token: **salient discriminator for THIS story** — would a human use it to
tell this story apart from other stories that week? Generic nouns, weekdays,
bare geography that half the corpus shares → invalid. Per event_key: real
document/case/docket identifier vs regex artifact.

**Scores:** entity precision = valid/judged (target ≥ 0.80); event-key
validity ≥ 0.95; mean missed-salient-entities per entry; junk-token list
(feeds the tier-2 lexicon lever directly).

## Gold recall (both axes — pending golden dataset)

Every judged vector above audits clusters that exist; none catches the
story that should have joined and didn't. Fragmentation is the split-biased
pipeline's dominant error direction and is measured ONLY against gold
labels: `pipeline/shared/evals.py` (`pairwise_f1`, `b_cubed`) over
`golden_news_entries` (gold_storyline_id / gold_theme_id vs actual
assignments). Until the golden set is populated, every eval report prints
the recall rows as `n/a (no gold labels)` — the empty slot is deliberate;
do not delete it. Low recall = fragmentation; low precision = false merges
(should agree directionally with the judged vectors — divergence means the
judge or the gold labels drifted).

## Attribution ablation (optional, journaled)

A vector score conflates embedding quality with LLM-judge quality. When a
result needs attribution, run the pair: (a) similarity-only attach
(adjudicator forced to accept every candidate the deterministic/embedding
stage surfaces) vs (b) the normal judge-gated path, same corpus, same seed.
Score both crawls; the delta isolates what the judge contributes vs what
candidate generation contributes. Never keep/revert on an ablation run —
it exists to attribute, not to win.

## Reward — the objective

The loop maximizes one scalar (**R_v2** — includes V7 and the V2 intruder
fold-in; NOT comparable to pre-jul19 `reward` scorecard rows):

```
R = (V1 + V2 + V3 + V5 + V6 + V7) / 6  −  0.02 × outstanding_should_merge_pairs
```

- The six judged vector scores enter with equal weight; V4's judged
  duplicates enter as a per-pair penalty (its structural stats are
  diagnostics, not reward).
- The −2 false-merge weighting inside each vector encodes the quality
  tradeoffs; R needs no other balancing terms.
- **R is computed mechanically from the verdict CSVs** — never a judgment
  call.
- **Measurement validity gate:** V2 flagged weak (judge protocol above) →
  that crawl's R cannot be cited as a win; re-crawl with a fresh judge
  before any keep decision.
- **The reward function is not a lever.** This file and the two axis files
  define R; editing them mid-loop is reward hacking, same class as editing
  the eval harness. (Human-directed revisions — like this R_v2 — happen
  between loops, are journaled, and reset scorecard comparability.)

## Per-run eval report (human contract)

Every pipeline run — simplified or complex — ends with
`docs/eval/<run>/eval-report.md`, assembled from the verdict CSVs. It is
written for a human reviewer, not the loop:

- Header: run name, **which pipeline** (simplified | complex), config delta,
  corpus size, judge model.
- One Themes section per `theme_scoring.md` §Report, one Storylines section
  per `multi-episode-scoring.md` §Report, then V3/V5/recall rows.
- **Every metric line carries its interpretation inline**: the value, its
  sample size, what strong means, what weak means, and the first lever to
  pull. A number a human cannot act on from the report alone does not
  belong in the report.
- **Sample sizes are written in units, never a bare `n=`**: "7 joins
  judged", "6 themes + 5 planted intruders", "150 category pairs", "68
  entity tokens". The reader must know what one data point IS without
  consulting the rubric files. (Scorecard CSV columns keep their `*_n`
  names — this rule is for the prose report.)
- Worst-10 exemplar tables (chains, themes) with ids, so a human can spot-
  check any verdict against the artifacts.

## Scorecard

Header (R_v2 era — start a new file or section; old rows are not comparable):

```
iteration,run_id,config_delta,reward_v2,v1_score,v1_n,v1_drift_rate,v1_method_worst,v2_score,v2_n,v2_discrimination,v3_score,v3_n,v4_merge_pairs,v4_singleton_rate,v5_entity_precision,v5_event_key_validity,v6_score,v6_n,v7_score,v7_n,recall_pairwise_f1,notes
```

Every score column reports its `n` sibling; never claim a win the `n` cannot
support (with 3 chains, one flipped verdict moves V1 by ~0.3 — noise, not
signal).

## Keep-rule tie-in

**Keep iff ΔR > q**, where q is the flipped-verdict quantum of the targeted
vector propagated to R: `q = (weight_of_one_flip / n_vector) / 6` (e.g. one
unrelated→related flip in V1 with 20 judged episodes: 3/20/6 = 0.025).
Below q is noise, not signal — revert.

Per-vector targets are **diagnostics, not gates**: use them to pick which
vector to attack (worst headroom first; tie-break V5 → V1 → V6 → V2 → V4 →
V7 → V3 — upstream feeders before downstream consumers). A kept iteration
may trade one vector down for a bigger gain elsewhere — R already prices
that trade; the −2 weighting makes purity-losing trades expensive by
construction.
