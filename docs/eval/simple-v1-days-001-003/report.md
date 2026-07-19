# Experiment: simple-v1-days-001-003

Duration: 769.1s — processed 47, closed 47 episodes, cache 0 hits / 10 misses.

## Totals

- entries clustered: 47
- episodes: 47  storylines: 46  cards: 140
- singleton-episode rate: 1.0
- multi-episode storylines: 1

## Attach mix (entry -> episode)

- new_cluster: 37
- adjudicated_new: 10

## Attach mix (episode -> storyline)

- new_storyline: 46
- adjudicated_join: 1

## Top chains

- [2 episodes] Secretary Rubio’s Call with Djiboutian President Guelleh - United States Department of State
- [1 episodes] CFTC Extends No-Action Letter on Position Aggregation
- [1 episodes] Deputy Secretary Landau’s Trilateral Meeting with Japanese Vice Foreign Minister Funakoshi and ROK First Vice Foreign Minister Park - United States Department of State
- [1 episodes] EPA Announces Reduction in Force and Reorganization
- [1 episodes] EPA Awards $1M to Flint Hills Regional Council for Brownfields Revolving Loan Fund
- [1 episodes] EPA Proposes Cleanup Plan for Contaminated Groundwater Superfund Site
- [1 episodes] EPA Reaffirms Indian Policy
- [1 episodes] FDA Halts Sarepta Gene Therapy Distribution and Trials
- [1 episodes] Federal Student Loan Program Provisions Take Effect
- [1 episodes] Fire Response at Lake Powell

## Topics

- themes: 0  categories: 23 seed + 0 llm
- singleton-theme rate: None

## LLM health

- overview fallback rate: 0.043
- uncategorized themes: 0
- deferred/unassigned storylines: 46
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
