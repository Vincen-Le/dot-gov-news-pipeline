# Thumbnail image contract

## Identity and persistence

- Persist thumbnails per storyline, not per event card.
- Keep article synthesis per event card; do not couple image retries to synthesis publication.
- Prefer an existing `golden_storyline_thumbnails` association over every new candidate.
- Store reusable images in `images`, category mappings in `topic_categories.image_id`, and agency mappings in `agency_thumbnail_images`.
- Randomly choose among available category/agency candidates only for an unassigned storyline, then persist the result. Never reroll on read or retry.

## Civic editorial visual direction

Generate a 1536 × 1024 landscape raster master that remains legible in centered 1200 × 480 and 1200 × 630 crops.

- Use one concrete object, landscape, cross-section, or tightly composed metaphor.
- Build roughly five to twelve tactile paper-collage forms with purposeful overlap.
- Favor warm cream, charcoal, cobalt, signal orange, and at most one muted subject color.
- Keep essential content in the central 65%.
- Use paper fiber, graphite, gouache, halftone, edge irregularity, and subtle print misregistration sparingly.
- Avoid words, letters, numbers, labels, logos, seals, flags, watermarks, UI chrome, recognizable people, fabricated documentary scenes, photorealism, glossy 3D, gradients, and clutter.
- For sensitive stories, use calm symbolic objects rather than victims, bodies, alleged conduct, gore, or spectacle.

For story-specific images, use only `inputBasis.imagePromptInput` and `imageBrief.v1.json`. For reusable assets, use the exact catalog key and catalog prompt. Do not add competing metaphors or imitate a named artist or studio.

## Prototype and review

When visual direction changes, stop scaling, keep drafts unpublished, approve one representative prototype at master and crop sizes, update one shared style contract, and restart only missing keys.

Review every selected image for subject fit, crop safety, accidental marks or text, visual drift, thumbnail legibility, sensitive-story handling, and duplication.

## Parallel generation

Give workers the same prompt/style contract and reference paths, disjoint keys, exclusive output directories, and no hosted credentials. Require each completion to be saved immediately and handed back as:

```text
catalog or storyline key
absolute saved path
SHA-256
exact prompt and model provenance
```

Opaque generated filenames are identifiers, not timestamps. Never guess which key a file represents; maintain an explicit key-to-path manifest while generation is running.

The coordinator alone selects results, derives crops, publishes, and verifies hosted state. Stream small progress batches so a worker interruption loses at most a few unrecorded results.

## Publication checkpoints

Publish all reviewed outputs already on disk before generating more. For each checkpoint:

1. Validate exact identity, dimensions, prompt provenance, alt text, and focal point as applicable.
2. Dry-run the correct story-specific or reusable publisher.
3. Publish idempotently.
4. Verify the master, card, and social R2 objects by HEAD and hash.
5. Reread the database image row and category, agency, or storyline mapping.
6. Recompute gaps before dispatching more generation.
