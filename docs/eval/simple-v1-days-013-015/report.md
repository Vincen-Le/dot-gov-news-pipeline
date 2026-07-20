# Experiment: simple-v1-days-013-015

Duration: 1162.5s — processed 128, closed 119 episodes, cache 0 hits / 98 misses.

## Totals

- entries clustered: 443
- episodes: 422  storylines: 376  cards: 833
- singleton-episode rate: 0.957
- multi-episode storylines: 27

## Golden anchor

- mode: continue (layered on the reviewed image, no reset)
- reviewed entries verified intact: 315
- storylines primed: 268

## Attach mix (entry -> episode)

- adjudicated_new: 240
- new_cluster: 181
- adjudicated_join: 22

## Attach mix (episode -> storyline)

- new_storyline: 372
- adjudicated_join: 50

## Top chains

- [12 episodes] Rubio Holds Series of Diplomatic Calls and Meetings with Foreign Leaders
- [6 episodes] FEMA Sets Application Deadlines for Tennessee and Kentucky Storm Survivors
- [5 episodes] State Department Releases Routine Daily Public Schedules
- [5 episodes] US Diplomacy Helps Secure Thailand-Cambodia Border Ceasefire
- [3 episodes] FDA Reverses Course on Elevidys Gene Therapy After Deaths, Lifts Hold for Ambulatory Patients
- [3 episodes] Rubio Meets Philippine President Marcos Amid Trump White House Visit
- [3 episodes] US Agencies Coordinate Crackdown on North Korean IT Worker Revenue Schemes
- [3 episodes] US Sanctions Brazilian Supreme Court Justice Alexandre de Moraes Over Bolsonaro Prosecution
- [3 episodes] USGS Expands 3D Elevation Program with State Fact Sheets and Next-Gen Model Plan
- [3 episodes] USGS Monitors Ongoing Kīlauea Summit Eruption

## Topics

- themes: 27  categories: 22 seed + 0 llm
- singleton-theme rate: 0.0

## LLM health

- overview fallback rate: 0.0
- uncategorized themes: 26
- deferred/unassigned storylines: 250
- theme creator errors: 0
- model errors: {}

## Theme attach mix (storyline -> theme)

- sweep_join: 122
- manual: 2

## Top themes

- [13 storylines] State Department Senior Diplomacy ((uncategorized))
- [10 storylines] US National Day Greetings ((uncategorized))
- [8 storylines] IRS Taxpayer Guidance Updates ((uncategorized))
- [7 storylines] EPA Brownfields Grant Awards ((uncategorized))
- [6 storylines] EPA Superfund Site Cleanup Plans ((uncategorized))
- [6 storylines] False Claims Act Settlement Wave ((uncategorized))
- [6 storylines] Routine BLS Labor Data Releases ((uncategorized))
- [6 storylines] USDA Actions Under Secretary Rollins ((uncategorized))
- [5 storylines] DOJ Consent Decree Actions ((uncategorized))
- [5 storylines] EPA Enforcement and Cleanup Settlements ((uncategorized))

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
  "prompt_version": 2,
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
  "spine_theme_min_size": 4,
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
