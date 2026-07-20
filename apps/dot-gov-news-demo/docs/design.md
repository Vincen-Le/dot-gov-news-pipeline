# DOT GOV Demo — National Design Studio Handoff

## 1. Product and design thesis

DOT GOV is a public-interest news interface built from reviewed government
source material. The authoritative visual reference is
`storylines-demo.html`, established with National Design Studio.
The production app should reproduce that reference's dense, high-contrast
editorial data interface; it does not use the Evergreen design system.

The visual direction is **National Design Studio's DOT GOV demo language**:

- Black canvas and near-black surfaces in the default dark theme.
- Instrument Sans for the interface and a system monospace for operational data.
- Square geometry, visible rules, dense controls, and restrained motion.
- Cool blue for links, selection, and focus; status colors remain functional.
- Large typographic statements balanced by compact metadata and filter controls.
- Images behave as editorial illustrations, never as fabricated evidence.

The product should feel like a live editorial instrument rather than a generic
admin dashboard, government form, or consumer-news feed.

## 2. Design tokens

### Typography

| Role             | Typeface                                      | Use                                                    |
| ---------------- | --------------------------------------------- | ------------------------------------------------------ |
| Interface        | Instrument Sans, Helvetica Neue, Arial        | Navigation, controls, headlines, summaries, modal copy |
| Metadata and data| ui-monospace, SFMono-Regular, Menlo, monospace| Eyebrows, dates, ranks, counts, and operational labels |

Rules:

- Headlines use sentence case, medium weight, tight leading, and slightly tight letter spacing.
- Metadata labels may use uppercase monospace with generous letter spacing.
- Never use all caps for article titles or summaries.
- Use tabular numerals for ranking values and dates where available.
- Keep long prose in readable columns inside the split detail modal.

### Color

Dark mode is the default:

| Token        | Dark      | Light     | Purpose                                  |
| ------------ | --------- | --------- | ---------------------------------------- |
| Canvas       | `#000000` | `#f2f0e9` | Browser and outer application background |
| Surface      | `#080808` | `#fbfaf6` | Primary application surface              |
| Raised       | `#141414` | `#ffffff` | Lifted cards and modal areas              |
| Text         | `#f4f3ee` | `#111111` | Primary text                              |
| Muted        | `#9b9b94` | `#5f5d57` | Secondary text and metadata               |
| Rule         | `#343434` | `#cfcbc0` | Dividers and boundaries                   |
| Focus/action | `#8db4ff` | `#174ea6` | Links, focus, and active controls         |

Status colors communicate health, attention, and failure. Ranking dimensions
have stable rubric, agency, feed, source, and freshness colors. Do not add
decorative gradients or product-framework styling that is absent from the
reference mockup.

### Spacing, shape, and elevation

- Main application width: 1600 px maximum.
- Controls are 44 px high and square by default.
- Pills are compact multi-select filters, not rounded content cards.
- Most separation comes from 1 px rules; shadow is reserved for the lifted modal.
- Focus uses a visible cool-blue outline with offset.

### Layout

- Storylines provides both a dense table view and a product-card view.
- Product view exposes agency, category, and theme multi-select pill carousels plus sorting.
- Cards use a responsive three-, two-, then one-column grid.
- The detail modal splits into two equal panes:
  - Left: storyline overview followed by episode cards.
  - Right: article synthesis followed by primary-source records.
- On mobile, the panes become one vertical reading flow.
- Ranking remains list-based and dense.

### Motion

- Motion is minimal and functional, generally 150–250 ms.
- Opening a storyline lifts it from the grid into the split detail modal.
- Respect `prefers-reduced-motion`; all information remains available without animation.

## 3. Image system

### Creative direction

Use **editorial illustration**, not synthetic documentary photography. A
photorealistic generated image can falsely imply that a depicted scene, person,
or event was observed. The preferred style combines:

- Geometric cut-paper forms.
- Archival newsprint or restrained halftone texture.
- Technical-diagram, map, infrastructure, document, and material cues.
- One clear subject or metaphor with generous negative space.
- Warm paper, deep ink, cobalt blue, and signal orange, plus one desaturated
  subject-specific supporting color.

