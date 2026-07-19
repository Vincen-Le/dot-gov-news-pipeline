# Topic Clustering: Research Validation

2026-07-18. Companion to the topic clustering implementation
(`docs/superpowers/plans/2026-07-18-topic-clustering.md`, spec
`docs/superpowers/specs/2026-07-18-topic-clustering-design.md`). The design was
checked against the news-clustering literature and production systems; this
records the verdicts, what changed in the implementation because of them, and
the ranked follow-ups that did not make this iteration.

> **2026-07-19:** The theme stage this document validates was redesigned —
> stream-time spawn replaced by category-first lazy promotion. See
> `lazy-theme-promotion-2026-07-19.md`. Verdicts below stay as the research
> record; follow-ups 2, 3, 5, 6 carry over.

## Design verdicts

| Design choice | Verdict | Key evidence |
|---|---|---|
| Incremental nearest-centroid + sim floor + LLM join/spawn adjudicator (top-10 candidates) | **Validated** | The single-pass "compare to centroids, join above τ else spawn" loop is the TDT-standard architecture. The strongest precedent for the LLM adjudicator: [Miranda et al. 2018](https://aclanthology.org/D18-1483/) replaced a grid-searched threshold with a trained join-vs-spawn classifier and went 82.8 → 94.1 F1 (English); [Saravanakumar et al. 2021](https://aclanthology.org/2021.eacl-main.198/) independently converged on a learned join decision. Gating LLM calls on the sim floor matches [ClusterLLM](https://arxiv.org/abs/2305.14871)'s query-only-ambiguous-cases cost discipline. |
| Hysteresis (stick floor 0.50 < sim floor 0.55) | **Partially validated** | No news-clustering paper uses dual thresholds (they use immutability + offline correction — Miranda's "domino-toppling", Bloomberg NSTM's offline refinement). But dual-threshold hysteresis is the canonical anti-ping-pong mechanism in adjacent assignment problems (cellular handover margins). Risk: the 0.05 gap is narrow relative to embedding noise; handover practice pairs the margin with a dwell/time-to-trigger condition. |
| Theme centroid = flat mean of member centroids | **Mean validated; missing time decay is the largest divergence from practice** | Mean centroids updated incrementally are exactly Miranda's approach and streaming-K-means practice. But every mature streaming system adds a temporal component: fading cluster droplets ([Aggarwal & Yu 2006](https://www.semanticscholar.org/paper/55b0e1c5e1ef6060b9fdcb5f644b01d89afe5b27)), Miranda's Gaussian timestamp features (σ = 72h, tuned), time-aware embeddings ([USTORY](https://arxiv.org/abs/2304.04099)). A flat all-time mean is the known recipe for centroid drift and megacluster absorption. |
| Theme naming folded into the join-adjudication call | **Partially validated** | LLM cluster naming is well supported ([NewsLens](https://aclanthology.org/W17-2701/), [TnT-LLM](https://arxiv.org/abs/2403.12173), [LLooM](https://dl.acm.org/doi/10.1145/3613904.3642830)) — but always as a separate post-hoc step; no published system fuses it into the membership decision. Defensible cost optimization; invites name churn and granularity drift ([documented failure modes](https://arxiv.org/html/2405.00611v1)). The hallucinated-ID guard (validate returned theme_id against the enumerated candidates; implemented in `ThemeEngine._assign` and covered by `test_invalid_theme_id_from_llm_treated_as_spawn`) is the standard mitigation from LLM entity-resolution work. |
| Two-level taxonomy (~20 seeds, LLM may propose, audited) | **Validated; seed list had 3 gaps** | Structure matches TnT-LLM's taxonomy-then-classify phases and the [Comparative Agendas Project](https://www.comparativeagendas.net/pages/master-codebook) (CAP) major/subtopic design — CAP is the best-matched external standard for US government news (21 majors, stable since the 1990s). Seed count ~20 sits between CAP (21) and IPTC Media Topics (17). Gap analysis vs CAP found three missing majors with dedicated agencies. **Applied**: Agriculture, Civil Rights & Liberties, and Public Lands & Natural Resources were added to the seed migration (23 seeds total). |
| LLM failure → spawn fallback / null category retried | **Validated** | Failure bias is correct: spawning errs toward fragmentation, which is recoverable and visible in the singleton metric; erroneous joins are the higher-magnitude error (Miranda). |
| Eval: singleton-theme rate, attach mix, top themes | **Partially validated** | Singleton ratio is a recognized over-fragmentation signal, but the set is one-sided: no explicit megacluster alarm, no churn/stability metric (needed to prove hysteresis works), no gold-labeled B-Cubed/pairwise-F1 check — the field standard. Internal metrics (Silhouette etc.) are documented unreliable for news clusters. |

## What the stub reference run already shows

`docs/eval/topics-baseline-stub/report.md` (7,695 entries, stub models):

- 3,154 themes over 5,480 storylines; singleton-theme rate 0.87.
- The largest theme absorbed ~400 storylines (State Department boilerplate) —
  the megacluster tendency the literature warns about is visible even with
  stub embeddings and one afternoon of corpus. Expect worse with real
  embeddings over months unless a mitigation lands.
- One LLM-proposed category ("General Government", the stub's fallback) took
  2,179 of the themes — with real models, watch the classifier's propose-new
  rate as a health signal.

## Ranked follow-ups (not in this iteration)

1. **Calibrate `theme_sim_floor`/`theme_stick_floor` on real embeddings.**
   0.55/0.50 are placeholders; every credible system tunes τ per embedding
   model. Cheap procedure: hand-label ~200 storyline pairs
   (same-theme/different-theme), plot both similarity distributions, put the
   floor near the crossover. Re-run when the embedding model changes.
2. **Add a temporal component to theme membership** — the design's biggest
   divergence from practice. Cheapest options, in order: recency-weighted
   centroid (exponential decay on member weight), centroid over last-K-months
   members only, or a Miranda-style time-gap line in the adjudicator prompt
   ("theme last active 240 days ago").
3. **Megacluster guards.** Metric: largest-theme share + mean member-to-centroid
   cosine per theme. Mitigation (from Google's news patent
   [US9256664](https://image-ppubs.uspto.gov/dirsearch-public/print/downloadPdf/9256664)):
   raise the effective join bar for oversized themes, or feed theme size into
   the adjudicator prompt so it can refuse joins to bloated themes.
4. **Dwell condition on reassignment**: re-adjudicate only after cosine <
   stick floor on k consecutive syncs (k = 2–3), mirroring handover
   time-to-trigger. Track the reassignment rate — it is the direct measure of
   whether hysteresis works (currently 2 of 5,480 in the stub run).
5. **Naming guardrails**: store a one-sentence inclusion criterion with each
   theme (LLooM's lesson) and feed it to future adjudications; keep a name
   history; rename only on material membership change.
6. **Small gold-standard eval**: label ~100–200 storylines once; compute
   B-Cubed/pairwise F1 on every threshold/prompt/model change. Operational
   metrics alone cannot say whether a change helped.
7. **Tag adjudicator-failure fallback themes** and route them into
   re-adjudication — otherwise LLM outages permanently inflate the singleton
   rate (today they are only distinguishable via `theme_reason` prefix).

Full literature survey with per-question findings and all citations:
research session output, 2026-07-18 (Miranda/Priberam, Saravanakumar/Amazon,
NewsLens, Aggarwal & Yu, USTORY, Bloomberg NSTM, ClusterLLM, GoalEx, LLooM,
TnT-LLM, CAP/IPTC/IAB taxonomies, B-Cubed).
