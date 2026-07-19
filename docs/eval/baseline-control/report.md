# Experiment: baseline-control

Duration: 83.6s — processed 7695, closed 5970 episodes, cache 1884 hits / 304 misses.

## Totals

- entries clustered: 7695
- episodes: 5970 storylines: 5550 cards: 11940
- singleton-episode rate: 0.866
- multi-episode storylines: 109

## Attach mix (entry -> episode)

- new_cluster: 4216
- adjudicated_new: 1754
- centroid_join: 886
- near_dup: 838
- event_key: 1

## Attach mix (episode -> storyline)

- new_storyline: 5550
- adjudicated_join: 326
- entity_candidate: 64
- event_key: 30

## Top chains

- [110 episodes] State Department Hosts Inaugural Meeting of the Economic Diplomacy Action Group - United States Department of State
- [29 episodes] Treasury Announces Frank Bisignano to Lead Next Phase of Trump Accounts Expansion
- [27 episodes] READOUT: Secretary of the Treasury Scott Bessent's Meeting with Prime Minister of the Republic of Iraq Ali Al-Zaidi
- [21 episodes] United States and Tanzania Advance Global Fight Against Infectious Diseases Through Bilateral Health Memorandum of Understanding - United States Department of State
- [21 episodes] READOUT: Financial Stability Oversight Council Meeting on July 15, 2026
- [18 episodes] Joint Statement on the Fifth Meeting of the Joint Security Coordination Mechanism for the Peace Agreement between the Democratic Republic of the Congo and the Republic of Rwanda - United States Department of State
- [12 episodes] Announcement of Cooperation Between the Government of the Republic of Iraq and the Government of the Syrian Arab Republic on the Rehabilitation and Reconstruction of the Iraq-Syria Crude Oil Pipeline - United States Department of State
- [11 episodes] Metropolitan Area Employment and Unemployment (Monthly) News Release
- [10 episodes] Report to the Secretary of the Treasury from the Treasury Borrowing Advisory Committee
- [9 episodes] (GEN-26-02) Implementing New Institutional Authority to Set Program-Level Federal Student Loan Limits

## Topics

- themes: 0 categories: 23 seed + 0 llm
- singleton-theme rate: None

## Theme attach mix (storyline -> theme)

## Top themes

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
  "topics_enabled": false
}
```
