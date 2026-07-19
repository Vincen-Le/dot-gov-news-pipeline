# Experiment: classic-baseline-500-stub

Duration: 3.5s — processed 500, closed 481 episodes, cache 0 hits / 609 misses.

## Totals

- entries clustered: 500
- episodes: 481  storylines: 105  cards: 962
- singleton-episode rate: 0.965
- multi-episode storylines: 50

## Attach mix (entry -> episode)

- new_cluster: 467
- adjudicated_new: 14
- adjudicated_join: 10
- near_dup: 9

## Attach mix (episode -> storyline)

- adjudicated_join: 376
- new_storyline: 105

## Top chains

- [40 episodes] CDC Launches New Campaign to Address Youth Substance Use and Mental Health
- [35 episodes] Readout from Secretary of the Treasury Scott Bessent’s Meeting with German Vice Chancellor and Minister of Finance Lars Klingbeil
- [29 episodes] VA announces Sam Brown as new Under Secretary for Memorial Affairs
- [23 episodes] WHAT THEY ARE SAYING: Leaders Praise the EPA for Launching Largest Deregulatory Action in U.S. History with Proposal to Rescind Obama-Era Endangerment Finding | US EPA
- [16 episodes] FTC Sends Money to Student Loan Borrowers Harmed by Debt Relief Scam
- [16 episodes] FDA Names Top HHS Lawyer as Chief Counsel
- [15 episodes] Justice Department Dismisses Race-Based 44-Year-Old Consent Decree
- [15 episodes] FTC Obtains Permanent Ban of E-Commerce Business Opportunity Scheme Operator
- [14 episodes] Avery Ohliger Receives Volunteer Service Impact Award - Upper Delaware Scenic & Recreational River (U.S. National Park Service)
- [14 episodes] Justice Department Opens Investigation into Flix North America, FlixBus, and Greyhound for Disability Discrimination

## Topics

- themes: 0  categories: 23 seed + 0 llm
- singleton-theme rate: None

## LLM health

- overview fallback rate: 0.0
- uncategorized themes: 0
- deferred/unassigned storylines: 105
- theme creator errors: 0
- model errors: {}

## Theme attach mix (storyline -> theme)


## Top themes


## Config

```json
{
  "adjudicator_model": "@cf/meta/llama-3.3-70b-instruct-fp8-fast",
  "ambient_ema_ceiling": 3.0,
  "audit_model": "@cf/meta/llama-3.3-70b-instruct-fp8-fast",
  "cluster_join_threshold": 0.78,
  "dedupe_window_hours": 72.0,
  "embedding_model": "@cf/baai/bge-m3",
  "engine": "classic",
  "enricher_model": "@cf/meta/llama-3.1-8b-instruct-fast",
  "enricher_version": 1,
  "enrichment_enabled": true,
  "episode_dormancy_hours": 4.0,
  "judge_model": "@cf/meta/llama-3.3-70b-instruct-fp8-fast",
  "near_dup_threshold": 0.9,
  "prompt_version": 1,
  "publisher_weight_version": 1,
  "rank_audit_facets": "global,category",
  "rank_audit_top_k": 30,
  "rank_audit_window": 3,
  "rubric_version": 1,
  "spine_embed_source": "enriched",
  "spine_episode_gap_hours": 48.0,
  "spine_sim_floor": 0.6,
  "spine_theme_keep_overlap": 0.5,
  "spine_theme_link_sim": 0.55,
  "spine_theme_min_size": 5,
  "spine_theme_sweep_interval_hours": 168.0,
  "spine_top_k": 3,
  "storyline_sim_floor": 0.6,
  "tau_seconds": 124600.0,
  "theme_demotion_cohesion_floor": 0.4,
  "theme_knn_k": 5,
  "theme_promotion_cluster_floor": 0.6,
  "theme_promotion_cohesion_floor": 0.55,
  "theme_promotion_min_active_days": 3,
  "theme_promotion_min_storylines": 4,
  "theme_sim_floor": 0.55,
  "theme_sweep_interval_hours": 24.0,
  "topics_enabled": false
}
```
