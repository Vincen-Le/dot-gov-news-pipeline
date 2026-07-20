# Golden enrichment coordinator

This package coordinates reviewed golden-card enrichment without calling a
model. It exports trusted, partitionable card tasks; validates generated
image bundles and structured article overviews; then publishes independent
article-overview and thumbnail rows. Article-overview v2 is a content-only lane,
so editorial revisions never require regenerating or replacing an approved
thumbnail.

```bash
pnpm golden:enrich export --partitions 16
pnpm golden:enrich validate --input .data/golden-enrichment/generated
pnpm golden:enrich publish --dry-run --input .data/golden-enrichment/generated
pnpm golden:enrich publish --input .data/golden-enrichment/generated
pnpm golden:enrich validate-overviews --input .data/golden-enrichment/generated-overviews-v2
pnpm golden:enrich publish-overviews --dry-run --input .data/golden-enrichment/generated-overviews-v2
pnpm golden:enrich publish-overviews --input .data/golden-enrichment/generated-overviews-v2
```

Every command accepts `--limit`. `export` additionally accepts `--dry-run`,
`--partitions`, and `--output-dir`; validation and publishing accept repeated
`--input` flags and `--manifest-dir`.

## Continuous run

Golden construction and enrichment use separate lanes:

1. Keep building and reviewing the hosted golden mirror as usual.
2. Periodically run `export` into a versioned output directory. It snapshots
   only overview-card versions whose complete source set at the card cutoff is
   reviewed and hash-matching. Keep that snapshot until its workers finish.
3. Distribute the content-addressed partition files to parallel generation
   workers. Overview workers follow `ARTICLE_OVERVIEW_V2.md` and write
   `article-overview.v2.json`; image workers receive `imagePromptInput` and
   write image bundles. Workers receive no Supabase or R2 write credentials.
4. Validate completed card directories, visually review their image masters,
   and run `publish --dry-run` followed by `publish` in small batches.
5. Publish overview v2 artifacts independently with `publish-overviews`. It
   upgrades a matching v1 row without reading or writing R2, and refuses to
   replace a different v2 artifact unless its version is incremented.
6. Repeat the export. Already-published card IDs are idempotent, while newly
   reviewed card versions enter a stable hash partition.

Publication is the only privileged lane. Each accepted card writes one row to
`golden_event_card_article_overviews`, three content-addressed image objects to
R2, and then one row to `golden_event_card_thumbnails`. If image publication
fails after the overview insert, a retry safely resumes without replacing the
overview. Eligibility is rebuilt immediately before each card, so a stale or
no-longer-reviewed card fails before that card is mutated; cards already
completed earlier in the batch remain committed and resumable. Publication
also fails if an existing immutable card row has a different input hash; it
never silently overwrites or ignores that conflict.

Each worker output directory contains:

```text
<event-card-id>/
  overview-enrichment.v1.json
  storyline-master.png
```

The JSON carries exact source IDs, input and prompt hashes, citations, alt
text, focal point, and model provenance. The master follows
`apps/dot-gov-news-demo/DESIGN.md`: central crop-safe composition, warm-paper editorial
illustration, and no words, logos, seals, people, or photorealistic evidence.

## Trust boundary

A card is exported only when every golden source visible at its
`newest_entry_at` cutoff is `reviewed` and its current content hash still
matches `content_hash_at_review`. Future pending rows do not invalidate older
card versions. The SHA-256 input basis excludes the churn-prone card UUID and
`generated_at`, while the task envelope retains the card UUID as the serving
identity.

Overview v2 treats that same `newest_entry_at` value as a hard historical
knowledge cutoff. Writers use only the reviewed source set in the task; later
outcomes and hindsight are prohibited. The opening synthesis explains why a
resident might choose the card's category and storyline when the sources
support that relevance. It is followed by two to five distinct themes, with
one or two sentences per theme, ordered by likely public importance. See
`ARTICLE_OVERVIEW_V2.md` for the complete editorial contract.

Raw source text is available to the overview writer inside the trusted task.
Image generation must use only `imagePromptInput`, which is limited to reviewed
card text, category, theme, agency labels, entities, and event keys.

The overview-v2 validator accepts 25–160 summary words and two to five cited
key points of 12–80 words and one or two sentences each. It requires all exact
trusted sources to be represented, rejects prompt leakage and duplicated
points, and caps the full synthesis at 380 words. The image validator separately
checks alt text, prompt leakage, hash, media type, and dimensions. Publishing
derives 1200×480 and 1200×630 WebPs, uses content-addressed R2 keys, and
HEAD-verifies every object before inserting immutable thumbnail rows.
Immediately before each card in a dry run or real publish, the coordinator
rebuilds eligibility from hosted Supabase and requires the card ID and full
trusted-input hash to match the exported manifest. The database then applies
overview upgrades atomically and rejects competing same-version rewrites. This
keeps the stale-state window narrow while golden construction and enrichment
generation run concurrently. A hard cross-system snapshot would additionally
require golden writers and enrichment publishing to share a database revision
or transaction lock; the current workflow therefore publishes small,
independently resumable batches.