Images should communicate the subject area at a glance without attempting to
encode every fact in the story.

### Composition and output

- Generate a landscape master, preferably 1536 × 1024 or larger.
- Keep the key subject within the central 60% of the frame so the image can be
  cropped into the wide storyline-card slot.
- Produce derivatives for the actual card crop and social/preview use rather
  than asking the model to render the same concept repeatedly.
- Store a normalized focal point (`x`, `y`) with the asset for responsive crops.
- Export AVIF or WebP for the UI and retain the original master.
- Do not bake labels, headlines, dates, logos, seals, or data into the image.
- Alt text should be 15–30 words and describe the illustration and its subject,
  not repeat the card headline.

### Required exclusions

Do not generate:

- Agency seals, official logos, flags used as endorsement, or copied brand marks.
- Legible documents, UI screenshots, maps with invented labels, or generated text.
- Recognizable public officials or private individuals unless using a licensed,
  verified source photograph rather than a generated image.
- Graphic injury, disaster spectacle, enforcement theatrics, or alarmist imagery.
- Generic handshakes, gavels, capitol domes, glowing globes, or stock-photo office scenes.
- Visual claims that are not supported by the reviewed source set.

### Prompt template

```text
Create a landscape editorial illustration for a public-interest government
news brief.

Subject: {plain-language subject}
Editorial concept: {one concrete visual metaphor grounded in the event}
Category/theme: {category} / {theme}

Visual language: civic editorial modernism, geometric cut-paper composition,
subtle archival newsprint texture, precise technical-diagram details, warm paper
ground, deep ink, cobalt blue, signal orange, one muted subject-specific color.
Calm, factual, intelligent, contemporary. One dominant subject with generous
negative space. Keep essential content in the central 60% for a wide crop.

No words, letters, numbers, labels, logos, seals, watermarks, recognizable
officials, fabricated news photography, dramatic disaster spectacle, glossy 3D,
purple gradients, or generic stock-photo imagery.
```

Prompt inputs must come only from reviewed headline, summary, category, theme,
agencies, entities, and event keys. Raw article text must never be allowed to
inject new prompt instructions.

## 4. Which images and summaries to generate

### Replay rule

Generate one enrichment bundle for every immutable **overview event-card
version** that may appear in replay—not one bundle for every date.

For a selected date:

```text
visible card = newest overview card where newest_entry_at <= end of selected date
visible image = enrichment linked to visible card.id
visible article overview = enrichment linked to visible card.id
```

`generated_at` remains processing/audit metadata and must not drive the date
slider.

Example: if a storyline has overview cards representing news through July 3,
July 8, and July 19, a replay from July 1–31 requires three image/overview
bundles. July 8–18 reuses the July 8 bundle. Never overwrite the July 3 asset
when the July 8 version is generated.

Recommended generation ownership:

| Artifact                    | Generate when                                              | Reuse rule                                                                                                                             |
| --------------------------- | ---------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------- |
| Storyline image             | Once per overview `event_card.id`                          | Reuse across every date selecting that card; an explicit `reuse_from_card_id` is acceptable when the concept did not materially change |
| Aggregate article overview  | Once per overview `event_card.id`                          | Reuse across the same card's date interval                                                                                             |
| Episode image               | Not required for the current text-only modal episode cards | If added later, generate once per immutable episode-card ID                                                                            |
| Individual article analysis | Once per `news_entry_id + content_hash + analysis_version` | Reuse in every episode and overview synthesis containing that article version                                                          |

This separation avoids paying to reanalyze the same article every time a
storyline card is superseded. New overview cards synthesize the reusable article
analyses available at that point in time.

### Replay-safe input boundary

An overview bundle may use only:

- Reviewed entries belonging to the storyline.
- Entries with `published_at` at or before the card's event-time cutoff.
- Episode and overview cards generated at or before that version.
- The exact article content version represented by its stored content hash.

Store the source entry IDs, input hash, prompt version, model, and generated
timestamp with every output. Generation must be idempotent by card ID and
pipeline version.

## 5. Content system

### Voice

