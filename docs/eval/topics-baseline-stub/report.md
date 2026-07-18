# Experiment: topics-baseline-stub

Duration: 176.0s — processed 7695, closed 5970 episodes, cache 1921 hits / 5837 misses.

## Totals

- entries clustered: 7695
- episodes: 5970  storylines: 5521  cards: 11940
- singleton-episode rate: 0.866
- multi-episode storylines: 112

## Attach mix (entry -> episode)

- new_cluster: 4216
- adjudicated_new: 1754
- centroid_join: 886
- near_dup: 838
- event_key: 1

## Attach mix (episode -> storyline)

- new_storyline: 5521
- adjudicated_join: 362
- entity_candidate: 57
- event_key: 30

## Top chains

- [100 episodes] State Department Hosts Inaugural Meeting of the Economic Diplomacy Action Group - United States Department of State
- [35 episodes] NASA Welcomes Serbia as Newest Artemis Accords Signatory
- [31 episodes] United States and CARICOM IMPACS Sign Landmark Biometrics and Data Sharing Partnership Memorandum of Cooperation - United States Department of State
- [29 episodes] Understanding the Working Families Tax Cuts: Individual Tax Provisions — YouTube video text script
- [27 episodes] READOUT: Secretary of the Treasury Scott Bessent's Meeting with Prime Minister of the Republic of Iraq Ali Al-Zaidi
- [24 episodes] READOUT: Financial Stability Oversight Council Meeting on July 15, 2026
- [11 episodes] Metropolitan Area Employment and Unemployment (Monthly) News Release
- [10 episodes] Trump Administration’s America First Global Health Strategy Fights Infectious Diseases Through Bilateral Health Memorandum of Understanding with Bolivia - United States Department of State
- [10 episodes] Report to the Secretary of the Treasury from the Treasury Borrowing Advisory Committee
- [9 episodes] (GENERAL-26-43) One Big Beautiful Bill Act NSLDS Professional Access Updates (July 2026)

## Topics

- themes: 3154  categories: 23 seed + 1 llm
- singleton-theme rate: 0.867

## Theme attach mix (storyline -> theme)

- new_theme: 3152
- adjudicated_join: 2367
- reassigned: 2

## Top themes

- [396 storylines] Message to the Colombian People on Independence Day - United States Department of State (General Government)
- [294 storylines] August 2025 events & updates at Hawai‘i Volcanoes National Park - Hawaiʻi Volcanoes National Park (U.S. National Park Service) (General Government)
- [160 storylines] The United States Welcomes the Signing of a Declaration of Principles between the Government of the Democratic Republic of the Congo and Representatives of Congo River Alliance/March 23 Movement, Facilitated by the State of Qatar - United States Department (Elections & Government Operations)
- [86 storylines] Joint Statement by Secretary of State Marco Rubio and Secretary of Health and Human Services Robert F. Kennedy on the United States’ Rejection of 2024 Amendments to the International Health Regulations (2005) - United States Department of State (Public Health)
- [82 storylines] Public Schedule – July 21, 2025 - United States Department of State (Public Health)
- [78 storylines] Deputy Secretary Landau’s Trilateral Meeting with Japanese Vice Foreign Minister Funakoshi and ROK First Vice Foreign Minister Park - United States Department of State (Foreign Affairs & Trade)
- [64 storylines] Secretary Rubio’s Call with Iraqi Prime Minister Mohammed Shiaa al-Sudani - United States Department of State (General Government)
- [52 storylines] Employment Cost Index News Release (General Government)
- [49 storylines] Photo & Video Chronology — July 17, 2025 — UAS mission at Kīlauea summit (General Government)
- [44 storylines] Hiring Veterans: Jobs of the week for July 21, 2025 (Veterans Affairs)

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
  "tau_seconds": 124600.0,
  "theme_sim_floor": 0.55,
  "theme_stick_floor": 0.5,
  "topics_enabled": true
}
```
