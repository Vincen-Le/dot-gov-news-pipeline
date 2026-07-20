# Eval report: simple-v1-days-007-009

- pipeline: simple_v1 · run id: 6098e372-1d14-4778-83ec-a87022fe2616 · finished: 2026-07-20 02:04:12.943655+00
- judge model: claude-opus-4-8 · corpus: 13 chains, 4 themes, 214 category pairs, 13 overviews

## Human review

| eval / metric | value | effect |
|---|---|---|
| R_v2 (reward) | 0.569 | mean(V1,V2,V3,V5,V6,V7) − 0.02·merge pairs; the loop's objective |
| V1 chain coherence | 0.400 (n=20) | below target 0.70; joins judged unrelated cost −2 — low value = false merges at attach time |
| V1 drift rate | 0.000 | share of chains that pass link-by-link but wander overall; high → chain-level checks needed |
| V1 worst attach method | adjudicated_join (0.800) | attach path contributing the most bad joins |
| V2 theme membership | 0.492 (n=25+20 intruders) | below target 0.50; misfits and accepted intruders cost −2 |
| V2 discrimination | 0.975 | fit_rate − intruder accept rate; < 0.40 means judge couldn't tell members from intruders → V2/V4 weak |
| V3 categorization | 0.991 (n=214) | meets target 0.90; share of storylines filed under the best available category |
| V4 should-merge pairs | 0 of 0 candidates | unmerged near-duplicate themes; each costs 0.02 R |
| V4 singleton-theme rate | 0.000 | share of themes with one storyline; high = premature minting |
| V5 entity precision | 0.132 (n=68) | below target 0.80; invalid tokens feed every downstream join — junk lexicon lever |
| V5 event-key validity | n/a (n=0) | share of event keys that are real document/case identifiers |
| V5 missed-salient mean | 1.260 | salient entities the extractor missed, per entry; recall side of V5 |
| V6 episode coherence | 0.400 (n=10) | below target 0.70; entries in one episode must be one event — upstream of every storyline lever |
| V7 overview quality | 1.000 (n=13) | meets target 0.70; per-criterion: coverage=1.000, current=1.000, faithful=1.000, representative=1.000 |
| Gold recall (storyline / theme) | n/a / n/a | n/a (no gold labels) |

## Themes — observations

- High cohesion / low judged fit — relabel/demote lever: ['f13a8946-2865-4321-b526-8660094adbc0']

## Multi-episode chains — observations

- Worst chains (spot-check ids against artifacts):
  - 09926b22-8867-41c8-aedf-a4692885c9a5: -2.000
  - 2d7c9bf9-79cc-4c8a-9af4-542499961e8e: -0.500
  - a1f7e7d3-2499-4352-afd9-77b0992afa0e: -0.500
  - 0bb6fc42-03c5-4399-b516-9f67940f7abf: 1.000
  - 30ced07a-21c9-4753-bbcb-b895a9213040: 1.000
  - 3d36f83b-4624-412f-b3ba-f95564f2d8e1: 1.000
  - 40f3c0e5-e3b4-494f-8f33-478988bd4198: 1.000
  - 48bdd9ce-e36d-4944-8293-6a64cb43a8b0: 1.000
  - 4a24e587-9e7f-4a7c-9061-828595180b42: 1.000
  - 5184a6b9-16e4-4f5b-9631-0018bf7a9cfd: 1.000

## Run-specific caveats (hand-appended)

- **Judge bias isolation (validity caveat, standing):** pipeline judges ran on
  `claude-sonnet-5`, eval judge is `claude-opus-4-8` — same model family;
  scores may inherit self-preference bias.
- **Cumulative set judged:** union of reviewed golden (slices 1-2, 164
  entries) and slice-3 clusters — 214 storylines total.
- **Stale-bytecode run:** the pipeline executed with cached bytecode, so the
  categorization prompt did NOT include the new reader-impact guidance
  (`prompt_version: 1` stamped — accurate to what ran). The V3 judge DID use
  the updated reader-impact rubric: 214 pairs → 2 better_option_exists + 19
  ambiguous (V3 0.991). Bytecode caches cleared; next run gets prompt v2.
- **Post-verdict QA surgery (Rubio roll-up):** after verdicts returned,
  manual QA merged 5 storylines (Pakistani Dar fad8d4ad, Portuguese Rangel
  57c13ba1, Ethiopian Abiy b954c5a8, Iraqi al-Sudani 584872ed, Jordanian
  Safadi 8248dd9b) into a1f7e7d3 as one "Rubio diplomatic engagements" chain
  (8 episodes, 9 entries). Verdicts reflect the pre-merge state.
- **Editorial-vs-rubric tension (journaled, verdicts stand):** the V1 judge
  marked the Pakistan-vs-Austria link in a1f7e7d3 unrelated (−0.5) and the
  two Kentucky joins in 2d7c9bf9 unrelated (−0.5) — strict same-event-thread
  reading. Vincent's editorial decisions (slice-2 TN/KY keep; slice-3 Rubio
  roll-up) deliberately trade single-event purity for reader-facing
  aggregation of brief, same-actor/same-program items in a short window.
  The rubric may need a "roll-up storyline" concept if this pattern recurs.
- **Worst chain 09926b22 (−2):** "VA Research Office Publishes Weekly Health
  Study Briefs" — recurring weekly digest glued into one chain; the
  occasion-hub failure mode, real V1 defect worth QA attention.
- **V5 unchanged by design:** corpus entities still stamped extractor v2;
  extractor v4 (datelines + body fallback) is merged but a `reextract`
  backfill has not been run — Vincent's decision pending.
- **Judge harness:** all 7 vectors returned in ONE dispatch each (format
  reinforcement + mechanical trailing-comma rejoin in the final reason
  column only); no top-ups, protocol met this pass.
