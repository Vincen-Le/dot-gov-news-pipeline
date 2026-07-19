# News corpus distribution and event-source expansion

Assessed: 2026-07-18

## Executive read

The current corpus is structurally biased toward singleton stories. The live
table contains 7,694 entries, but the latest clustering experiment processed
only 1,000 of them. In that slice, 96.6% of active storylines were a single
entry in a single episode, 3.3% were a single episode with multiple entries,
and 0.1% were multi-episode storylines.

The full-table evidence says the multi-episode tail is larger than that one
observed chain suggests, but still small. Only 75 of 7,694 entries currently
have any extracted event key. A read-only scan found 21 repeated event keys
spanning multiple days and 100 repeated-title groups containing 349 entries.
Those are candidate chains, not all true storylines: recurring templates and
generic CFR citations create false positives.

A practical whole-table estimate is therefore:

| Story topology                | Estimated count | Estimated share of storylines |
| ----------------------------- | --------------: | ----------------------------: |
| One entry, one episode        |     6,900–7,200 |                        95–97% |
| Multiple entries, one episode |         200–300 |                          3–4% |
| Multiple episodes             |          20–100 |                      0.3–1.4% |

The ranges are deliberately wider than a statistical confidence interval.
The clustered 1,000-entry slice is not a random sample, and the full-table
proxies are high-precision/low-recall identifiers rather than completed
semantic clustering.

## Concrete examples

### Multi-episode storyline

- **BLS Metropolitan Area Employment and Unemployment.** The latest run linked
  the 2025-07-30 and 2025-08-27 releases as two episodes. Across the full table,
  the recurring identifier `No. 23-01` appears on 11 days through 2026-06-03.
  This is the clearest observed continuing series, although that identifier is
  also broad enough to require a title/entity guard.
- **Working Families Tax Cuts implementation.** One IRS umbrella entry and a
  sequence of separately dated `IR-2025-*` releases cover penalty relief,
  reporting thresholds, tips and overtime, scholarship credits, HSAs, and
  other implementation steps from October through December 2025. It is a
  plausible long storyline that the current sparse event-key extraction does
  not fully assemble.

### Multi-entry episode

- **Secretary Rubio on NBC Meet the Press.** Four entries were attached to one
  episode in the latest run, representing same-event publication/coverage
  rather than a chain of later developments.
- **HHS, FDA and USDA address ultra-processed foods.** Two agencies published
  the same-titled announcement on 2025-07-23, a clean cross-agency
  corroboration/duplicate episode.

### Singleton episode storyline

- **Temporary closure of Gauley River NRA's Tailwaters Campground.** One NPS
  operational notice produced one entry, one episode, and one storyline.
- **Ecuador National Day.** One State Department ceremonial statement likewise
  remained a singleton.

## Full-table and source-distribution evidence

The table is complete for feature preparation but not for clustering:

| Measure                                     |                    Count |
| ------------------------------------------- | -----------------------: |
| `news_entries`                              |                    7,694 |
| Embedded                                    |                    7,694 |
| Extracted                                   |                    7,694 |
| Clustered in latest experiment              |                    1,000 |
| Entries with any event key                  |                       75 |
| Exact-title groups with more than one entry | 100 groups / 349 entries |
| Repeated event keys                         | 22 keys / 60 memberships |
| Repeated keys spanning multiple days        |                       21 |
| Exact-title 72-hour multi-entry sessions    | 21 sessions / 46 entries |

The 1,000-entry clustering slice contained 963 storylines and 964 episodes:

| Observed topology                      | Count | Share of storylines |
| -------------------------------------- | ----: | ------------------: |
| Single-entry, single-episode storyline |   930 |               96.6% |
| Multi-entry, single-episode storyline  |    32 |                3.3% |
| Multi-episode storyline                |     1 |                0.1% |

The existing source mix is also concentrated. State, DOJ, VA, and NPS account
for 4,578 of 7,694 entries (59.5%). The largest hosts are:

| Host                                | Entries |
| ----------------------------------- | ------: |
| `www.state.gov`                     |   1,774 |
| `www.justice.gov`                   |   1,140 |
| `news.va.gov`                       |     873 |
| `www.nps.gov`                       |     791 |
| `web.archive.org` source provenance |     613 |
| `www.nasa.gov`                      |     574 |
| `www.usgs.gov`                      |     547 |

The supplied traffic CSV has 83,806 domain rows. It is useful for a minimum
audience floor, but raw rank is a poor selection function: USPS tools, PubMed,
benefits portals, and other service surfaces dominate the top positions while
event-rich publishers sit much lower.

## Additive expansion cohort

