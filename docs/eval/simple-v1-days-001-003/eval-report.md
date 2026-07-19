# Eval report: simple-v1-days-001-003

- pipeline: simple_v1 · run id: 3eea9a58-ae11-4d25-ab59-eed5301c6598 · finished: 2026-07-19 21:18:45.589601+00
- judge model: claude-opus-4-8 · corpus: 1 chains, 0 themes, 46 category pairs, 1 overviews

## Human review

| eval / metric | value | effect |
|---|---|---|
| R_v2 (reward) | n/a | not computable: unmeasured vectors v2_score, v6_score |
| V1 chain coherence | -2.000 (n=1) | below target 0.70; joins judged unrelated cost −2 — low value = false merges at attach time |
| V1 drift rate | 0.000 | share of chains that pass link-by-link but wander overall; high → chain-level checks needed |
| V1 worst attach method | adjudicated_join (0.000) | attach path contributing the most bad joins |
| V2 theme membership | n/a (n=0+0 intruders) | unmeasured (target 0.50); misfits and accepted intruders cost −2 |
| V2 discrimination | n/a | fit_rate − intruder accept rate; < 0.40 means judge couldn't tell members from intruders → V2/V4 weak |
| V3 categorization | 1.000 (n=46) | meets target 0.90; share of storylines filed under the best available category |
| V4 should-merge pairs | 0 of 0 candidates | unmerged near-duplicate themes; each costs 0.02 R |
| V4 singleton-theme rate | 0.000 | share of themes with one storyline; high = premature minting |
| V5 entity precision | 0.145 (n=62) | below target 0.80; invalid tokens feed every downstream join — junk lexicon lever |
| V5 event-key validity | n/a (n=0) | share of event keys that are real document/case identifiers |
| V5 missed-salient mean | 1.680 | salient entities the extractor missed, per entry; recall side of V5 |
| V6 episode coherence | n/a (n=0) | unmeasured (target 0.70); entries in one episode must be one event — upstream of every storyline lever |
| V7 overview quality | 1.000 (n=1) | meets target 0.70; per-criterion: coverage=1.000, current=1.000, faithful=1.000, representative=1.000 |
| Gold recall (storyline / theme) | n/a / n/a | n/a (no gold labels) |

**VALIDITY FLAG:** V2 discrimination n/a — V2/V4 (and R) are weak; re-judge before citing this run.

## Themes — observations

- No themes were minted this run.
- Expected at this corpus size: theme sweep needs 5+ similar storylines
  (`spine_theme_min_size`), which a 3-day window cannot produce. First real
  theme signal should appear once windows accumulate past ~2 weeks.
- Nothing to review manually for themes this round.

## Multi-episode chains — observations

- Worst chains (spot-check ids against artifacts):
  - ceb809ed-ca43-483d-8d18-3b0437004f84: -2.000
- The one chain was a false merge: Rubio–Djibouti call joined the
  Rubio/Kennedy IHR-amendments storyline on official-name overlap
  (similarity 0.717). Curated 2026-07-19: split into storyline f8795edd
  (Foreign Affairs & Trade). Lever noted for next iteration: listwise judge
  prompt should not let a shared official carry a join.
- All other 46 storylines are singletons — no chain formation signal yet;
  expected for a 3-day window with 48h episode gap.
- V5 entity junk (precision 0.145) is what fed the bad join: generic tokens
  ("president", "rubio" alone) inflate entity overlap shown to the judge.
