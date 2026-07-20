# QA Surgery Patterns

Direct SQL against `simple_v1_db`, one transaction per surgery, verify
counts before commit. Promote refreshes golden rows afterward — never
edit `golden_*` tables by hand. All hand-set fields use
`*_method='manual'` and a `Manual QA (<date>): <why>` reason.

## Merge storyline B into A

1. `update episodes set storyline_id=A where storyline_id=B`
2. `update event_cards set storyline_id=A where storyline_id=B and kind='episode'`
3. Supersede B's live overview: `update event_cards set superseded_by=<A's
   live overview id> where storyline_id=B and kind='overview' and
   superseded_by is null` — supersede, don't delete (rank snapshots
   reference card ids).
4. `update storylines set merged_into=A where id=B`
5. Recompute A: entry/episode counts, first/newest_entry_at,
   distinct_feeds (count distinct news_source_id), entity_set/agency_ids
   union, source_weight_max max, centroid = normalized mean of member
   episode centroids (`pipeline.shared.vectors.unpack_fp16/pack_fp16`).
6. Rewrite A's overview: headline (keep current-state), summary, timeline
   (one item per episode, newest-first, `episode_id` keys must be episode
   ids, NOT card ids), `newest_entry_at`, and
   `rank_key = public.compute_rank_key(rubric, rubric_version,
   <n_agencies>::integer, <feeds>::integer, <swm>::real, <newest>::timestamptz)`.

## Split episode E out of storyline A into new storyline B

1. Insert `storylines` row B: copy category (or set per reader test),
   `category_method='manual'`, centroid/entity_set/event_keys/dates from
   E, counts 1/1.
2. Move E + its episode card to B.
3. Insert overview card v1 for B (headline/summary from episode card,
   single timeline item, `judge_model='golden-human'`, rank_key via
   `compute_rank_key`; reuse parent's rubric json or null).
4. `update storylines set latest_card_id=<new overview> where id=B`
5. Recompute A (counts, centroid, entity union) + drop E's timeline item
   from A's overview.

## Re-home entry between episodes (per-declaration purity)

Update BOTH `news_entries.episode_id` AND `episode_entries.episode_id`,
then recompute each touched episode (entry_count, centroid = mean of
entry embeddings, entity/event_keys union, dates) and the storyline
centroid. New episode needs its own episode card
(`judge_model='golden-human'`).

## Manual theme

Insert `topic_themes` with `name_model='golden-human'` (this exempts it
from sweep demotion — guard in `spine/themes.py`), centroid = normalized
mean of member storyline centroids; assign members with
`theme_attach_method='manual'`. Guard covers demotion only — a later
sweep can still poach members into a confirmed cluster.

## Recategorize

`update storylines set category_id=<id>, category_method='manual',
category_reason='Manual QA (<date>): <why>'`. Reader test: prefer the
affected domain over the government mechanism; if the storyline is in a
theme, all theme members must share one category (golden one-parent rule).
