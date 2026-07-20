# Experiment: simple-v1-days-010-012

Duration: 428.5s — processed 56, closed 55 episodes, cache 0 hits / 35 misses.

## Totals

- entries clustered: 315
- episodes: 303  storylines: 274  cards: 594
- singleton-episode rate: 0.964
- multi-episode storylines: 19

## Golden anchor

- mode: continue (layered on the reviewed image, no reset)
- reviewed entries verified intact: 244
- storylines primed: 218

## Attach mix (entry -> episode)

- adjudicated_new: 151
- new_cluster: 151
- adjudicated_join: 13

## Attach mix (episode -> storyline)

- new_storyline: 271
- adjudicated_join: 32

## Top chains

- [8 episodes] Rubio Holds Rapid Series of Diplomatic Meetings and Calls with Foreign Counterparts
- [6 episodes] FEMA Sets Application Deadlines for Tennessee and Kentucky Storm Survivors
- [4 episodes] US Presses for Ceasefire in Thailand-Cambodia Border Conflict
- [3 episodes] State Department Releases Routine Daily Public Schedules
- [3 episodes] FDA Reverses Course on Elevidys Gene Therapy After Deaths, Lifts Hold for Ambulatory Patients
- [3 episodes] Rubio Meets Philippine President Marcos Amid Trump White House Visit
- [3 episodes] US Agencies Coordinate Crackdown on North Korean IT Worker Revenue Schemes
- [3 episodes] USGS Monitors Ongoing Kīlauea Summit Eruption
- [2 episodes] US and Mexico Sign Agreement to End Tijuana River Sewage Crisis
- [2 episodes] EPA Opens $14M Brownfields Job Training Grant Program

## Topics

- themes: 11  categories: 22 seed + 0 llm
- singleton-theme rate: 0.0

## LLM health

- overview fallback rate: 0.0
- uncategorized themes: 10
- deferred/unassigned storylines: 220
- theme creator errors: 0
- model errors: {}

## Theme attach mix (storyline -> theme)

- sweep_join: 50
- manual: 2

## Top themes

- [14 storylines] Rubio Diplomatic Engagements Abroad ((uncategorized))
- [7 storylines] US National Day Greetings ((uncategorized))
- [6 storylines] EPA Superfund Site Cleanup Plans ((uncategorized))
- [6 storylines] IRS Taxpayer Guidance Updates ((uncategorized))
- [5 storylines] VA Benefits Expansion Updates ((uncategorized))
- [4 storylines] DOJ Consent Decree Actions ((uncategorized))
- [4 storylines] US Labor Market Economic Data Releases ((uncategorized))
- [4 storylines] USDA Actions Under Secretary Rollins ((uncategorized))
- [2 storylines] VA Weekly Research Briefs (Veterans Affairs)
- [0 storylines] EPA Superfund Cleanup Actions ((uncategorized))

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
