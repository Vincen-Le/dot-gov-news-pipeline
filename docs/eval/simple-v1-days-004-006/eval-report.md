# Eval report: simple-v1-days-004-006

- pipeline: simple_v1 · run id: 55cc5140-2c69-491e-be6f-b6b1e674b3e1 · finished: 2026-07-20 01:06:00+00
- judge model: claude-opus-4-8 · corpus: 6 chains, 1 themes, 150 category pairs, 6 overviews

## Human review

| eval / metric | value | effect |
|---|---|---|
| R_v2 (reward) | 0.343 | mean(V1,V2,V3,V5,V6,V7) − 0.02·merge pairs; the loop's objective |
| V1 chain coherence | 0.143 (7 joins judged) | below target 0.70; joins judged unrelated cost −2 — low value = false merges at attach time |
| V1 drift rate | 0.000 | share of chains that pass link-by-link but wander overall; high → chain-level checks needed |
| V1 worst attach method | adjudicated_join (0.714) | attach path contributing the most bad joins |
| V2 theme membership | 0.091 (6 members + 5 planted intruders) | below target 0.50; misfits and accepted intruders cost −2 |
| V2 discrimination | 0.633 | fit_rate − intruder accept rate; < 0.40 means judge couldn't tell members from intruders → V2/V4 weak |
| V3 categorization | 0.993 (150 category pairs) | meets target 0.90; share of storylines filed under the best available category |
| V4 should-merge pairs | 0 of 0 candidates | unmerged near-duplicate themes; each costs 0.02 R |
| V4 singleton-theme rate | 0.000 | share of themes with one storyline; high = premature minting |
| V5 entity precision | 0.118 (68 entity tokens) | below target 0.80; invalid tokens feed every downstream join — junk lexicon lever |
| V5 event-key validity | n/a (0 event keys) | share of event keys that are real document/case identifiers |
| V5 missed-salient mean | 1.930 | salient entities the extractor missed, per entry; recall side of V5 |
| V6 episode coherence | -0.286 (7 entries judged) | below target 0.70; entries in one episode must be one event — upstream of every storyline lever |
| V7 overview quality | 1.000 (6 overviews) | meets target 0.70; per-criterion: coverage=1.000, current=1.000, faithful=1.000, representative=1.000 |
| Gold recall (storyline / theme) | n/a / n/a | n/a (no gold labels) |

## Themes — observations

- High cohesion / low judged fit — relabel/demote lever: ['f13a8946-2865-4321-b526-8660094adbc0']

## Multi-episode chains — observations

- Worst chains (spot-check ids against artifacts):
  - 30ced07a-21c9-4753-bbcb-b895a9213040: -2.000
  - ae6f94d1-b42d-4580-9ed1-8ac6009da3b9: -2.000
  - 2d7c9bf9-79cc-4c8a-9af4-542499961e8e: 1.000
  - 3d36f83b-4624-412f-b3ba-f95564f2d8e1: 1.000
  - 40f3c0e5-e3b4-494f-8f33-478988bd4198: 1.000
  - 7af8300d-35c0-44f5-9083-46bf23d02e09: 1.000

## Run-specific caveats (hand-appended)

- **Judge bias isolation (validity caveat):** pipeline judge/adjudicator/audit
  calls in this run were `claude-sonnet-5` while the eval judge is
  `claude-opus-4-8` — the same model family. This violates the spirit of the
  bias-isolation rule (scoring.md §judge protocol); scores may inherit
  self-preference bias. Vincent has not yet chosen an out-of-family eval judge.
- **Cumulative set judged:** verdicts cover the union of reviewed golden
  (slice 1, 47 entries) and the slice-2 clusters — the run's full cluster
  snapshot — not just newly replayed entries.
- **Judge CSV transport repairs:** the v1 and v3 judges repeatedly emitted
  unquoted commas inside `reason` fields. Verdicts were accepted after a
  format-reinforcement re-dispatch plus a mechanical rejoin of trailing
  comma fragments in the final `reason` column only; no verdict value
  (ids, related/fits/verdict columns) was altered.
- **V3 top-up dispatch (protocol deviation):** the batched v3 judge skipped
  the same 2 of 150 pairs across two dispatches; those 2 pairs were judged in
  a second dispatch with the identical rubric and merged before validation.
  One-dispatch-per-vector was not strictly met for V3.
- **V1 rubric updated after this crawl's verdicts (comparability note):**
  a same-program tight-window provision was added to
  `multi-episode-scoring.md` — episodes on the same named program/
  enforcement push within ~1 week are `related` even with differing
  subjects; the same program months apart is theme material. This crawl
  was judged under the stricter same-event-only wording. Both failed
  joins (30ced07a VA success stories, ae6f94d1 Haiti enforcement push)
  would plausibly flip under the new wording — V1 0.143 is not comparable
  to next slice's V1. Human-directed revision per scoring.md §reward
  (between loops, journaled here).
- **V3 rubric updated after this crawl's dispatch:** the reader-impact
  question ("would a user clicking a competing category have cared more to
  see this there?") was added to scoring.md after these v3 verdicts were
  returned. This crawl was judged under the older best-available-option
  wording; next slice judges under the new wording (comparability note).
- **Post-export QA surgery:** after artifact export, manual QA recategorized
  3 storylines (44391e2b→Disaster Response, dabf64dd→Public Health,
  723500cd→Education), merged 'Courts & Legal Rulings' into 'Justice & Law
  Enforcement', and rewrote the Tennessee/Kentucky FEMA overview
  (2d7c9bf9). V3/V7 verdicts reflect the pre-surgery state; at least the 3
  recategorized pairs' `better_option_exists` verdicts are already resolved.
- **V5 root cause known:** sampled entries carry `extractor_version=2`
  entity sets (junk stopwords); extractor v4 (dateline handling + body
  fallback) landed after this run. Expect V5 to move materially next slice
  only if entries are re-extracted or newly prepared.
