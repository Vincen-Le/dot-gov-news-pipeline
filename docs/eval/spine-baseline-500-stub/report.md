# Experiment: spine-baseline-500-stub

Duration: 7.6s — processed 500, closed 386 episodes, cache 40 hits / 222 misses.

## Totals

- entries clustered: 500
- episodes: 386  storylines: 349  cards: 1121
- singleton-episode rate: 0.93
- multi-episode storylines: 25

## Attach mix (entry -> episode)

- new_cluster: 238
- adjudicated_new: 148
- adjudicated_join: 114

## Attach mix (episode -> storyline)

- new_storyline: 349
- adjudicated_join: 37

## Top chains

- [4 episodes] National Park Service Seeks Information on Missing Person at Grand Canyon National Park - Grand Canyon National Park (U.S. National Park Service)
- [3 episodes] Public Schedule – August 4, 2025 - United States Department of State
- [3 episodes] During the Great American Farmers Market, Secretary Rollins Removes Unhealthy Food from SNAP
- [3 episodes] CFTC Staff Issues No-Action Letter on SEF Order Book
- [3 episodes] EPA Region 7 Presents $500K Award to City of Red Oak, Iowa, for Brownfields Assessment Grant Selection | US EPA
- [3 episodes] Hiring Veterans: Jobs of the week for August 4, 2025
- [3 episodes] Job Openings and Labor Turnover Survey News Release
- [3 episodes] Photo & Video Chronology — August 5, 2025 — Kīlauea summit fieldwork
- [3 episodes] Secretary Rollins Announces Local Food Purchases for Communities in Need
- [3 episodes] Treasury Sanctions Global Network Supporting Iran’s Military UAV Program

## Topics

- themes: 3  categories: 23 seed + 0 llm
- singleton-theme rate: 0.0

## LLM health

- overview fallback rate: 0.0
- uncategorized themes: 3
- deferred/unassigned storylines: 343
- theme creator errors: 0
- model errors: {}

## Theme attach mix (storyline -> theme)

- sweep_join: 6

## Top themes

- [6 storylines] National Park ((uncategorized))
- [0 storylines] Department Secretary ((uncategorized))
- [0 storylines] Secretary States ((uncategorized))

## Config

```json
{
  "adjudicator_model": "@cf/meta/llama-3.3-70b-instruct-fp8-fast",
  "ambient_ema_ceiling": 3.0,
  "audit_model": "@cf/meta/llama-3.3-70b-instruct-fp8-fast",
  "cluster_join_threshold": 0.78,
  "dedupe_window_hours": 72.0,
  "embedding_model": "@cf/baai/bge-m3",
  "engine": "spine",
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
