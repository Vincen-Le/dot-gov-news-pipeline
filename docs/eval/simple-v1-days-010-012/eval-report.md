# Eval report: simple-v1-days-010-012

- pipeline: simple_v1 · run id: 0ad16316-2705-4dfb-b38a-8b1bb81a9a79 · finished: 2026-07-20 03:01:52.465485+00
- judge model: claude-opus-4-8 · corpus: 19 chains, 9 themes, 267 category pairs, 19 overviews

## Human review

| eval / metric | value | effect |
|---|---|---|
| R_v2 (reward) | 0.473 | mean(V1,V2,V3,V5,V6,V7) − 0.02·merge pairs; the loop's objective |
| V1 chain coherence | -0.167 (n=36) | below target 0.70; joins judged unrelated cost −2 — low value = false merges at attach time |
| V1 drift rate | 0.000 | share of chains that pass link-by-link but wander overall; high → chain-level checks needed |
| V1 worst attach method | new_storyline (0.143) | attach path contributing the most bad joins |
| V2 theme membership | 0.400 (n=47+39 intruders) | below target 0.50; misfits and accepted intruders cost −2 |
| V2 discrimination | 0.913 | fit_rate − intruder accept rate; < 0.40 means judge couldn't tell members from intruders → V2/V4 weak |
| V3 categorization | 0.989 (n=267) | meets target 0.90; share of storylines filed under the best available category |
| V4 should-merge pairs | 0 of 0 candidates | unmerged near-duplicate themes; each costs 0.02 R |
| V4 singleton-theme rate | 0.000 | share of themes with one storyline; high = premature minting |
| V5 entity precision | 0.118 (n=68) | below target 0.80; invalid tokens feed every downstream join — junk lexicon lever |
| V5 event-key validity | n/a (n=0) | share of event keys that are real document/case identifiers |
| V5 missed-salient mean | 0.010 | salient entities the extractor missed, per entry; recall side of V5 |
| V6 episode coherence | 0.500 (n=12) | below target 0.70; entries in one episode must be one event — upstream of every storyline lever |
| V7 overview quality | 1.000 (n=19) | meets target 0.70; per-criterion: coverage=1.000, current=1.000, faithful=1.000, representative=1.000 |
| Gold recall (storyline / theme) | n/a / n/a | n/a (no gold labels) |

## Themes — observations

- High cohesion / low judged fit — relabel/demote lever: ['788bd142-c1ec-4248-8b48-97bff36a4746', 'dde99ef4-5947-413d-bf8e-976bf4f9d177', 'f13a8946-2865-4321-b526-8660094adbc0']

## Multi-episode chains — observations

- Worst chains (spot-check ids against artifacts):
  - 0703aa86-e150-4438-ab02-c4f6077bc5d1: -2.000
  - 775073fd-ca2b-4264-b65a-17fa41c4212f: -2.000
  - a1f7e7d3-2499-4352-afd9-77b0992afa0e: -2.000
  - cf4d18e2-6cf4-46ca-91f9-e29d5c544dfc: -2.000
  - 2d7c9bf9-79cc-4c8a-9af4-542499961e8e: -0.800
  - 0bb6fc42-03c5-4399-b516-9f67940f7abf: 1.000
  - 30ced07a-21c9-4753-bbcb-b895a9213040: 1.000
  - 3d36f83b-4624-412f-b3ba-f95564f2d8e1: 1.000
  - 40f3c0e5-e3b4-494f-8f33-478988bd4198: 1.000
  - 48bdd9ce-e36d-4944-8293-6a64cb43a8b0: 1.000

## Run-specific caveats (hand-appended)

- **Judge bias isolation (validity caveat, standing):** pipeline judges ran on
  `claude-sonnet-5`, eval judge is `claude-opus-4-8` — same model family;
  scores may inherit self-preference bias.
- **Cumulative set judged:** reviewed golden (slices 1-3, 244 entries) ∪
  slice-4 clusters — 267 live storylines, 315 entries, 19 multi-episode
  chains, 9 themes.
- **Interrupted pass, two dispatch sessions:** V1/V2/V4-V7 verdicts landed in
  the pre-move session (checkpoint d35f790); the V3 dispatch and scoring were
  interrupted by a repo relocation and completed in a follow-up session
  against the same committed artifacts. Same judge model and rubrics both
  sessions.
- **V3 top-up (protocol deviation, standing pattern):** main dispatch
  returned 266/267 rows; the 1 dropped pair was re-judged in a same-rubric
  top-up dispatch and merged. No dupes, no unexpected rows. 267 pairs →
  247 correct + 17 ambiguous + 3 better_option_exists (V3 0.989).
- **Verdicts predate promote:** artifacts were exported before slice-4 QA
  rulings and the 05:26Z promote; verdicts reflect the run's raw output.
  Post-verdict QA included the FEMA TN/KY vs May-tornado (DR-4875) boundary
  ruling and storyline merges/recategorizations now frozen in golden.
- **V1 −0.167 is dominated by known editorial roll-ups + occasion hubs:**
  a1f7e7d3 (Rubio roll-up, Vincent's slice-3 editorial keep), 2d7c9bf9
  (FEMA TN/KY multi-state keep) are deliberate reader-facing aggregations
  the strict same-event-thread rubric prices at −2/−0.8; cf4d18e2 (State
  Dept daily schedules), 0703aa86 (weekly veteran job listings) are
  recurring-digest occasion hubs — the real V1 defect class (same failure
  mode as slice-3's VA weekly briefs chain); 775073fd glued two unrelated
  Florida tax-fraud sentencings (entity/topic overlap, different cases) —
  genuine false merge. The "roll-up storyline" rubric concept flagged in
  days-007-009 recurs; still unresolved.
- **V1 worst method `new_storyline` (0.143):** low-n artifact of chain
  sampling — most judged joins in bad chains carry the chain-seeding attach
  label; read it with V1's per-chain table, not as an adjudicator regression
  on its own.
- **V5 unchanged by design (standing):** corpus entities still stamped
  extractor v2; `reextract` v4 backfill pending Vincent's call. Entity
  precision 0.118 (68 tokens) matches prior slices.
- **Demoted-theme surfacing (fixed post-eval, outside this pass):** two
  demoted theme husks (EPA Superfund Cleanup Actions, Financial Fraud
  Sentencing Cases) appeared in run-report topic counts and the operator
  console; console queries now filter `demoted_at`. Judge artifacts were
  unaffected (exporter already excludes demoted themes — 9 themes judged).
