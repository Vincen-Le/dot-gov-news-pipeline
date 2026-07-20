# Recovery and hosted verification

## Recover the runtime safely

If `node` or `pnpm` is absent, load the bundled workspace dependency runtime. Do not install or upgrade packages merely to recover a shell shim. Check only whether required secret names are set; never print values.

## Inventory exact identities

Build fresh hosted maps for:

- current article tasks keyed by `(eventCardId, inputHash)`;
- canonical thumbnails keyed by `storyline_id`;
- reusable assets keyed by catalog key plus stored image SHA;
- category and agency mappings;
- exact R2 keys and hashes for master, card, and social variants.

Classify every local artifact as generated, schema-valid, identity-valid, visually reviewed, dry-run compatible, published, and hosted-verified. Never collapse these into one status.

Use explicit manifests and saved paths. Built-in image generation results may have opaque filenames, and neither lexicographic order nor modification time proves key assignment, approval, or recency.

## Recover incomplete image generation

Immediately record `key -> savedPath -> SHA-256 -> prompt/model`. If a worker stops, trust recorded paths and hashes, visually inspect them, and regenerate only keys without a valid record. Never recover from embedded base64 when a saved artifact exists.

When duplicate attempts exist, prefer:

1. a machine-readable approval naming the exact master and style-contract hashes;
2. the exact already-published current image;
3. the latest explicit reviewed checkpoint;
4. manual side-by-side review.

Never select by file modification time.

## Recover interrupted publication

For every database row, HEAD the exact stored master, card, and social keys and compare SHA-256 metadata. Do not reconstruct keys from memory. Treat a row without all three verified objects as incomplete.

Retry only the missing step. Content-addressed uploads, image rows, mappings, and canonical associations must be idempotent. Verify hosted state before replaying any publisher.

## Recover synthesis batches

The worker may treat an existing `article-overview.v2.json` as complete before validating it. Create a clean resume directory and seed only artifacts that pass the repository validator against the current frozen manifest. Preserve malformed and stale files separately for audit.

If a valid overview lacks `image-brief.v1.json`, generate from a scratch one-card frozen task, verify its exact identity, and copy only the brief. Do not replace immutable same-version synthesis.

## Completion audit

Require all applicable checks:

- exact expected reusable, category, and agency counts;
- three verified R2 objects per image;
- all category and agency keys mapped;
- exactly one canonical association per eligible storyline;
- zero storyline gaps;
- selection-source distribution reported;
- synthesis coverage counted separately by exact current event-card input hash;
- no unpublished local drafts omitted from the report.
