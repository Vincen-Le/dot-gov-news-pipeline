---
name: thumbnail-and-article-synthesis-skill
description: Run, resume, validate, publish, and audit dot-gov-news-pipeline storyline thumbnails and event-card article synthesis. Use for frozen golden exports, citizen-focused article-overview v2 generation, story-specific or reusable category/agency thumbnail generation, parallel backfills, stale-input reconciliation, Supabase/R2 publication, and recovery of incomplete enrichment artifacts.
---

# Thumbnail and article synthesis

Treat thumbnail generation and article synthesis as independent, resumable lanes:

- Persist one canonical thumbnail association per storyline. A generated image or a one-time randomly selected category/agency fallback may satisfy it.
- Persist article synthesis per event card and exact `inputHash`. Overview and episode cards may each need synthesis.
- Never regenerate or replace a valid canonical storyline thumbnail merely because a later card version appears.

## Load the contracts

Read all three references before generating or publishing:

- [synthesis.md](references/synthesis.md) for the citizen lens, historical cutoff, citations, and quality review.
- [images.md](references/images.md) for story-specific images, reusable category/agency assets, parallel generation, and visual review.
- [recovery.md](references/recovery.md) for identity, partial-output recovery, idempotent publication, and hosted completion audits.

Then inspect the repository's current interfaces; they override stale examples:

```text
apps/image_and_synthesis_gen/README.md
apps/image_and_synthesis_gen/docs/article_synthesis/article-overview-v2.md
apps/image_and_synthesis_gen/src/cli.ts
apps/image_and_synthesis_gen/src/thumbnail/validation.ts
apps/image_and_synthesis_gen/src/thumbnail/publisher.ts
apps/image_and_synthesis_gen/src/reusable/catalog.ts
apps/image_and_synthesis_gen/src/reusable/completed.ts
apps/image_and_synthesis_gen/src/reusable/publisher.ts
apps/image_and_synthesis_gen/src/shared/types.ts
scripts/generate-golden-overviews.py
```

Invoke the installed `imagegen` skill before calling an image generator.

## Preserve the trust boundary

- Export only card snapshots whose complete source set at `newest_entry_at` is reviewed and hash-matching.
- Treat a frozen manifest as immutable input. Never substitute newer source text or outside knowledge.
- Give generation workers disjoint assignments and no Supabase or R2 write credentials. Keep validation and publication centralized.
- Record each finished image immediately with its catalog/storyline key, exact saved path, SHA-256, prompt, model, and generation time. Built-in generated filenames are opaque and must not be treated as chronological evidence.
- Use saved filesystem paths, never embedded base64, for handoff and recovery.
- Preserve unrelated worktree changes and keep run data under `.data/golden-enrichment/`.

## Run article synthesis

1. Export a unique, versioned manifest and measure exact hosted coverage.
2. Recover only locally validated artifacts with the same `eventCardId`, `inputHash`, and prompt identity.
3. Generate one canary with `scripts/generate-golden-overviews.py`, validate it, and review it against [synthesis.md](references/synthesis.md).
4. Submit the remainder through the resumable batch worker. Preserve successful downloads when a batch has partial failures; retry only failed or invalid cards.
5. Re-export before publication and reconcile changed, new, and no-longer-eligible tasks.
6. Run `validate-overviews`, `publish-overviews --dry-run`, and `publish-overviews`, then reread hosted rows.

The worker skips a card when `article-overview.v2.json` already exists, so seed resume directories only with artifacts already validated against the current frozen manifest.

## Run thumbnails

### Story-specific lane

Generate from `inputBasis.imagePromptInput` plus `image-brief.v1.json`, never raw article bodies. Select at most one task per storyline. Use `validate-images`, `publish-images --dry-run`, and `publish-images`; publication creates the reusable image row, three R2 variants, and one canonical storyline association.

### Reusable fallback lane

Use the repository catalog as the source of truth for category and agency keys and prompts. Generate each missing master once, then run `validate-reusable-images`, `publish-reusable-images --dry-run`, and `publish-reusable-images` as exposed by the current CLI.

Reusable assets live in `images`. Categories point to an image through `topic_categories.image_id`; agencies map through `agency_thumbnail_images(publisher_key, image_id)`. For a storyline without a canonical thumbnail, hosted logic chooses randomly from its available category/agency candidates once and persists the selected `image_id` and `selection_source` in `golden_storyline_thumbnails`. The persisted association always wins on later reads and retries.

Publish all already-reviewed reusable assets before generating the remaining catalog. Publication is idempotent: on interruption, verify and resume only missing or incomplete assets.

## Coordinate parallel image work

When the user asks for subagents or parallel generation:

1. Give every worker the exact shared style contract and reference-image paths.
2. Assign disjoint catalog keys or storyline identities and exclusive output directories.
3. Forbid hosted credentials and publication.
4. Require a progress handoff after every few completions containing key, saved path, SHA-256, and prompt provenance.
5. Let the coordinator visually review, deduplicate, publish, HEAD-verify, and audit coverage.

Do not infer generation order from opaque filenames or modification time.

## Reconcile and recover

Before every publication checkpoint:

1. Export or query fresh hosted state.
2. Keep artifacts whose exact identity is unchanged.
3. Regenerate only changed or missing work.
4. Preserve valid successes from partial runs.
5. Run the full validator and dry-run publisher on the assembled checkpoint.
6. Publish centrally, HEAD-verify each R2 object, and reread database mappings.

Never edit an artifact hash to fit a new task. Never replay a whole batch merely because one output or one publication step failed.

## Prove completion

Report generated, validated, published, and hosted-verified states separately. A thumbnail backfill is complete only when all of these hold:

- reusable catalog count equals the expected category plus agency count;
- every category and agency key is mapped;
- every reusable image has master, card, and social objects verified in R2;
- every eligible storyline has exactly one canonical thumbnail association;
- storyline gaps are zero;
- selection-source counts are reported (`generated`, `category_fallback`, `agency_fallback`, or current equivalents);
- article synthesis coverage is measured separately by current event-card identity and input hash.

Repository provenance plus hosted object storage is sufficient for generated masters when the project intentionally uses content-addressed R2 as the durable asset store; do not add every binary master to Git unless repository policy requires it.