- Neutral, direct, and specific.
- Attribute actions and claims to the responsible agency.
- Prefer concrete verbs: “issued,” “recalled,” “opened,” “awarded,” “proposed.”
- Separate confirmed facts from agency rationale and future expectations.
- Explain specialized terms once in plain language.
- Avoid hype, moral judgment, partisan framing, rhetorical questions, and
  unsupported statements about impact.

### Storyline card content

**Headline**

- 6–14 words when possible.
- Name the action and affected subject; include the agency only when it improves clarity.
- Use sentence case and an active verb.
- Do not use clickbait, unexplained acronyms, or a trailing period.

**Card overview/dek**

- 45–80 words; the UI may clamp it to four lines.
- Sentence 1: what changed.
- Sentence 2: who or what is affected.
- Sentence 3, when useful: why the development belongs in the continuing storyline.
- Do not enumerate every source or repeat the headline.

**Interest reason**

- One short sentence explaining public relevance, not a score explanation.
- Example shape: “The rule changes eligibility for households using the program.”

### Episode content

- Episode headline: 5–12 words describing the distinct development.
- Episode summary: 50–100 words covering the new action, evidence, and relation
  to the preceding episode.
- Do not restate the full storyline history inside every episode.
- Episodes render newest first in the current modal; dates and source links must
  make chronology unambiguous.

### Aggregate article overview in the right pane

This is a synthesis of the source articles visible for the selected card
version, not a generic summary of the storyline. Target 180–300 words total:

1. **What the sources establish** — a 70–110 word lead with the shared,
   well-supported facts.
2. **Key details** — three to five short bullets covering quantities, places,
   deadlines, affected groups, and official actions.
3. **What changed across updates** — one short paragraph distinguishing the
   newest development from prior episodes.
4. **What remains unresolved** — only when the source set explicitly leaves an
   open question, pending action, or future date.

Every factual claim must resolve to one or more source entry IDs. Preserve
disagreement between sources rather than blending it into false consensus.
Syndicated duplicates should support provenance but should not receive extra
weight or produce repeated bullets.

### Individual article analysis

Each source card should show:

- Full agency name.
- Original article title and publication date.
- A 40–80 word analysis focused on what this source uniquely contributes.
- Up to three structured facts when present: action, affected entity, date,
  quantity, location, or status.
- A direct link to the primary source.

If extraction is incomplete, say “Analysis unavailable” rather than infer from
the title alone.

## 6. Recommended persistence contract

Keep generated outputs immutable and separate from the source cards:

```text
news_entry_analyses
  news_entry_id
  content_hash
  analysis_version
  analysis
  structured_facts
  model
  generated_at

event_card_enrichments
  event_card_id
  enrichment_version
  article_overview
  key_details
  source_entry_ids
  image_asset_key
  image_alt_text
  image_prompt_version
  image_model
  image_focal_x
  image_focal_y
  reuse_from_card_id
  input_hash
  generated_at
  status
```

Use a unique key on the source ID plus version. A regeneration creates a new
version; it does not mutate an output that may be used by historical replay.

## 7. Handoff acceptance checklist

- The UI reads an image and aggregate overview by the selected overview-card ID.
- Moving the date backward never reveals an image, fact, article, theme, or
  episode that had not emerged by that date.
- All displayed storylines and source entries are reviewed.
- Every aggregate claim retains source-entry provenance.
- Every agency acronym expands to its approved display name.
- Images contain no generated text, official marks, or fabricated documentary scenes.
- Light and dark themes preserve readable contrast.
- Empty, loading, failed, and pending-enrichment states are designed explicitly.
- Historical outputs remain immutable and reproducible by version.

## 8. Design decisions log

| Date       | Decision                                             | Rationale                                                                    |
| ---------- | ---------------------------------------------------- | ---------------------------------------------------------------------------- |
| 2026-07-19 | National Design Studio DOT GOV demo language          | Makes the approved interactive mockup the visual source of truth              |
| 2026-07-19 | Editorial illustration over generated photography    | Avoids presenting synthetic scenes as evidence                               |
| 2026-07-19 | Enrichment keyed to immutable overview-card versions | Makes date replay accurate without generating duplicate daily assets         |
| 2026-07-19 | Article analysis separated from card synthesis       | Lets analyses be reused while each card version remains historically correct |
