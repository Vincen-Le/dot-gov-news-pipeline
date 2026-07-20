# Image and synthesis generation

This package owns the tools used to generate and publish a storyline's
thumbnail and each event card's article synthesis. Those assets are not
conceptually limited to golden data. The current export coordinator supports
reviewed golden overview and episode cards through the same complete,
hash-locked historical trust boundary. Its default remains overview-only for
storyline image workflows; article backfills explicitly select both kinds.

Article synthesis and thumbnails are independent lanes. An editorial revision
does not require regenerating an approved thumbnail, and an image retry cannot
replace article content.

```text
apps/image_and_synthesis_gen/
├── src/
│   ├── article_synthesis/  structured overview validation and publication
│   ├── thumbnail/          image validation, crops, R2, and publication
│   ├── shared/             database, manifests, eligibility, and task export
│   ├── legacy/             combined v1 bundle recovery only
│   └── cli.ts              stable command boundary
├── test/                   tests mirroring the source lanes
└── docs/article_synthesis/ article synthesis editorial contract
```

Use `pnpm card:generate` for new operator commands. `pnpm golden:enrich` is a
compatibility alias retained for the Backfill Golden Enrichment skill and
existing runbooks. The following durable names also remain unchanged to avoid
breaking resumable runs or hosted data: `.data/golden-enrichment`,
`golden-enrichment/images/...`, golden database tables/RPCs, frozen artifact
schema names, and CLI event names.

## Backfill Golden Enrichment skill

Use the **Backfill Golden Enrichment** Codex skill by invoking
`$golden-enrichment-backfill` when asking Codex to run, resume, audit, or
recover the reviewed golden-card workflow. The skill is the agent-facing
operational runbook for:

- measuring current synthesis and thumbnail coverage against a fresh reviewed
  manifest;
- generating historical, citizen-focused overview content with two to five
  meaningful findings of one or two sentences each;
- generating and visually reviewing the civic editorial-collage thumbnails;
- reusing thumbnail artifacts only when their storyline has no different
  canonical image, while article artifacts still match `eventCardId` and
  `inputHash`;
- publishing synthesis and images independently in validated Supabase/R2
  checkpoints; and
- recovering safely from interrupted batches, stale inputs, duplicate image
  attempts, or partially persisted output.

The skill coordinates this package's current golden export path; it does not
replace the validators, freshness checks, or immutable publication rules. It
is not for general news-corpus backfill, golden-entry review, clustering, or
arbitrary unreviewed cards.

Example requests:

```text
Use $golden-enrichment-backfill to resume missing images and syntheses.
Use $golden-enrichment-backfill to audit hosted coverage before generating more.
```

```bash
pnpm card:generate export --partitions 16
pnpm card:generate export --card-kinds overview,episode --missing-overviews --partitions 24
pnpm card:generate validate --input .data/golden-enrichment/generated
pnpm card:generate publish --dry-run --input .data/golden-enrichment/generated
pnpm card:generate publish --input .data/golden-enrichment/generated
pnpm card:generate validate-images --input .data/golden-enrichment/generated-images
pnpm card:generate publish-images --dry-run --input .data/golden-enrichment/generated-images
pnpm card:generate publish-images --input .data/golden-enrichment/generated-images
pnpm card:generate validate-overviews --input .data/golden-enrichment/generated-overviews-v2
pnpm card:generate publish-overviews --dry-run --input .data/golden-enrichment/generated-overviews-v2
pnpm card:generate publish-overviews --input .data/golden-enrichment/generated-overviews-v2
```

Every command accepts `--limit`. `export` additionally accepts `--dry-run`,
`--partitions`, `--output-dir`, `--card-kinds`, and `--missing-overviews`;
validation and publishing accept repeated `--input` flags and
`--manifest-dir`. `--card-kinds overview,episode` covers every eligible
historical event-card snapshot. `--missing-overviews` excludes exact hosted v2
rows plus stale immutable v2 rows that require a separately versioned refresh;
the export result reports both counts so the missing-card batch cannot silently
overwrite either class.

### Storyline thumbnail identity and reconciliation

For image artifacts, `eventCardId`, `inputHash`, and the event-card-named bundle
directory locate and authenticate a task in the trusted export manifest; they
are not the persisted thumbnail identity. Validation and publication derive
that identity only from the matched trusted task's
`inputBasis.storyline.storylineId`. Select no more than one artifact for each
such storyline ID. Before generation or publication, look up those IDs in
`golden_storyline_thumbnails` and discard every candidate whose storyline
already has a canonical association. Exact publication retries are idempotent;
a different image for an associated storyline is rejected.

Use the same frozen manifest for validation, dry-run, and publication:

```bash
pnpm card:generate validate-images \
  --manifest-dir <frozen-export-directory> \
  --input <reviewed-image-proof-directory>
pnpm card:generate publish-images --dry-run \
  --manifest-dir <frozen-export-directory> \
  --input <reviewed-image-proof-directory>
pnpm card:generate publish-images \
  --manifest-dir <frozen-export-directory> \
  --input <reviewed-image-proof-directory>
```

