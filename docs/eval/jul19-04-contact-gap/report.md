# Experiment: jul19-04-contact-gap

Duration: 4259.4s — processed 150, closed 140 episodes, cache 68 hits / 66 misses.

## Totals

- entries clustered: 150
- episodes: 140  storylines: 128  cards: 280
- singleton-episode rate: 0.943
- multi-episode storylines: 11

## Input topology curation

- label set: acdfcb17-e476-4ee9-a735-d0f4a086641b
- deterministic seed: jul19-loop-window
- requested multi-episode entry share: 30.0%
- requested multi-entry single-episode entry share: 10.0%
- actual expected entry counts: {'singleton_episode_storyline': 91, 'multi_episode_storyline': 44, 'multi_entry_single_episode': 15}
- entries expected to be in multi-entry episodes: 15

## Attach mix (entry -> episode)

- new_cluster: 139
- near_dup: 8
- adjudicated_join: 2
- adjudicated_new: 1

## Attach mix (episode -> storyline)

- new_storyline: 128
- adjudicated_join: 12

## Top chains

- [3 episodes] October events for Honouliuli National Historic Site 10th Anniversary Commemoration - Honouliuli National Historic Site (U.S. National Park Service)
- [2 episodes] American Conservation Experience (ACE) Trail Crews at Abraham Lincoln Birthplace - Abraham Lincoln Birthplace National Historical Park (U.S. National Park Service)
- [2 episodes] Two Days Left To Apply For FEMA Assistance For Kentuckians Affected By May Tornadoes
- [2 episodes] 2025_08_20_Hurricane_Erin_Advisory_2 - Cape Lookout National Seashore (U.S. National Park Service)
- [2 episodes] DHS Terminates 2021 Designation of Venezuela for Temporary Protected Status
- [2 episodes] FTC and DOJ Host Listening Session on Lowering Americans’ Drug Prices Through Competition
- [2 episodes] Grand Canyon South Rim Implements Water Conservation Measures — Sept. 29, 2025 - Grand Canyon National Park (U.S. National Park Service)
- [2 episodes] Hours to Change at Disaster Recovery Centers in Tennessee
- [2 episodes] Imposing Further Sanctions in Response to the ICC’s Ongoing Threat to Americans and Israelis - United States Department of State
- [2 episodes] NASA Launches 2026 Gateways to Blue Skies Competition

## Topics

- themes: 3  categories: 23 seed + 0 llm
- singleton-theme rate: 0.0

## LLM health

- overview fallback rate: 0.129
- uncategorized themes: 0
- deferred/unassigned storylines: 111
- theme creator errors: 0
- model errors: {'category_classifier': 2, 'adjudicator': 1}

## Theme attach mix (storyline -> theme)

- promoted: 12
- criterion_join: 5

## Top themes

- [8 storylines] Global Conflict Diplomacy (Foreign Affairs & Trade)
- [5 storylines] Severe Weather Recovery (Disaster Response & Emergency)
- [4 storylines] National Park Economics (Economy & Labor)

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
