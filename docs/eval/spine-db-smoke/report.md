# Experiment: spine-db-smoke

Duration: 0.7s — processed 100, closed 84 episodes, cache 0 hits / 40 misses.

## Totals

- entries clustered: 100
- episodes: 84  storylines: 82  cards: 250
- singleton-episode rate: 0.964
- multi-episode storylines: 2

## Attach mix (entry -> episode)

- new_cluster: 60
- adjudicated_new: 24
- adjudicated_join: 16

## Attach mix (episode -> storyline)

- new_storyline: 82
- adjudicated_join: 2

## Top chains

- [2 episodes] Vessel grounds at Cape Hatteras National Seashore south of off-road vehicle ramp 38 - Cape Hatteras National Seashore (U.S. National Park Service)
- [2 episodes] Less Than One Week Left to Apply for FEMA Assistance Following April Flooding
- [1 episodes] Joint Statement by Secretary of State Marco Rubio and Secretary of Health and Human Services Robert F. Kennedy on the United States’ Rejection of 2024 Amendments to the International Health Regulations (2005) - United States Department of State
- [1 episodes] Public Schedule – July 21, 2025 - United States Department of State
- [1 episodes] (CB-25-12) Information and Reporting Reminders for the Fiscal Operations Report for 2024–25 and Application to Participate for 2026–27 (FISAP)
- [1 episodes] (GEN-25-04) Federal Student Loan Program Provisions Effective Upon Enactment Under the One Big Beautiful Bill Act
- [1 episodes] 30 Weir Farm Artist Collective Members Featured in Exhibit at Kershner Gallery - Weir Farm National Historical Park (U.S. National Park Service)
- [1 episodes] 5 Things to Know About Powerful New U.S.-India Satellite, NISAR
- [1 episodes] A new framework for guiding management decisions for amphibians in an uncertain future
- [1 episodes] Announcement of Visa Restrictions on Brazilian Judicial Officials and their Immediate Family Members - United States Department of State

## Topics

- themes: 0  categories: 23 seed + 0 llm
- singleton-theme rate: None

## LLM health

- overview fallback rate: 0.0
- uncategorized themes: 0
- deferred/unassigned storylines: 82
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