The final command atomically creates one immutable `images` row and one
`golden_storyline_thumbnails(storyline_id, image_id)` association through
`publish_golden_storyline_thumbnail`. It does not create one database row per
event card; readers resolve every card in the chain through its existing
`storyline_id`.

## Reviewed golden-card backfill

Golden construction and enrichment use separate lanes:

1. Keep building and reviewing the hosted golden mirror as usual.
2. Periodically run `export` into a versioned output directory. For article
   synthesis, select `--card-kinds overview,episode`; it snapshots every card
   version whose complete source set at the card cutoff is reviewed and
   hash-matching. Keep that snapshot until its workers finish. Image work keeps
   the default overview-only scope and selects at most one card per storyline.
3. Distribute the content-addressed partition files to parallel generation
   workers. Overview workers follow
   `docs/article_synthesis/article-overview-v2.md` and write
   `article-overview.v2.json`; image workers receive `imagePromptInput` and
   write image bundles. Workers receive no Supabase or R2 write credentials.
4. Validate completed card directories, visually review their image masters,
   and run `publish-images --dry-run` followed by `publish-images` in small
   batches. The legacy combined v1 bundle remains supported by `publish`.
5. Publish overview v2 artifacts independently with `publish-overviews`. It
   upgrades a matching v1 row without reading or writing R2, and refuses to
   replace a different v2 artifact unless its version is incremented.
6. Repeat the export. Article rows remain idempotent by card ID. Image workers
   select at most one task per storyline, and a storyline with a thumbnail is
   never regenerated when later card versions appear.

Publication is the only privileged lane. `publish-images` writes three
content-addressed image objects to R2, one reusable `images` row, and one
`golden_storyline_thumbnails` association; it never touches article overviews
or adds an image column to a storyline. A retry HEAD-verifies existing objects
and requires the storyline's existing thumbnail to match every immutable
field. Eligibility for the entire selected batch is
rebuilt immediately before the first write, so a stale or no-longer-reviewed
card fails before the batch is mutated. The legacy `publish` command still
accepts combined v1 overview/image bundles.

An image-only worker output directory contains:

```text
<event-card-id>/
  image-generation.json
  storyline-master.png
```

`image-generation.json` records the exact prompt, model, generated time,
concept, 15–30 word alt text, normalized focal point, and frozen `inputHash`.
It may specify a relative `masterPath`; the default is
`storyline-master.png`, and the resolved file must remain inside the card
bundle. Recursive directory discovery considers only the canonical
`image-generation.json` filename. To publish a reviewed sibling proof, pass
its JSON file explicitly and set its `masterPath`; this prevents alternate
variants from entering a bulk run accidentally. Selecting more than one image
artifact for the same storyline is rejected, even when the artifacts target
different card versions.

Each worker output directory contains:

```text
<event-card-id>/
  overview-enrichment.v1.json
  storyline-master.png
```

The JSON carries exact source IDs, input and prompt hashes, citations, alt
text, focal point, and model provenance. The master follows
`apps/dot-gov-news-demo/docs/design.md`: central crop-safe composition, warm-paper editorial
illustration, and no words, logos, seals, people, or photorealistic evidence.

## Trust boundary and future card types

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
`docs/article_synthesis/article-overview-v2.md` for the complete editorial contract.

Raw source text is available to the overview writer inside the trusted task.
Image generation must use only `imagePromptInput`, which is limited to reviewed
card text, category, theme, agency labels, entities, and event keys.

Overview and episode cards share the same eligibility adapter, trusted source
set, historical cutoff, and input hash. Supporting another card type must
extend that adapter in `shared/`; it must not duplicate the thumbnail or
article-synthesis lanes.

The overview-v2 validator accepts 25–160 summary words and two to five cited
key points of 12–80 words and one or two sentences each. It requires all exact
trusted sources to be represented, rejects prompt leakage and duplicated
points, and caps the full synthesis at 380 words. The image validator separately
checks the frozen input hash, prompt and model provenance, alt text, prompt
leakage, bundle path, and exact 1536×1024 PNG master dimensions. Publishing
derives 1200×480 and 1200×630 WebPs, uses content-addressed R2 keys, and
HEAD-verifies every object before atomically publishing the immutable image and
storyline association. Immediately before each artifact in a dry run or real
publish, the coordinator rebuilds eligibility from hosted Supabase. Article
publication requires the card ID and full trusted-input hash to match; image
publication additionally refuses a second image for the same storyline. The
database applies overview upgrades atomically and rejects competing
same-version or same-storyline rewrites. This
keeps the stale-state window narrow while golden construction and enrichment
generation run concurrently. A hard cross-system snapshot would additionally
require golden writers and enrichment publishing to share a database revision
or transaction lock; the current workflow therefore publishes small,
independently resumable batches.
