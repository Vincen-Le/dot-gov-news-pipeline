# Entity Extraction Reliability Spec

2026-07-18. Findings and ranked hypotheses for the identity-anchor extractor
(`pipeline/shared/extraction.py`), triggered by a reproduced production defect: entry
`39517aff-d949-4f04-913c-d8ebe05a9637` ("How to get reimbursed for your
VA-related travel", news.va.gov) carries `entity_set = {editor}`.

Companions:

- `docs/operations/clustering-experimentation-spec-2026-07-18.md` — the
  experiment catalog this feeds; its E0 eval harness is the measurement
  prerequisite here too.
- `docs/operations/clustering-lab.md` — how experiments are run.

## Why entity quality matters more than it looks

`entity_set` is not display metadata. It is load-bearing in four places:

1. **Tier-4 auto-join gate** (`pipeline/complex/episodes.py:116-126`): a centroid
   nominee joins _without adjudication_ when the entry and episode share one
   rare entity (daily EMA below `ambient_ema_ceiling`). A spurious rare
   entity is a false auto-join, silently bypassing the adjudicator.
2. **Adjudicator evidence** (`pipeline/complex/episodes.py:127-132`): the episode
   side of the prompt is largely its entity set — the adjudicator judges
   partly on entity garbage in, garbage out.
3. **Storyline resolution / merge** (`pipeline/complex/storylines.py`): merges gate
   on rare shared discriminators (commit `a998717`).
4. **Entity EMA stats** (`touch_entity_stats` at ingest and feature update):
   bad entities pollute the ambient baseline other decisions read.

The failure profile is inverted from intuition: _frequent_ junk ("va",
"announces") is neutralized by the ambient-EMA ceiling; _rare_ junk
("editor", 8 entries corpus-wide) is exactly what the gate treats as a
discriminator. Low-frequency noise is the dangerous kind.

## Confirmed findings

### F1. Runner violates the extractor's input contract (root cause, reproduced)

`pipeline/shared/extraction.py` is documented and designed to run on **raw title +
first summary sentence only**. `pipeline/runner.py:71-72` instead passes
`body_text or summary` (introduced by `4408ae7`, "preserve full news
content"):

```python
content = row.get("body_text") or row.get("summary")
entities, keys = extract(row["title"], content) if needs_anchors else (None, None)
```

For the VA entry, body text begins _"Editor's note: This story was edited on
7/25/25 …"_ — that becomes the "first sentence", `_CAP_SPAN` matches
`Editor` (the apostrophe ends the span), and it survives every lexicon.
Reproduced exactly:

- `extract(title, body_text)` → `['editor']` (matches the DB row)
- `extract(title, summary)` → `['veterans']` (the contract path)

Blast radius (local corpus, 2026-07-18): 8 entries with `editor`; **2,349
entries have entities extracted while `body_text` was present** — all
anchored on article-body first sentences (editor's notes, datelines,
bylines, nav residue) instead of feed summaries.

Note the asymmetry: full body text _is_ correct for enrichment and
embedding; it is wrong only for the entity guard, whose noise control is the
narrow input scope.

### F2. `extractor_version` is two unrelated version namespaces in one column

`news_entries.extractor_version` is written by:

- the backfill **metadata** extractor (`apps/news-backfill/src/extract.ts`,
  `EXTRACTOR_VERSION = 4`, previously 3) via `ingest_news_entries_v2`, and
- the pipeline **entity** extractor (`pipeline/shared/extraction.py`,
  `EXTRACTOR_VERSION = 1`) via `update_entry_features`.

The flagged row shows `extractor_version = 3` with a pipeline-produced
entity set: `ingest_news_entries_v2` resets `entity_set = '{}'` on content
change and stamps its own version; the later anchor backfill's version write
is coalesced against it. Consequence: **provenance of anchors is not
recoverable from the row**, and version-based invalidation ("re-extract
everything below vN") is unsound.

### F3. Lexicon maintenance is whack-a-mole with no convergence

`_COMMON_ENGLISH` has grown to ~90 entries; its tail ("dear colleague call
calls watch highlights hiring apparent role sept") is visible patch history.
Every new agency feed contributes new boilerplate; frozen lexicons are
version-bumped guesses, not learned from the corpus.

### F4. The capitalization net has structural holes

`_CAP_SPAN = \b[A-Z][a-z]+(?:\s+[A-Z][a-z]+)*\b` cannot match the entities
this corpus most needs as discriminators:

- all-caps and mixed-case tokens: `VA`, `mRNA`, `COVID-19`, `HIV`, `E. coli`
- lowercase drug/chemical names: `semaglutide`, `fentanyl` (generic names
  are lowercase in running text)
- alphanumeric identifiers not covered by the event-key patterns

So recall is capped for precisely the "codes, proper nouns, medicine names"
class, while precision leaks through capitalized boilerplate. Event keys
(`_EVENT_KEY_PATTERNS`: CVEs, dockets, FR docs, CFR refs, recall/case
numbers) are the healthy part — hard IDs are regex's home turf.

## Ranked hypotheses

Ordering principle: deterministic, cheap fixes first; measure; escalate to
model-based extraction only if entity precision still limits attach quality.

### H1. Restore the extractor input contract (do now)

- **Do**: `pipeline/runner.py` passes `row.get("summary")` to `extract()`;
  body text remains input to enrichment/embedding only. One-line change plus
  a regression test pinning the "Editor's note" case.
- **Then**: bump entity extractor version, invalidate and re-prepare the
  2,349 affected rows (see Rollout below).
- **Success criterion**: re-extracted corpus has zero `editor`-class
  boilerplate anchors from body leads; spot-audit of 50 re-extracted rows
  shows entities present in title/summary text.
- **Cost**: minutes of code, one re-prepare pass. No new failure modes —
  this is reverting to the documented design.
- **Risk**: entries with empty summaries lose anchors they currently get
  from body text. Acceptable: those anchors are the contaminated class; an
  empty entity set degrades to adjudication, not to a wrong auto-join.

### H2. Split the version namespaces (do with H1's migration)

- **Do**: separate columns — `anchor_extractor_version` (pipeline) vs the
  backfill's metadata `extractor_version` — or a `{namespace: version}`
  jsonb. Update `ingest_news_entries_v2` and `update_entry_features`
  accordingly.
- **Success criterion**: given any row, which extractor produced its anchors
  and at what version is answerable by inspection; version-scoped
  invalidation queries are sound.
- **Cost**: one migration + two RPC edits + both writers. Small, but touch
  it while H1's invalidation already forces a migration.

### H3. Grounded small-LLM entity extraction, piggybacked on enrichment

The "would a small fast LLM be better?" hypothesis. Verdict: yes for
_entities_, no for _event keys_, and only in the shape below.

- **Do**: extend the existing enrichment call (`models.enrich`, already
  concurrent, versioned by `enricher_version`, cached in the DB) to also
  return an entity list — proper nouns, org/product/drug names, codes —
  from title + summary. No new prepare stage, marginal cost ≈ zero. A
  standalone Haiku-class call is the fallback shape (~250 tokens/entry;
  full-corpus backfill costs cents).
- **Validation layer (non-negotiable)**: LLM proposes, code disposes —
  casefold + NFKC, dedupe, cap 64, and a **grounding check**: reject any
  entity whose text does not literally occur (casefolded) in title+summary.
  Grounding kills hallucinated anchors, which would otherwise be tier-4
  poison (F4's inverse risk).
- **Keep regex event keys unchanged**: deterministic, reliable, and the
  patterns encode domain knowledge (FDA recall formats, FR doc numbers) an
  LLM adds nothing to.
- **Determinism tradeoff, stated honestly**: extraction stops being
  replayable from `(title, summary, version)`; reproducibility holds via the
  persisted feature cache only (the same regime enrichment already lives
  in). Bench-to-bench comparability requires pinning prepared features, not
  re-preparing — already the lab's practice.
- **Success criterion** (needs E0 labels): against a ~100-entry hand-labeled
  entity sample, LLM+grounding beats regex+lexicons on both precision and
  recall for the discriminator class (drugs, companies, codes, people);
  downstream, tier-4 `centroid_join` false-attach rate does not regress on
  the labeled attach set.
- **Cost**: prompt + parser + grounding filter, one eval afternoon. Run as
  a lab experiment (versioned extractor, A/B via re-prepare on a fixed
  corpus slice) before promotion.

### H4. Entity-quality measurement (prerequisite for H3, cheap regardless)

- **Do**: two additions. (a) A corpus audit query/report: entities ranked by
  document frequency with sample titles — makes `editor`-class contamination
  visible without waiting for a bad join. (b) Extend the E0 label queue with
  an entity-correctness pass: for ~100 sampled entries, mark each extracted
  entity correct/junk; report precision per extractor version.
- **Success criterion**: every extractor change (H1, H3) reports
  before/after entity precision and rare-entity-gate attach mix on the same
  corpus slice.
- **Cost**: one query + small labeling pass. Without this, H3's "better"
  is vibes.

### H5. Boilerplate-lead stripper (fallback / defense-in-depth)

Only if H1 leaves residual body-lead noise (it shouldn't, since body text
exits the entity path entirely) or if summaries themselves carry editorial
prefixes.

- **Do**: strip recognized editorial-prefix patterns ("Editor's note:",
  "Updated:", datelines like "WASHINGTON —") before sentence selection, as a
  versioned pre-pass in `extraction.py`.
- **Verdict**: park it. It is lexicon whack-a-mole (F3) in a new costume;
  prefer H3 if H1+H4 show remaining noise.

## Rollout mechanics (H1/H2, and H3 if promoted)

1. Land code + migration; bump the entity extractor version.
2. Invalidate: null `entity_set`/`event_keys` (and the new anchor version
   column) for rows whose anchors predate the fix — the F2 split is what
   makes this selection expressible.
3. Re-prepare (`prepare` backfills anchors where both sets are empty —
   existing `needs_anchors` path).
4. **Reset entity EMA stats** for retracted entities, or accept decay:
   `touch_entity_stats` has already counted the junk; `editor` at 8 docs is
   below ambient anyway, so decay is acceptable — but note it in the run
   log.
5. Re-run the fixed-slice bench; compare attach mix + (post-E0) B³ before
   declaring victory.

## Explicit non-goals

- Replacing event-key regexes with a model (H3 keeps them).
- NER for display/search purposes — this spec is about _identity anchors_
  for clustering; broader entity products are out of scope.
- Fixing the backfill metadata extractor (`extract.ts`) — different
  workstream; only its version-column collision (F2) is in scope.
