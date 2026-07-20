# Experiment: simple-v1-days-004-006

Duration: 1740.0s — processed 117, closed 110 episodes, cache 0 hits / 0 misses.

## Totals

- entries clustered: 164
- episodes: 157  storylines: 150  cards: 314
- singleton-episode rate: 0.968
- multi-episode storylines: 6

## Golden anchor

- mode: continue (layered on the reviewed image, no reset)
- reviewed entries verified intact: 47
- storylines primed: 47

## Attach mix (entry -> episode)

- new_cluster: 98
- adjudicated_new: 59
- adjudicated_join: 7

## Attach mix (episode -> storyline)

- new_storyline: 149
- adjudicated_join: 8

## Top chains

- [3 episodes] Rubio Meets Philippine President Marcos Amid Trump White House Visit
- [2 episodes] FEMA Aid Deadline Nears for Tennessee Storm Survivors
- [2 episodes] US Cracks Down on Haitian Gang Ties Among Legal Residents
- [2 episodes] USGS Monitors Ongoing Kīlauea Summit Eruption with UAS Survey and Episode 29 Fountaining
- [2 episodes] USPS Celebrates 250th Anniversary with Stamps and Events
- [2 episodes] VA's Nursing Home to Home program helps Veterans return to community living
- [1 episodes] EPA Secures Vistra Cleanup Deal for Moss Landing Battery Fire Site
- [1 episodes] HHS, FDA and USDA Target Health Risks of Ultra-Processed Foods
- [1 episodes] Rubio's Daily Schedule Includes Meeting with Jordanian FM
- [1 episodes] US Sanctions Houthi Petroleum and Financial Network

## Topics

- themes: 1  categories: 23 seed + 0 llm
- singleton-theme rate: 0.0

## LLM health

- overview fallback rate: 0.0
- uncategorized themes: 1
- deferred/unassigned storylines: 144
- theme creator errors: 0
- model errors: {}

## Theme attach mix (storyline -> theme)

- sweep_join: 6

## Top themes

- [6 storylines] Rubio Diplomatic Engagements Abroad ((uncategorized))

## Config

```json
{
  "adjudicator_model": "claude-sonnet-5",
  "ambient_ema_ceiling": 3.0,
  "audit_model": "claude-sonnet-5",
  "cluster_join_threshold": 0.78,
  "dedupe_window_hours": 72.0,
  "embedding_model": "@cf/baai/bge-m3",
  "engine": "spine",
  "enricher_model": "@cf/meta/llama-3.1-8b-instruct-fast",
  "enricher_version": 1,
  "enrichment_enabled": true,
  "episode_dormancy_hours": 4.0,
  "judge_model": "claude-sonnet-5",
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
