# Scoring Guideline

Authoritative scoring rubric for the autoresearch loop. Where this conflicts
with the judging prose in `docs/superpowers/plans/2026-07-18-clustering-eval-loop.md`,
THIS file wins; the plan doc still owns crawl mechanics (queries, CSV
locations, sampling seeds) unless restated here.

Design principle throughout: **false merges cost double.** A wrong join
(unrelated episode in a chain, intruder in a theme, different event in an
episode) is weighted −2 against +1 for a correct one. The pipeline is
split-biased by design; the score must be too, or the loop will learn to
inflate joins.

## Judge protocol — bias isolation (mandatory)

- **Every vector is scored by a spawned subagent judge, never by the
  experimenter.** The experimenter chose the change; it does not grade it.
- **One judge subagent per vector per crawl** (all cases for that vector
  batched into one dispatch; dispatch the six in parallel). Not one subagent
  per case — per-case judges lose cross-case consistency and cost 100×.
- **Blinding is the point.** The judge prompt contains ONLY: the artifact
  data for its vector + that vector's rubric below + the CSV output format.
  NEVER include: the hypothesis, the config delta, the iteration number,
  prior scores, which run is baseline vs variant, or any journal content.
- Experimenter computes vector scores mechanically from the returned verdict
  CSVs and never edits a verdict. Disagree with a verdict → note it in the
  journal; the verdict stands.
- Judge self-validation: the V2 judge also runs the 10-theme intruder test
  (plan doc rules); < 7/10 detected → flag every V2/V4 number from that crawl
  as weak in the scorecard notes.

## V1 — storyline chain coherence

**Cases:** every multi-episode storyline (no sampling; report `n_chains`,
`n_episodes_judged`).

**Per non-anchor episode: `related y/n`** to the chain's event thread.
Criteria:
- Related = same real-world event thread evolving over time — not merely same
  topic, same agency, or same program.
- **Entities are primary evidence when present.** Differing key
  discriminators mean different events even when text reads similar: same
  hazard type but locations genuinely far apart (two wildfires, two states);
  same policy action but different subjects (drug recall, different drugs);
  different docket/case/contract numbers. Shared rare entities + temporal
  continuity → related.
- Uncertain after entity check → `n` (split bias).

**Score:** `V1 = (Σ related − 2·Σ unrelated) / Σ judged` over all chains
(range −2..1). Target ≥ 0.70 (equivalent to old 0.90 purity under the
weighting). Also report per-`attach_method` precision (worst-method target
unchanged: ≥ 0.75) and per-chain scores so one rotten chain is visible.

## V2 — theme score (membership + granularity, per theme)

**Cases:** every live theme (`merged_into is null`).

**Part A — membership.** Per member storyline: `fits y/n` under the theme
label. Fit is a real relationship judgment, not a keyword match: does this
storyline belong to the thread/subject the theme names — would a reader
following this theme expect this storyline in it? The entity gate is
necessary but NOT sufficient: entity-named theme → member's
entity_set/headline must mention that entity (violation = automatic `n`),
but passing the gate does not establish fit — an FDA-named theme about drug
recalls does not fit an FDA staffing storyline.

**Part B — granularity (holistic, after Part A).** Judge the theme as a
whole: `right | too_granular | too_broad`.
- **too_granular test (the generalization probe):** rewrite the theme label
  one abstraction level up — drop an adjective, drop a location qualifier,
  widen the scope one notch (e.g. "California EPA Diesel Emission Waivers" →
  "EPA Emission Waivers"). Then re-run the Part A fits judgment under the
  lifted label over the SAME evaluation set (all live storylines, including
  those currently in other themes or unattached). If the yes-count strictly
  grows without admitting unrelated storylines → `too_granular`; record the
  generalized label + the members it would gain.
- **too_broad:** members span ≥ 2 distinct threads a reader would never
  browse together → name the split.

**Score per theme:** `(fits − 2·misfits) / members`, then −0.25 if
`too_granular` or `too_broad`. `V2 = mean over themes` (report `n_themes`,
`n_members_judged`). Target ≥ 0.50. Misfit penalty already punishes
over-broad themes, granularity penalty punishes fragmentation — the score is
symmetric; do not chase it by merging everything into megathemes (misfits
explode) or splitting everything (granularity penalty + V4 catches it).

## V3 — categorization (per category↔storyline pair)

