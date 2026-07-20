# Experiment: simple-v1-days-013-015-replay

Duration: 1577.4s — processed 128, closed 120 episodes, cache 0 hits / 102 misses.

## Totals

- entries clustered: 443
- episodes: 423  storylines: 371  cards: 808
- singleton-episode rate: 0.957
- multi-episode storylines: 29

## Golden anchor

- mode: continue (layered on the reviewed image, no reset)
- reviewed entries verified intact: 315
- storylines primed: 268

## Attach mix (entry -> episode)

- consolidation_merge: 315
- adjudicated_new: 94
- new_cluster: 26
- adjudicated_join: 8

## Attach mix (episode -> storyline)

- new_storyline: 371
- consolidation_merge: 35
- adjudicated_join: 17

## Top chains

- [11 episodes] Rubio Holds Series of Diplomatic Calls and Meetings Across Multiple Regions
- [6 episodes] FEMA Sets Application Deadlines for Tennessee and Kentucky Storm Survivors
- [5 episodes] US Diplomacy Helps Secure Thailand-Cambodia Ceasefire
- [4 episodes] State Department Releases Routine Daily Public Schedules
- [3 episodes] FDA Reverses Course on Elevidys Gene Therapy After Deaths, Lifts Hold for Ambulatory Patients
- [3 episodes] Rubio Meets Philippine President Marcos Amid Trump White House Visit
- [3 episodes] US Agencies Coordinate Crackdown on North Korean IT Worker Revenue Schemes
- [3 episodes] US Sanctions Brazilian Supreme Court Justice Alexandre de Moraes Over Bolsonaro Case
- [3 episodes] USGS Monitors Ongoing Kīlauea Summit Eruption
- [2 episodes] Treasury Outlines Record Borrowing Needs Amid Stable Markets, TBAC Weighs Buyback Expansion

## Topics

- themes: 28  categories: 22 seed + 0 llm
- singleton-theme rate: 0.036

## LLM health

- overview fallback rate: 0.0
- uncategorized themes: 19
- deferred/unassigned storylines: 219
- theme creator errors: 0
- model errors: {}

## Theme attach mix (storyline -> theme)

- new_theme: 193
- sweep_join: 120

## Top themes

- [17 storylines] EPA Superfund Cleanup Actions ((uncategorized))
- [10 storylines] US National Day Greetings (Foreign Affairs & Trade)
- [8 storylines] Rubio Diplomatic Engagements And Meetings ((uncategorized))
- [8 storylines] US Labor Market Economic Data Releases (Economy & Labor)
- [6 storylines] DOJ Consent Decree Actions (Civil Rights & Liberties)
- [6 storylines] EPA Brownfields Grant Awards ((uncategorized))
- [6 storylines] Federal Student Aid Administration Updates ((uncategorized))
- [6 storylines] FTC Enforcement Against Consumer Fraud ((uncategorized))
- [6 storylines] IRS Taxpayer Guidance Updates (Taxes & Revenue)
- [6 storylines] US Sanctions Enforcement Campaign ((uncategorized))

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
