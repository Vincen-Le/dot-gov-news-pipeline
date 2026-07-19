# Theme Adjudicator: LLM join/spawn/merge for Stage 4

**Date:** 2026-07-18
**Status:** Approved
**Supersedes:** the KNN-majority join in `pipeline/topics.py` (commit 392bbb9)

## Problem

KNN majority vote over themed storyline centroids builds megaclusters. Observed:
theme "US Visa Sanctions Brazil" (16 storylines) absorbed Houthi sanctions,
North Korea IT-worker fraud, Harvard exchange-program investigation, Senegal
Artemis Accords, etc. — everything a State Dept press release. Mechanism: all
State press releases share boilerplate, so cross-subject pairs score ~0.55–0.65
cosine, above `theme_sim_floor = 0.55`. Each join grows the theme, which then
dominates the next storyline's KNN neighborhood (majority-vote snowball).
"US Africa Diplomatic Relations" (13) shows the same disease.

Separately: 0/146 themes have a category. Root cause: Workers AI returns
`result["response"]` as an already-parsed dict when the model emits pure JSON;
`_extract_json` runs a regex on it, raises TypeError, `classify_category`
swallows it, category stays null. Verified live — with the parse fixed, the
model classifies correctly.

## Decision summary

1. Replace the KNN majority vote with a single fast-LLM adjudication call per
   assignment. KNN (against theme centroids) only shortlists candidates.
2. The adjudicator may also direct an inline merge of candidate themes.
3. Categories need only the dict-passthrough parse fix; the existing
   `_classify` flow (spawn + join-when-null) then works as designed.
4. Forward-only: no rebuild/repair machinery. The experiment reruns from empty.
5. Model: reuse `judge_model` (`@cf/meta/llama-3.3-70b-instruct-fp8-fast`).
   ~50 storylines/day → ~50 calls/day; no cost gating.
6. Config: no new keys. `theme_sim_floor`/`theme_knn_k` become recall knobs
   for candidate generation; `theme_stick_floor` hysteresis unchanged.

## Stage 4 flow

1. `sync()` hysteresis stick-check unchanged: cosine to own theme centroid
   ≥ `theme_stick_floor` → no work, no LLM.
2. Candidate generation: cosine of storyline centroid against **theme
   centroids** (not storyline KNN). Top `theme_knn_k` (5) themes above
   `theme_sim_floor` (0.55).
3. No candidates → deterministic spawn (existing `_spawn` path unchanged:
   LLM names theme, falls back to headline, then `_classify`).
4. Candidates exist → one adjudicator call. Input: storyline headline +
   summary; per candidate theme: id, name, storyline count, up to 3
   most-recent member storyline headlines. Output JSON:

   ```json
   {"decision": "join" | "spawn",
    "theme_id": "<candidate id, only when join>",
    "new_theme_name": "<2-5 word label, only when spawn>",
    "merge_theme_ids": ["<candidate ids naming the same topic>"],
    "reason": "one sentence"}
   ```

5. Apply order: merge first (so a join targets the merged survivor), then
   join or spawn.

## Guards

- `theme_id` not among presented candidates → treat as spawn (hallucinated-ID
  guard, mirrors `test_invalid_theme_id_from_llm_treated_as_spawn` precedent).
- `merge_theme_ids` filtered to presented candidates; fewer than 2 valid →
  no merge.
- Adjudicator call raises or returns unparseable output → fall back to the
  current KNN majority vote over storyline centroids (assignment never blocks
  on the LLM). Fallback joins keep `theme_attach_method = 'knn_join'`.
- Spawn with missing/empty `new_theme_name` → existing namer path
  (`models.name_theme`, headline fallback).

## Merge semantics

Winner = candidate in `merge_theme_ids` with the highest storyline count
(ties: oldest `created_at`). For each loser:

- repoint `storylines.theme_id` → winner,
- set `topic_themes.merged_into` → winner,
- zero the loser's `storyline_count`.

Then recompute the winner centroid from member storyline centroids. Winner
keeps its `display_name` and `category_id`. One new write RPC
(`merge_topic_theme(p_loser_id, p_winner_id)`) in the existing
clustering-write-RPCs style; loop per loser from Python.

Candidate generation, `all_themes()`, and theme listings must exclude themes
with `merged_into is not null`.

## Audit columns

- LLM join: `theme_attach_method = 'adjudicated_join'` (already in the
  storylines check constraint), `theme_similarity` = cosine to the joined
  theme centroid, `theme_reason` = LLM reason.
- Spawn: `new_theme` with adjudicator reason (or the existing no-candidates
  reason).
- KNN fallback: `knn_join` with the existing vote reason plus
  `adjudicator_error: <exc>` suffix.

## Category parse fix

`_extract_json(text)` in `pipeline/ai.py`: if `text` is already a `dict`,
return it unchanged; otherwise regex + `json.loads` as today. Fixes
`classify_category` (0/146 themes categorized) and hardens every other JSON
consumer of `_chat` against the same Workers AI behavior.

## Prompts

New `THEME_ADJUDICATOR_SYSTEM` + `build_theme_adjudicator_prompt(storyline,
candidates)` in `pipeline/prompts.py`, following the existing
respond-with-JSON-only house style. Candidates serialized as a JSON array of
`{theme_id, name, storyline_count, recent_headlines}`.

## Store surface

Candidate selection stays in Python (themes are in memory already via
`all_themes()`, which already excludes merged themes). New read:
`theme_recent_headlines(theme_id, limit=3)` — storylines joined to
`event_cards` via `latest_card_id` (same headline source as
`storyline_theme_state`), newest `newest_entry_at` first. New write:
`merge_theme(loser_id, winner_id)` wrapping the RPC.

## Stub + fakes

`pipeline/stub.py` gains a deterministic `adjudicate_theme` (e.g. always
spawn) so `topics_enabled` runs offline. Test fakes extend the existing
fake-models pattern.

## Testing

- join / spawn / spawn-on-hallucinated-id
- merge directive applied (storylines repointed, `merged_into` set, centroid
  recomputed, join lands on survivor)
- merge with <2 valid ids ignored
- adjudicator exception → KNN fallback join with `knn_join` method
- `_extract_json` dict passthrough
- merged themes excluded from candidate pools and listings

## Known risk

Boilerplate similarity that built the megaclusters also shapes the candidate
pool; wrong candidates may crowd the top-5. Mitigation: spawn is always
available, and member headlines give the adjudicator signal to reject bad
candidates. If pools look noisy after the rerun, raise `theme_knn_k`, not the
floor.
