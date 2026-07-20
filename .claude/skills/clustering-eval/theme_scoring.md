# Theme Scoring

Authoritative rubric for the **Themes axis** (V2 membership/granularity, V4
cross-theme structure). General rules that apply to every vector — judge
protocol, blinding, false-merge weighting, reward assembly, report format —
live in `scoring.md` and are not restated here.

Purpose reminder for judges and levers alike: dynamic themes exist to detect
patterns the seeded category labels do NOT capture. **A theme spanning
storylines from multiple categories is legitimate, not a defect.** Never
penalize cross-category membership as such; penalize incoherence.

## V2 — theme score (membership + intruders + granularity, per theme)

**Cases:** every live theme (`merged_into is null`).

### Part A — membership

Per member storyline: `fits 1/0` under the theme label + its
`inclusion_criterion`. Fit is a real relationship judgment, not a keyword
match: does this storyline belong to the thread/subject the theme names —
would a reader following this theme expect this storyline in it? The entity
gate is necessary but NOT sufficient: entity-named theme → member's
entity_set/headline must mention that entity (violation = automatic `0`),
but passing the gate does not establish fit — an FDA-named theme about drug
recalls does not fit an FDA staffing storyline.

### Part B — intruder discrimination

Purity alone rewards vacuous themes ("National Park Events" accepts
everything). So every theme is also probed with planted non-members:

- Per theme, sample `K = min(members, 5)` intruder storylines from the FULL
  live corpus (not same-category — themes are cross-category): the nearest
  non-member storylines by centroid cosine (hard negatives) topped up with
  uniform-random non-members, seed 42.
- Intruders are shuffled in with real members in the judge dispatch; the
  judge sees one flat storyline list per theme and never learns which are
  planted. Same `fits 1/0` question.
- `intruder_accepted` = planted storyline judged `fits=y`.

Report per theme and corpus-wide: `discrimination = fit_rate −
intruder_accept_rate`. A high-purity theme with discrimination near 0 is a
generic label, not a good cluster.

### Part C — granularity (holistic, after A/B)

Verdict per theme: `right | too_granular | too_broad`. The naive "does the
score improve one level up" test is broken by construction — a broader label
is a semantic superset, so fit-rate is monotonically ≥ the original. The
probe is therefore **asymmetric**:

- **Probe label:** the theme label rewritten one abstraction level up (drop
  an adjective/location qualifier, widen one notch: "California EPA Diesel
  Emission Waivers" → "EPA Emission Waivers"). Generated ONCE per theme per
  crawl by the artifact-export step (not by the judge mid-verdict) and
  recorded in the artifact, so verdicts are reproducible.
- **(a) recall gain:** re-run Part A fits under the probe label over ALL
  live storylines (including those in other themes or unattached). Count
  storylines that would newly join.
- **(b) precision loss:** re-run Part B intruder rejection under the probe
  label. Count intruders that flip to accepted.
- `too_granular` iff (a) > 0 AND (b) == 0 — the lift gains real members
  without admitting junk. Record the probe label + gained members.
- `too_broad`: members span ≥ 2 distinct threads a reader would never browse
  together → name the split.

### Score

Per theme, intruder acceptances are false merges and carry the −2 weight:

```
theme_score = (fits − 2·misfits − 2·intruders_accepted) / (members + intruders_planted)
              − 0.25 if too_granular or too_broad
V2 = mean over themes        (report n_themes, n_members_judged, n_intruders)
```

Target ≥ 0.50. Also report `v2_discrimination` (corpus mean) in the
scorecard; < 0.40 flags the crawl's V2 as weak regardless of the score.

## V4 — cross-theme duplicates + structure

Judged granularity of a single theme lives in V2; V4 is the cross-theme view.

- **Merge candidates:** theme pairs with centroid cosine ≥ 0.75 (unpack via
  `pipeline.shared.vectors`) or shared distinctive name token (corpus-wide — do NOT
  scope the token heuristic to same-category; themes cross categories).
  Judge each: should-merge 1/0, applying the V2 probe-label test to the pair.
- **Threshold audit (retroactive, every run):** log the centroid-cosine
  histogram of all judged pairs alongside verdicts. Should-merge pairs found
  only via the token heuristic (below 0.75 cosine) are evidence the 0.75
  floor is too high; adjust in a journaled iteration, never mid-crawl.
- **Structural stats (free, no judge):** singleton-theme rate,
  members-per-theme histogram, themes-per-category distribution.

**Targets:** 0 outstanding should-merge pairs; singleton-theme rate
directional ↓ without V2 falling.

## Cohesion router (diagnostic — no reward weight)

Embedding cohesion (mean member-centroid → theme-centroid cosine) is
circular as a quality score — clusters were built by thresholding it
(`promotion.py` floors) — so it never enters V2. It routes effort instead.
Per theme, cross cohesion with judged fit_rate:

| | high fit_rate | low fit_rate |
|---|---|---|
| **high cohesion** | healthy | label/criterion wrong — relabel lever |
| **low cohesion** | concept coherent, embeddings blind — **enrichment lever** | true junk — demotion candidate |

Report the quadrant lists in the eval report. The low-cohesion/high-fit list
is the direct input to tier-4a enrichment experiments.

## Report section (per run)

The Themes section of the eval report must contain, in this order:
1. `V2`, `v2_discrimination`, `n` values — with one-line interpretation each
   (strong: members belong AND intruders bounce; weak V2 + high
   discrimination: misfit contamination; weak discrimination: labels too
   generic to reject anything).
2. Granularity verdicts table: theme, verdict, probe label, members gained.
3. V4 merge-candidate verdicts + cosine histogram + threshold note.
4. Cohesion quadrant lists (router output).
5. Theme-axis recall vs gold (`pipeline.shared.evals.pairwise_f1` /
   `b_cubed` on gold_theme_id) — `n/a (no gold labels)` until
   `golden_news_entries` is populated.
