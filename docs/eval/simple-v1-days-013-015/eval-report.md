# Eval report: simple-v1-days-013-015

- pipeline: simple_v1 · run id: 7cd4d29b-6bc8-41be-91af-8cf54fea7339 · finished: 2026-07-20 07:21:31.857563+00
- judge model: claude-opus-4-8 · corpus: 27 chains, 23 themes, 369 category pairs, 27 overviews

## Human review

| eval / metric | value | effect |
|---|---|---|
| R_v2 (reward) | 0.442 | mean(V1,V2,V3,V5,V6,V7) − 0.02·merge pairs; the loop's objective |
| V1 chain coherence | -0.189 (n=53) | below target 0.70; joins judged unrelated cost −2 — low value = false merges at attach time |
| V1 drift rate | 0.000 | share of chains that pass link-by-link but wander overall; high → chain-level checks needed |
| V1 worst attach method | new_storyline (0.143) | attach path contributing the most bad joins |
| V2 theme membership | 0.355 (n=119+102 intruders) | below target 0.50; misfits and accepted intruders cost −2 |
| V2 discrimination | 0.839 | fit_rate − intruder accept rate; < 0.40 means judge couldn't tell members from intruders → V2/V4 weak |
| V3 categorization | 0.986 (n=369) | meets target 0.90; share of storylines filed under the best available category |
| V4 should-merge pairs | 0 of 9 candidates | unmerged near-duplicate themes; each costs 0.02 R |
| V4 singleton-theme rate | 0.000 | share of themes with one storyline; high = premature minting |
| V5 entity precision | 0.243 (n=527) | below target 0.80; invalid tokens feed every downstream join — junk lexicon lever |
| V5 event-key validity | 1.000 (n=1) | share of event keys that are real document/case identifiers |
| V5 missed-salient mean | 0.310 | salient entities the extractor missed, per entry; recall side of V5 |
| V6 episode coherence | 0.286 (n=21) | below target 0.70; entries in one episode must be one event — upstream of every storyline lever |
| V7 overview quality | 0.972 (n=27) | meets target 0.70; per-criterion: coverage=1.000, current=1.000, faithful=0.963, representative=1.000 |
| Gold recall (storyline / theme) | n/a / n/a | n/a (no gold labels) |

## Themes — observations

- High cohesion / low judged fit — relabel/demote lever: ['20db1ac9-d272-4808-a08a-42ca7772c23a', '3b0ab9c9-2f08-4abf-817c-574c5176ba69', '6cfbcccd-ae6d-45d0-9733-70a973f246e1', '788bd142-c1ec-4248-8b48-97bff36a4746', '7ca10d73-ff72-4f17-9541-7df96ad509b8', '9a524fe0-7adf-4840-b1dc-30b725677b08', 'bc8630a0-1c65-4513-ac8e-462f7574f11a', 'f13a8946-2865-4321-b526-8660094adbc0', 'f19428da-b19b-4009-8022-1b7c87c09cbf', 'fab89bfb-af0c-4a7e-94d1-862bc619edd2']

## Multi-episode chains — observations

- Worst chains (spot-check ids against artifacts):
  - 0703aa86-e150-4438-ab02-c4f6077bc5d1: -2.000
  - 7e0d574b-8526-40fe-ae7c-a671d85ee511: -2.000
  - 9c056b74-160e-4a63-b0b6-8c39d147e315: -2.000
  - a1f7e7d3-2499-4352-afd9-77b0992afa0e: -2.000
  - cf4d18e2-6cf4-46ca-91f9-e29d5c544dfc: -2.000
  - 2d7c9bf9-79cc-4c8a-9af4-542499961e8e: -0.800
  - 0bb6fc42-03c5-4399-b516-9f67940f7abf: 1.000
  - 30ced07a-21c9-4753-bbcb-b895a9213040: 1.000
  - 32e16b54-2d1e-4db4-8887-dea17265eca7: 1.000
  - 3d36f83b-4624-412f-b3ba-f95564f2d8e1: 1.000

## Run-specific caveats (hand-appended)

- **Judge bias isolation (validity caveat, standing):** pipeline judges ran on
  `claude-sonnet-5`, eval judge is `claude-opus-4-8` — same model family;
  scores may inherit self-preference bias.
- **Cumulative set judged:** reviewed golden (slices 1-4, 315 entries) ∪
  slice-5 clusters — 369 live storylines, 443 entries, 27 multi-episode
  chains, 23 themes.
- **Extractor v4 backfill landed before this eval (Vincent's call):** the
  whole corpus (9,657 entries) was re-extracted deterministically to v4
  between the run and the artifact export. V5 entity precision 0.243
  (vs 0.118 on the v2/v3-mixed corpus of prior slices — not directly
  comparable) and event-key validity 1.000 (14 keys judged; first slice
  with any event keys at all). Entities feed the adjudicator prompt as
  shared-entity evidence; event keys are stored but unused by spine.
- **Judge dispatch protocol (standing deviation):** batch harness aborted
  twice on malformed CSV rows (unquoted commas in reasons); v1, v2, v3, v6,
  v7 were dispatched via the lenient driver (mechanical trailing-comma
  rejoin into the reason column + same-rubric top-up for dropped cases).
  Top-ups: v3 1 pair, v6 1 episode. v4, v5 returned clean via the harness.
- **V1 −0.189 dominated by ruled editorial keeps:** a1f7e7d3 (Rubio roll-up),
  2d7c9bf9 (FEMA TN/KY), cf4d18e2 (State Dept daily schedules) and 0703aa86
  (weekly veteran job listings) are all storylines Vincent has explicitly
  kept under the recurring-digest cadence policy (daily → week chain,
  weekly → month chain) or as editorial roll-ups; the strict same-event
  rubric re-prices them −2 every slice. New this slice: 7e0d574b and
  9c056b74 (see QA items). The "roll-up storyline" rubric concept remains
  open — with 6 of 27 chains now policy-priced, V1 increasingly measures
  rubric disagreement, not pipeline error.
- **V6 0.286 (21 joins judged):** low and worth QA attention, but note the
  episode-purity leniency ruling (2026-07-20): related same-subject
  pages/actions may share an episode; some flagged joins may be accepted
  class, not defects. Judged verdicts stand; QA rules item by item.
- **V2 0.355 with discrimination 0.839 (valid):** 102 planted intruders this
  slice (larger corpus); theme sweep minted 16 new themes, several flagged
  high-cohesion/low-fit — relabel/demote candidates in the QA list.