The runnable manifest is
`config/news-backfill/event-chain-expansion-v1.json`. It is separate from the
frozen top-20 cohort, so it can add coverage without changing or replaying the
completed source envelope.

| Publisher       | Why it should form chains                                              | Strategy                                                  |                                                            Pre-ingest evidence |
| --------------- | ---------------------------------------------------------------------- | --------------------------------------------------------- | -----------------------------------------------------------------------------: |
| EPA             | enforcement actions, consent decrees, cleanup and response updates     | full news-release sitemap                                 |                                     1,055 URLs last-modified inside the window |
| EEOC            | suit → consent decree/settlement → payment/compliance                  | two-child newsroom sitemap                                |                                       367 URLs last-modified inside the window |
| CISA            | named campaigns, state actors, advisory revisions, CVEs and directives | bounded operational sitemap categories                    |            261 accepted of 306; all accepted summaries at least 200 characters |
| FTC             | complaint/order → settlement/final order/refunds                       | 12 press-release archive pages                            |                                       roughly 220 in-window listing candidates |
| FEMA            | declaration → assistance → recovery centers → deadlines/funding        | nine live regional feeds plus one productive archive feed | 193 accepted live; Region 4 archive added 20 accepted candidates before dedupe |
| SEC enforcement | complaint → judgment/dismissal/distribution                            | four litigation-release archive pages                     |                                   roughly 200–250 in-window listing candidates |

This should add roughly 2,100–2,500 candidates before canonical-URL dedupe and
normalization. EPA is the largest addition, but would be only about 11% of the
combined corpus if its current estimate lands; that is materially healthier
than the current 23% State share.

The FEMA Region 5 feed was excluded because its newest item was dated
2021-02-17. Eight low-yield FEMA Wayback targets were also removed after a dry
run; only Region 4 materially expanded the live feed.

FTC and SEC use bounded HTML archives and will conservatively finish as
`partial` at their page limits even after crossing the requested date window.
They still emit the in-window entries. A future date-aware listing adapter can
turn those receipts into proven-complete targets without changing the source
selection.

Run the expansion independently:

```bash
pnpm --dir apps/news-backfill backfill \
  --manifest ../../config/news-backfill/event-chain-expansion-v1.json
```

## Next wave: highest chain yield, adapter work required

These should be prioritized after the additive cohort, ordered by the quality
of their event identity anchors rather than traffic rank.

| Priority | Source                                                                          | Event identity anchor                                   | Required work                                                                                            |
| -------: | ------------------------------------------------------------------------------- | ------------------------------------------------------- | -------------------------------------------------------------------------------------------------------- |
|        1 | [National Hurricane Center archive](https://www.nhc.noaa.gov/archive/2026/)     | storm basin/year ID plus advisory number                | nested storm/archive adapter; current RSS covers only active storms                                      |
|        2 | [NTSB newsroom](https://www.ntsb.gov/news/press-releases/Pages/default.aspx)    | accident number and investigation lifecycle             | SharePoint/listing adapter for preliminary → hearing → final report chains                               |
|        3 | [DOJ USAO releases](https://www.justice.gov/usao/pressreleases)                 | defendant, docket/case number, charge → plea → sentence | select a bounded district cohort or add quotas; the all-USAO inventory is too large                      |
|        4 | [FBI national releases feed](https://www.fbi.gov/feeds/national-press-releases) | defendant/operation/case                                | Node fetch currently receives 403 while curl succeeds; use native HTTPS or an approved access path first |
|        5 | [CENTCOM press releases](https://www.centcom.mil/MEDIA/PRESS-RELEASES/)         | named operation, location, actor                        | anti-bot-resilient archive adapter                                                                       |
|        6 | [Department of War releases](https://www.war.gov/news/Releases/)                | operation, conflict theater, capability                 | anti-bot-resilient listing or archive adapter                                                            |

NHC is the best next engineering investment. A single storm naturally emits a
long, ordered sequence every few hours and its identifier makes both episode
and storyline evaluation unambiguous.

## Clustering changes needed to realize the source value

Source selection alone cannot guarantee clusters when identifiers are not
extracted. Before evaluating the expanded corpus, add and test these event-key
families:

- FEMA declaration numbers such as `DR-####-ST` and `EM-####-ST`.
- SEC litigation release numbers (`LR-#####`) plus defendant/case-name guards.
- CISA advisory IDs (`AA##-###A`), directive IDs, and CVE sets.
- NHC storm IDs and advisory numbers when the archive adapter lands.
- NTSB accident numbers and investigation docket IDs.
- Named military operations plus location/actor guards.

The first full-corpus clustering run after backfill should publish the same
three topology buckets used above. That will replace the estimates with exact
counts and expose which new publishers actually increased the multi-episode
tail.
