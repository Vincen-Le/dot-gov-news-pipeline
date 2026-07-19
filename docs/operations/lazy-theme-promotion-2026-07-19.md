# Lazy Theme Promotion

2026-07-19. Supersedes the stream-time theme spawn design (and the
"healing sweep" framing that patched it). Implemented by
`docs/superpowers/plans/2026-07-19-lazy-theme-promotion.md`.

## Why

Stream-time theme creation is an irreversible online decision made at the
moment of least evidence; the first events of a pattern define themes too
granular to survive (documented cold-start failure — see the megacluster and
singleton findings in `topic-clustering-research-validation-2026-07-18.md`).
The fix is architectural, not parametric: the stream assigns only a broad
seeded category (a stable, high-accuracy classification against the 23
CAP-aligned seeds), and themes are born offline by a promotion sweep once a
within-category cluster carries enough evidence. Retrospective detection
(TDT), TnT-LLM's taxonomy-then-classify phases, and CluStream's
online/offline split are the precedents.

## Decisions in force

| Layer | Decision |
|---|---|
| Category | LLM classify against seed taxonomy at card time; sole stream-time topic label; audit pair `category_method`/`category_reason` |
| Theme birth | promotion sweep only: greedy within-category clustering, gate = size >= `theme_promotion_min_storylines` AND distinct active days >= `theme_promotion_min_active_days` AND cohesion >= `theme_promotion_cohesion_floor`, then the promotion judge promotes / attaches-to-existing / rejects |
| Inclusion criterion | written by the promotion judge at birth; the membership rule every future attach is tested against |
| Stream attach | attach-only, sticky, none-biased; candidates = top-k themes by centroid cosine >= `theme_sim_floor`, cross-category by design |
| Cross-category | themes born category-local, live globally; sweep dossier lists cross-category near-misses; newborns immediately criterion-check them |
| Dormancy | derived, not stored: `newest_storyline_at` older than ~45 days; dormant themes stay attach targets (attach = revival); no poaching |
| Demotion | naive v1: member cohesion < `theme_demotion_cohesion_floor` triggers an LLM keep/demote review; demote reverts members to category-only; every review logged |
| Failure bias | failed verdicts leave work undone (uncategorized / unattached / unpromoted / kept), never act |

## Calibration procedure (golden bootstrap -> replay)

All floors are placeholders. Procedure, in order, on the golden window
(first 3 months of corpus; `golden_batch` selection already exists):

1. Hand-label which themes SHOULD exist in the bootstrap window (extend
   `docs/eval/labels.csv` via the lab borderline queue).
2. Sweep `theme_promotion_cluster_floor` and the gate triple; score
   precision/recall of theme births against the labels.
3. Set `theme_sim_floor` (attach recall floor) from labeled attach pairs:
   plot same-theme vs different-theme cosine distributions, floor at the
   crossover. Re-run when the embedding model changes.
4. Replay months 4+ (never tuned on) and read: birth precision, birth lag
   (days from first member storyline to promotion), attach precision/recall,
   none-rate, sweep mop-up lag, cross-category attach rate, largest-theme
   share, B-Cubed F1 once E0 lands.
5. Leakage rule: tune on bootstrap + months 4-5 only; hold out month 6+ and
   touch it once per major iteration.

## Known deferred items

- No rejection memory: a rejected cluster is re-judged every sweep it keeps
  crossing the gate. Add a rejected-signature skip if judge cost shows up.
- Demotion review is cohesion-triggered only; drift-into-megacluster (size up,
  cohesion slowly down) may want its own trigger.
- B-Cubed harness (E0 in the experimentation spec) is still the missing
  change-detection metric; operational metrics alone cannot say a change helped.
