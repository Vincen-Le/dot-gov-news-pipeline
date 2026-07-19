# spine vs classic — stub-scale A/B (2026-07)

**Scope caveat (read this first):** both runs below use `StubModels`
(`stub-bow-256`: hashed bag-of-words embeddings, entity-overlap adjudication,
templated compression) over 500 entries, on separate single-purpose
databases (`complex_db` for classic, `spine_db` for spine — see
`config/pipelines.json`). This exercises **plumbing and structure only**:
whether each engine's decision tree gets exercised, whether the master-node
invariant holds, whether reports/attach-mixes/theme sweeps wire up end to
end. It is **not** a clustering-quality comparison — the stub adjudicator
merges on raw entity-set overlap with no ambient-entity dampening or real
semantic similarity, so both engines over-merge on shared federal-agency
entities (see Qualitative QA below). The real-model 500-entry baseline pair
(`classic-baseline-500` / `spine-baseline-500`, `--limit 500` without
`--stub`) is **deferred**: real Workers-AI features currently exist for only
~152 of 9657 corpus entries while a concurrent session rebuilds them; this
doc will be updated with a real-model pair once that rebuild lands. Golden
labels (`golden_news_entries`) are unvetted and are not cited anywhere below.

Reports: `docs/eval/classic-baseline-500-stub/report.md` (run
`f0dcf633-3cc1-4055-b87e-477f06b6279d`), `docs/eval/spine-baseline-500-stub/report.md`
(run `c673040d-f056-48ee-a150-f98aca117c1c`). Both replayed the same first
500 entries (by `published_at, id`) off freshly-reset, freshly-`prepare
--stub`'d corpora (600 entries embedded per db, so the 500-entry replay
slice is fully covered).

## Operational metrics

| Metric                              | classic (complex_db) | spine (spine_db) |
|--------------------------------------|----------------------|-------------------|
| entries clustered                   | 500                  | 500               |
| episodes                            | 481                  | 386               |
| singleton-episode rate              | 0.965 (464/481)      | 0.930 (359/386)   |
| storylines                          | 105                  | 349               |
| multi-episode storylines            | 50                   | 25                |
| max episodes in one storyline       | 40                   | 4                 |
| event_cards                         | 962                  | 1121              |
| themes                              | 0                    | 3                 |
| singleton-theme rate                | n/a (0 themes)       | 0.0               |
| episode_dormancy closures           | 481                  | 386               |
| overview fallback rate              | 0.0                  | 0.0               |
| deferred/unassigned storylines      | 105                  | 343               |
| model errors                        | {}                   | {}                |
| duration                            | 3.5s                 | 7.6s              |
| decision-cache hits / misses         | 0 / 609              | 40 / 222          |

### Attach mix — entry → episode

| attach_method     | classic | spine |
|-------------------|---------|-------|
| new_cluster       | 467     | 238   |
| adjudicated_new   | 14      | 148   |
| adjudicated_join  | 10      | 114   |
| near_dup          | 9       | 0     |

### Attach mix — episode → storyline

| attach_method    | classic | spine |
|------------------|---------|-------|
| new_storyline    | 105     | 349   |
| adjudicated_join | 376     | 37    |

Both engines exercise their full decision tree (join/spawn plus adjudicated
paths nonzero); spine has no `near_dup` path at this stage (its retrieval
step folds near-duplicates into the same top-k judge call instead of a
separate near-dup short-circuit).

### Storyline size distribution (episode_count, merged_into is null)

| episodes | classic storylines | spine storylines |
|----------|---------------------|-------------------|
| 1        | 55                  | 324               |
| 2        | 12                  | 14                |
| 3        | 6                   | 10                |
| 4        | 6                   | 1                 |
| 5–7      | 6                   | 0                 |
| 8–16     | 16                  | 0                 |
| 23–40    | 4                   | 0                 |

classic has a long tail of very large storylines (up to 40 episodes);
spine's distribution is tight, capped at 4 episodes. This is a direct
consequence of classic's five-stage pipeline joining episodes into
storylines via a second, separate adjudication pass over the same weak
entity signal (`adjudicated_join: 376` at the episode→storyline stage,
on top of whatever joined at entry→episode), while spine's single
listwise-judge-per-article step (`spine_top_k=3`) caps how many candidates
a new article is ever compared against, structurally limiting runaway
merges even under a noisy judge.

## Master-node invariant

```sql
select count(*) from public.storylines s
where s.merged_into is null
  and not exists (select 1 from public.event_cards c
                  where c.storyline_id = s.id and c.kind = 'overview');
```