**Cases:** every (category, storyline) pair — each live storyline inherits
its category through its theme's `category_id`. Judged against the FULL live
category set (query `topic_categories` fresh — the taxonomy can gain
`origin='llm'` rows mid-loop). Not per theme: a theme can be filed correctly
overall while individual member storylines belong elsewhere; this vector
scores at the storyline grain.

Per pair: is the inherited category the **best available option** in the set
for THIS storyline? `correct | better_option_exists (name it) | ambiguous`
(two genuinely defensible). CSV:
`category-verdicts.csv` (`storyline_id,theme_id,filed_category,verdict,suggested_category,reason`).

Also: audit every `origin='llm'` category (does a seed category already
cover it?), and report themes whose members split across suggested
categories — that split is a V2 mixed-theme signal, cross-reference it.

**Score:** `V3 = (correct + ambiguous) / pairs_judged`. Target ≥ 0.90. Also
report uncategorized rate (storylines whose theme has no category) and
unjustified-llm-category count.

## V4 — cross-theme duplicates + structure

Judged granularity of a single theme lives in V2; V4 is the cross-theme view.
- **Merge candidates:** theme pairs with centroid cosine ≥ 0.75 (unpack via
  `pipeline.vectors`) or same category + shared distinctive name token. Judge
  each: should-merge y/n, applying the V2 generalization probe to the pair.
- **Structural stats (free, no judge):** singleton-theme rate,
  members-per-theme histogram, themes-per-category distribution.

**Targets:** 0 outstanding should-merge pairs; singleton-theme rate
directional ↓ without V2 falling.

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

## V6 — episode coherence (within-episode, NEW)

Episodes are same-event clusters; nothing judged them until now.

**Cases:** multi-entry episodes. All of them if ≤ 50; else stratified sample
of 50 by entry_count band, `random.Random(42)`.

**Per non-anchor entry: `same_event y/n`** vs the episode's anchor entry.
Criteria mirror V1 but at event grain, entity-first:
- Same event reported/syndicated differently (near-dup, cross-agency mirror,
  GovDelivery repost) → `y`.
- Same *kind* of event, different discriminating entities → `n`: same fire
  season but locations far apart; same recall program but different drugs;
  same grant program but different recipients/rounds.
- Follow-up coverage of a developing event within the episode window → `y`
  (that is what episodes are); a NEW development that should have opened a
  new episode in the chain → `n`.

**Score:** `V6 = (Σ same − 2·Σ different) / Σ judged`. Target ≥ 0.70.
CSV: `episode-verdicts.csv` (`episode_id,entry_id,same_event,reason`) in the
iteration dir.

## Reward — the objective

The loop maximizes one scalar:

```
R = (V1 + V2 + V3 + V5 + V6) / 5  −  0.02 × outstanding_should_merge_pairs
```

- The five judged vector scores enter with equal weight; V4's judged
  duplicates enter as a per-pair penalty (its structural stats are
  diagnostics, not reward).
- The −2 false-merge weighting inside each vector is what encodes the
  quality tradeoffs; R needs no other balancing terms.
- **R is computed mechanically from the verdict CSVs** — a one-liner the
  experimenter runs, never a judgment call.
- **Measurement validity gate:** if the V2 intruder test scores < 7/10, that
  crawl's R cannot be cited as a win — re-crawl with a fresh judge before
  any keep decision.
- **The reward function is not a lever.** This file defines R; editing it
  mid-loop is reward hacking, same class as editing the eval harness.

## Scorecard

Header (replaces the plan doc's):

```
iteration,run_id,config_delta,reward,v1_score,v1_n,v1_method_worst,v2_score,v2_n,v3_score,v3_n,v4_merge_pairs,v4_singleton_rate,v5_entity_precision,v5_event_key_validity,v6_score,v6_n,intruder_detection,notes
```

Every score column reports its `n` sibling; never claim a win the `n` cannot
support (with 3 chains, one flipped verdict moves V1 by ~0.3 — that is noise,
not signal).

## Keep-rule tie-in

**Keep iff ΔR > q**, where q is the flipped-verdict quantum of the targeted
vector propagated to R: `q = (weight_of_one_flip / n_vector) / 5` (e.g. one
unrelated→related flip in V1 with 20 judged episodes: 3/20/5 = 0.03). Below
q is noise, not signal — revert.

Per-vector targets are **diagnostics, not gates**: use them to pick which
vector to attack (worst headroom first; tie-break V5 → V1 → V6 → V2 → V4 →
V3 — upstream feeders before downstream consumers). A kept iteration may
trade one vector down for a bigger gain elsewhere — R already prices that
trade; the −2 weighting makes purity-losing trades expensive by
construction.
