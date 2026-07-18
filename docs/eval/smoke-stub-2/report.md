# Experiment: smoke-stub-2

Duration: 1.7s — processed 300, closed 259 episodes, cache 36 hits / 0 misses.

## Totals

- entries clustered: 300
- episodes: 259  storylines: 259  cards: 259
- singleton-episode rate: 0.911
- multi-episode storylines: 0

## Attach mix (entry -> episode)

- new_cluster: 223
- adjudicated_new: 36
- centroid_join: 21
- near_dup: 20

## Attach mix (episode -> storyline)

- new_storyline: 259

## Top chains

- [1 episodes] Dawn Ceremony on August 6 at Bissell Park in Oak Ridge - Manhattan Project National Historical Park (U.S. National Park Service)
- [1 episodes] Public Schedule – July 28, 2025 - United States Department of State
- [1 episodes] New River Gorge NPP Releases a Finding of No Significant Impact for the Proposed Demolition of Historic Structures - New River Gorge National Park & Preserve (U.S. National Park Service)
- [1 episodes] Public Schedule – July 22, 2025 - United States Department of State
- [1 episodes] Secretary Rubio’s Call with Malaysian Foreign Minister Hasan - United States Department of State
- [1 episodes] Temporary road closures and campfire restrictions due to increased fire danger in Hawaiʻi Volcanoes National Park - Hawaiʻi Volcanoes National Park (U.S. National Park Service)
- [1 episodes] Joint Statement by Secretary of State Marco Rubio and Secretary of Health and Human Services Robert F. Kennedy on the United States’ Rejection of 2024 Amendments to the International Health Regulations (2005) - United States Department of State
- [1 episodes] Secretary Rollins Unveils Weeklong Celebration of American Agriculture with the Great American Farmers Market
- [1 episodes] Egypt National Day - United States Department of State
- [1 episodes] USDA Announces Daily Program Celebrating the Great American Farmers Market on the National Mall

## Config

```json
{
  "adjudicator_model": "@cf/meta/llama-3.3-70b-instruct-fp8-fast",
  "ambient_ema_ceiling": 3.0,
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
  "rubric_version": 1,
  "storyline_sim_floor": 0.6,
  "tau_seconds": 124600.0
}
```
