# Experiment: jul19-final-best-checkpoint

Duration: 4610.4s — processed 150, closed 141 episodes, cache 32 hits / 104 misses.

## Totals

- entries clustered: 150
- episodes: 141  storylines: 127  cards: 282
- singleton-episode rate: 0.95
- multi-episode storylines: 13

## Input topology curation

- label set: 361d307e-0718-49a0-8e81-77a754f635ad
- deterministic seed: jul19-loop-window
- requested multi-episode entry share: 30.0%
- requested multi-entry single-episode entry share: 10.0%
- actual expected entry counts: {'singleton_episode_storyline': 91, 'multi_episode_storyline': 44, 'multi_entry_single_episode': 15}
- entries expected to be in multi-entry episodes: 15

## Attach mix (entry -> episode)

- new_cluster: 140
- near_dup: 7
- adjudicated_join: 2
- adjudicated_new: 1

## Attach mix (episode -> storyline)

- new_storyline: 127
- adjudicated_join: 14

## Top chains

- [3 episodes] October events for Honouliuli National Historic Site 10th Anniversary Commemoration - Honouliuli National Historic Site (U.S. National Park Service)
- [2 episodes] American Conservation Experience (ACE) Trail Crews at Abraham Lincoln Birthplace - Abraham Lincoln Birthplace National Historical Park (U.S. National Park Service)
- [2 episodes] Two Days Left To Apply For FEMA Assistance For Kentuckians Affected By May Tornadoes
- [2 episodes] 2025_08_20_Hurricane_Erin_Advisory_2 - Cape Lookout National Seashore (U.S. National Park Service)
- [2 episodes] Deputy Secretary Landau’s Meeting with Honduran Foreign Minister Bu - United States Department of State
- [2 episodes] DHS Terminates 2021 Designation of Venezuela for Temporary Protected Status
- [2 episodes] FTC and DOJ Host Listening Session on Lowering Americans’ Drug Prices Through Competition
- [2 episodes] Grand Canyon South Rim Implements Water Conservation Measures — Sept. 29, 2025 - Grand Canyon National Park (U.S. National Park Service)
- [2 episodes] Hours to Change at Disaster Recovery Centers in Tennessee
- [2 episodes] Imposing Further Sanctions in Response to the ICC’s Ongoing Threat to Americans and Israelis - United States Department of State

## Topics

- themes: 3  categories: 23 seed + 0 llm
- singleton-theme rate: 0.0

## LLM health

- overview fallback rate: 0.163
- uncategorized themes: 0
- deferred/unassigned storylines: 113
- theme creator errors: 0
- model errors: {'category_classifier': 1}

## Theme attach mix (storyline -> theme)

- promoted: 12
- criterion_join: 2

## Top themes

- [6 storylines] International Conflict Diplomacy (Foreign Affairs & Trade)
- [4 storylines] Disaster Relief Deadline (Disaster Response & Emergency)
- [4 storylines] National Park Tourism (Economy & Labor)

## Config

```json
{
  "adjudicator_model": "@cf/meta/llama-3.3-70b-instruct-fp8-fast",
  "ambient_ema_ceiling": 3.0,
  "audit_model": "@cf/meta/llama-3.3-70b-instruct-fp8-fast",
  "cluster_join_threshold": 0.78,
  "dedupe_window_hours": 72.0,
  "embedding_model": "@cf/baai/bge-m3",
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
  "topics_enabled": true
}
```
