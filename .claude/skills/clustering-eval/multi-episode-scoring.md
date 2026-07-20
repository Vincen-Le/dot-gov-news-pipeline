# Multi-Episode Storyline Scoring

Authoritative rubric for the **Multi-Episode Storylines axis** (V1 chain
coherence, V6 episode coherence, V7 overview quality). General rules —
judge protocol, blinding, false-merge weighting, reward assembly, report
format — live in `scoring.md` and are not restated here.

Ordering contract (two different orders, do not conflate):
- **Display order** — reader-facing chain reads `overview → most recent →
  oldest`. Enforced in `pipeline/shared/cards.py` (overview timeline sorted date
  desc). Compressor *input* stays oldest-first — chronological input is what
  the narrative summary needs; only the emitted timeline is newest-first.
- **Judging order** — chain verdicts walk BUILD order (oldest → newest,
  matching the runner's event-time replay), because "is this the next
  logical development" is only well-defined forward. Never judge a chain
  newest-first.

## V1 — storyline chain coherence

**Cases:** every multi-episode storyline (no sampling). The judged unit is
a **join** — each non-anchor episode's attach to the chain. Report
`n_chains` and `n_joins_judged`; in the human report write them in units
("6 chains, 7 joins judged"), never a bare `n=`.

**Per non-anchor episode: `related 1/0`** to the chain's event thread,
walking build order. Criteria:
- Related = same real-world event thread evolving over time — not merely
  same topic, same agency, or same occasion/observance (the
  "Independence Day hub" failure: distinct events sharing an anniversary are
  NOT one storyline).
- **Same program/initiative in a tight window is one thread.** Episodes
  covering the same named program, enforcement push, or campaign published
  within ~1 week of each other are `related` even when the individual
  subjects differ (two same-day success stories about one VA program → `1`;
  a State deportation announcement and a USCIS arrest two days later under
  the same enforcement push → `1`). The same program **months apart** is
  theme material, not a chain link → `0`. Occasion/observance hubs stay
  excluded: agencies coincidentally publishing around the same holiday is
  not a program.
- **Entities are primary evidence when present.** Differing key
  discriminators mean different events even when text reads similar: same
  hazard type but locations genuinely far apart; same policy action but
  different subjects *outside the tight-window program case above*;
  different docket/case/contract numbers. Shared rare entities + temporal
  continuity → related.
- Uncertain after entity check → `0` (split bias — a false join shows the
  reader two unrelated events as one story, worse than showing two stories).

**Drift check (chains ≥ 3 episodes).** Pairwise verdicts pass on chains
that drift link-by-link (A→B fine, B→C fine, A→C unrelated). Two extra
verdicts per such chain:
- `endpoints_related 1/0` — first vs last episode, same criteria.
- `chain_verdict: coherent | drifted | should_split` — whole-chain read;
  `drifted` when every link passes but endpoints fail.

**Score:**

```
V1 = (Σ related − 2·Σ unrelated) / Σ judged        (pairwise, range −2..1)
```

Target ≥ 0.70. A chain with `endpoints_related = n` or `chain_verdict ≠
coherent` counts its LAST link as unrelated for scoring if no pairwise
verdict already failed — drift must cost something. Also report
per-`attach_method` precision (worst-method target ≥ 0.75), per-chain
scores, and `drift_rate` (drifted chains / chains ≥ 3 episodes).

## V6 — episode coherence (within-episode)

**Cases:** multi-entry episodes. All of them if ≤ 50; else stratified sample
of 50 by entry_count band, `random.Random(42)`.

**Per non-anchor entry: `same_event 1/0`** vs the episode's anchor entry.
Criteria mirror V1 but at event grain, entity-first:
- Same event reported/syndicated differently (near-dup, cross-agency mirror,
  GovDelivery repost) → `1`.
- Same *kind* of event, different discriminating entities → `0`.
- Follow-up coverage of a developing event within the episode window → `1`;
  a NEW development that should have opened a new episode in the chain → `0`.

**Score:** `V6 = (Σ same − 2·Σ different) / Σ judged`. Target ≥ 0.70.
CSV: `episode-verdicts.csv` (`episode_id,entry_id,same_event,reason`).

## V7 — overview quality

**Cases:** the overview card of every multi-episode storyline. Judge input:
overview headline + summary + timeline, plus the member episode cards.

Binary verdicts per overview:
- `coverage 1/0` — does the overview represent the cohesive chain, or is it
  biased to one episode? `0` if any episode's development is absent from
  both summary and timeline without being a mere duplicate of another.
- `faithful 1/0` — every factual claim in headline + summary is entailed by
  at least one member episode card. Any unsupported claim → `0`
  (hallucination is a false merge of facts; carries the −2 weight).
- `current 1/0` — headline reflects the chain's latest state, not anchored
  to the first event (the "Investment Regulation" first-event-anchoring
  failure).
- `representative 1/0` — a reader seeing only headline + summary would
  correctly predict what the episode chain contains.

**Score:**

```
V7 = (Σ passed − 2·Σ faithful_failures) / Σ verdicts    over all overviews
```

Target ≥ 0.70. Report `n_overviews` and the per-criterion pass rates —
the failing criterion names the lever (coverage/current → compressor
prompt; faithful → timeline/claim validation).

## Embedding diagnostics (no judge, no reward weight)

**Never score storyline centroid tightness.** A healthy long chain drifts
semantically by design (incident → investigation → resolution), so centroid
strength anti-selects the storylines we most want. Storyline attach is
judge-gated, not embedding-gated (`storylines.py`); there is no
embedding-merge knob for this number to tune. Instead report per chain:
- consecutive-episode centroid cosine series (trend, min).
- entity-overlap persistence: |shared entities| between consecutive episodes.

Route: entity overlap decaying to 0 while V1 verdicts still pass → the
chain coheres on facts the extraction/enrichment no longer captures —
enrichment lever, cross-reference the theme cohesion router.

## Report section (per run)

The Storylines section of the eval report must contain, in this order:
1. `V1` + `drift_rate` + worst attach_method — interpretation: strong =
   chains are single evolving events; weak with low drift_rate = bad joins
   at attach time; high drift_rate = joins fine locally but chains wander.
2. Per-chain score table (worst 10), endpoints/chain verdicts inline.
3. `V6` + entries judged — weak = episode formation merging distinct events
   (upstream of everything; fix before touching storyline levers).
4. `V7` + per-criterion pass rates — lever mapping per criterion above.
5. Embedding diagnostics: chains with decaying entity persistence.
6. Storyline-axis recall vs gold (`pipeline.shared.evals.pairwise_f1` / `b_cubed`
   on gold_storyline_id) — `n/a (no gold labels)` until
   `golden_news_entries` is populated.