Result: **0** on both `complex_db` and `spine_db` — every live storyline
has an overview card in both engines.

## Qualitative QA (manual inspection, stub run)

Sampled storylines across the size distribution in both engines (large
chains, mid-size chains, and a random sample of 2-episode chains — roughly
20 storylines per engine, entries pulled via `episode_entries` join
`news_entries`).

**Both engines over-merge on ambient entities, not real events.** The stub
adjudicator (`pipeline/stub.py: adjudicate_same_event`) does raw entity-set
overlap with no ambient-entity dampening (classic's `ambient_ema_ceiling`
config knob exists but the stub judge doesn't consult it). The result is
visible in every large chain inspected:

- **classic's largest chain** ("CDC Launches New Campaign to Address Youth
  Substance Use and Mental Health," 40 episodes / 42 entries) is a grab-bag
  of unrelated National Park Service, State Department diplomatic-readout,
  USDA/FDA, and EPA press releases from mid-July through early August —
  none actually about the CDC campaign in the headline. This is the
  clearest over-merge case found: 40 unrelated stories merged purely
  because they share ambient agency-name entities.
- **classic's next several chains** (16, 15, 14, 13, 12 episodes) show the
  same pattern: e.g. "FTC Sends Money to Student Loan Borrowers" pulls in
  DOJ rule-making, a second unrelated DOJ investigation, and a UNESCO
  withdrawal notice; "Former NFL Player Convicted of Dog Fighting" pulls in
  five unrelated fraud/sentencing press releases sharing only "Department
  of Justice" as an entity.
- **spine's largest chain** ("National Park Service Seeks Information on
  Missing Person at Grand Canyon," 4 episodes / 19 entries) shows the same
  failure mode at smaller scale: NPS press releases from a dozen unrelated
  parks (Hawai'i Volcanoes, Cape Hatteras, Yellowstone, Glacier Bay, Death
  Valley, Isle Royale, etc.) merged on the shared "National Park Service"
  entity, none actually about the missing-person incident in the headline.
- Small (2-episode) chains show the same root cause on both sides, e.g.
  classic merges "Republic of Vanuatu National Day" with "Peru National
  Day" (same recurring template, different countries — a false merge); spine
  merges "Justice Department Announces Winners of the Access to Justice
  Prize" with two unrelated DOJ announcements. A few 2-episode chains on
  both sides are plausible recurring-bulletin series rather than a single
  event (e.g. spine's "Public Schedule" chain groups 15 daily State
  Department schedule notices — arguably correct if the intent is "the
  recurring Public Schedule feature," arguably over-merged if the intent is
  one storyline per calendar day).

**Master-node quality:** every sampled storyline (both engines) had a
coherent overview card whose headline matched its *first* episode, even
when later episodes were unrelated (confirming the master-node invariant
holds structurally, but also that the compressor has no signal to detect
when a storyline has drifted off-topic — a stub-compressor limitation:
`compress_overview` templates from the episode cards it's given, it can't
know they don't belong together).

**Structural difference, not quality difference, at this scale:** classic's
over-merge is far worse in raw numbers (40-episode chains vs. spine's cap of
4) because classic performs two independent weak-entity-overlap joins
(entry→episode, then episode→storyline) while spine's listwise top-k judge
makes one comparison per new article against a small candidate set. This
gives spine natural (if accidental, at stub scale) damage control, not
because its judgment is better — the same entity-overlap stub is doing the
deciding in both cases. **This conclusion is expected to change with real
embeddings and a real judge model**, which is exactly what the deferred
real-model pair will test.

## What this does *not* tell us

- Whether spine's simplified design produces better clustering than classic
  under real embeddings/judge — unmeasured, pending feature rebuild.
- Whether spine's tighter storyline sizes reflect better precision or just
  a more conservative `spine_top_k=3` retrieval window — only distinguishable
  with a real similarity signal.
- Golden-set precision/recall for either engine — golden labels are
  unvetted per `pipeline/golden.py` status and out of scope here.

## Next step

Once the concurrent feature-rebuild session finishes real Workers-AI
embeddings for the corpus, run
`uv run python -m pipeline.cli experiment classic-baseline-500 --limit 500`
and `LAB_ENGINE=spine uv run python -m pipeline.cli experiment
spine-baseline-500 --limit 500` against `complex_db` / `spine_db`
respectively, and replace/extend this doc with the real-model comparison.
