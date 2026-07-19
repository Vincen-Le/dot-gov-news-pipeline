# Alternate structured-source probe

Probed: 2026-07-18T16:07:53.928Z

| Publisher | Check        | URL                                                                  | Verdict     | Detail                                                                                                                                                             |
| --------- | ------------ | -------------------------------------------------------------------- | ----------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| bls       | wordpress    | https://www.bls.gov/wp-json/wp/v2/posts?per_page=1                   | unavailable | status 404                                                                                                                                                         |
| bls       | drupal       | https://www.bls.gov/jsonapi                                          | unavailable | status 404                                                                                                                                                         |
| bls       | news_sitemap | https://www.bls.gov/sitemap-news.xml                                 | unavailable | status 404                                                                                                                                                         |
| bls       | news_sitemap | https://www.bls.gov/news-sitemap.xml                                 | unavailable | status 404                                                                                                                                                         |
| bls       | robots       | https://www.bls.gov/robots.txt                                       | available   | https://www.bls.gov/sitemap.xml                                                                                                                                    |
| cdc       | wordpress    | https://www.cdc.gov/wp-json/wp/v2/posts?per_page=1                   | unavailable | status 404                                                                                                                                                         |
| cdc       | drupal       | https://www.cdc.gov/jsonapi                                          | unavailable | status 404                                                                                                                                                         |
| cdc       | news_sitemap | https://www.cdc.gov/sitemap-news.xml                                 | unavailable | status 404                                                                                                                                                         |
| cdc       | news_sitemap | https://www.cdc.gov/news-sitemap.xml                                 | unavailable | status 404                                                                                                                                                         |
| cdc       | robots       | https://www.cdc.gov/robots.txt                                       | available   | https://www.cdc.gov/wcms-auto-sitemap-index.xml                                                                                                                    |
| doj       | wordpress    | https://www.justice.gov/wp-json/wp/v2/posts?per_page=1               | unavailable | status 404                                                                                                                                                         |
| doj       | drupal       | https://www.justice.gov/jsonapi                                      | unavailable | status 404                                                                                                                                                         |
| doj       | news_sitemap | https://www.justice.gov/sitemap-news.xml                             | unavailable | status 404                                                                                                                                                         |
| doj       | news_sitemap | https://www.justice.gov/news-sitemap.xml                             | unavailable | status 404                                                                                                                                                         |
| doj       | robots       | https://www.justice.gov/robots.txt                                   | available   | https://www.justice.gov/sitemap.xml                                                                                                                                |
| fda       | wordpress    | https://www.fda.gov/wp-json/wp/v2/posts?per_page=1                   | unavailable | status 404                                                                                                                                                         |
| fda       | drupal       | https://www.fda.gov/jsonapi                                          | unavailable | status 404                                                                                                                                                         |
| fda       | news_sitemap | https://www.fda.gov/sitemap-news.xml                                 | unavailable | status 404                                                                                                                                                         |
| fda       | news_sitemap | https://www.fda.gov/news-sitemap.xml                                 | unavailable | status 404                                                                                                                                                         |
| fda       | robots       | https://www.fda.gov/robots.txt                                       | available   | https://www.fda.gov/sitemap.xml                                                                                                                                    |
| fsa       | wordpress    | https://fsapartners.ed.gov/wp-json/wp/v2/posts?per_page=1            | unavailable | status 404                                                                                                                                                         |
| fsa       | drupal       | https://fsapartners.ed.gov/jsonapi                                   | unavailable | status 404                                                                                                                                                         |
| fsa       | news_sitemap | https://fsapartners.ed.gov/sitemap-news.xml                          | unavailable | status 404                                                                                                                                                         |
| fsa       | news_sitemap | https://fsapartners.ed.gov/news-sitemap.xml                          | unavailable | status 404                                                                                                                                                         |
| fsa       | robots       | https://fsapartners.ed.gov/robots.txt                                | available   | https://fsapartners.ed.gov/sitemap.xml, https://fsapartners.ed.gov/sitemap_root.xml                                                                                |
| irs       | wordpress    | https://www.irs.gov/wp-json/wp/v2/posts?per_page=1                   | unavailable | status 404                                                                                                                                                         |
| irs       | drupal       | https://www.irs.gov/jsonapi                                          | unavailable | status 404                                                                                                                                                         |
| irs       | news_sitemap | https://www.irs.gov/sitemap-news.xml                                 | unavailable | status 404                                                                                                                                                         |
| irs       | news_sitemap | https://www.irs.gov/news-sitemap.xml                                 | unavailable | status 404                                                                                                                                                         |
| irs       | robots       | https://www.irs.gov/robots.txt                                       | available   | https://www.irs.gov/sitemap.xml                                                                                                                                    |
| nasa      | wordpress    | https://www.nasa.gov/wp-json/wp/v2/posts?per_page=1                  | available   | 1 post(s) returned                                                                                                                                                 |
| nasa      | drupal       | https://www.nasa.gov/jsonapi                                         | unavailable | status 404                                                                                                                                                         |
| nasa      | news_sitemap | https://www.nasa.gov/sitemap-news.xml                                | unavailable | status 404                                                                                                                                                         |
| nasa      | news_sitemap | https://www.nasa.gov/news-sitemap.xml                                | unavailable | status 404                                                                                                                                                         |
| nasa      | robots       | https://www.nasa.gov/robots.txt                                      | unavailable | no sitemap declarations                                                                                                                                            |
| ncbi      | wordpress    | https://ncbiinsights.ncbi.nlm.nih.gov/wp-json/wp/v2/posts?per_page=1 | unavailable | status 401                                                                                                                                                         |
| ncbi      | drupal       | https://ncbiinsights.ncbi.nlm.nih.gov/jsonapi                        | unavailable | status 404                                                                                                                                                         |
| ncbi      | news_sitemap | https://ncbiinsights.ncbi.nlm.nih.gov/sitemap-news.xml               | unavailable | status 404                                                                                                                                                         |
| ncbi      | news_sitemap | https://ncbiinsights.ncbi.nlm.nih.gov/news-sitemap.xml               | available   | google news namespace present                                                                                                                                      |
| ncbi      | robots       | https://ncbiinsights.ncbi.nlm.nih.gov/robots.txt                     | available   | https://ncbiinsights.ncbi.nlm.nih.gov/sitemap.xml, https://ncbiinsights.ncbi.nlm.nih.gov/news-sitemap.xml, https://ncbiinsights.ncbi.nlm.nih.gov/sitemap_index.xml |
| noaa      | wordpress    | https://www.noaa.gov/wp-json/wp/v2/posts?per_page=1                  | unavailable | status 403                                                                                                                                                         |
| noaa      | drupal       | https://www.noaa.gov/jsonapi                                         | unavailable | no node links                                                                                                                                                      |
| noaa      | news_sitemap | https://www.noaa.gov/sitemap-news.xml                                | unavailable | status 404                                                                                                                                                         |
| noaa      | news_sitemap | https://www.noaa.gov/news-sitemap.xml                                | unavailable | status 404                                                                                                                                                         |
| noaa      | robots       | https://www.noaa.gov/robots.txt                                      | unavailable | no sitemap declarations                                                                                                                                            |
| nps       | wordpress    | https://www.nps.gov/wp-json/wp/v2/posts?per_page=1                   | unavailable | status 404                                                                                                                                                         |
| nps       | drupal       | https://www.nps.gov/jsonapi                                          | unavailable | status 404                                                                                                                                                         |
| nps       | news_sitemap | https://www.nps.gov/sitemap-news.xml                                 | unavailable | status 404                                                                                                                                                         |
| nps       | news_sitemap | https://www.nps.gov/news-sitemap.xml                                 | unavailable | status 404                                                                                                                                                         |
| nps       | robots       | https://www.nps.gov/robots.txt                                       | available   | https://www.nps.gov/sitemap.xml                                                                                                                                    |
| nws       | wordpress    | https://www.weather.gov/wp-json/wp/v2/posts?per_page=1               | unavailable | status 404                                                                                                                                                         |
| nws       | drupal       | https://www.weather.gov/jsonapi                                      | unavailable | status 404                                                                                                                                                         |
| nws       | news_sitemap | https://www.weather.gov/sitemap-news.xml                             | unavailable | status 404                                                                                                                                                         |
| nws       | news_sitemap | https://www.weather.gov/news-sitemap.xml                             | unavailable | status 404                                                                                                                                                         |
| nws       | robots       | https://www.weather.gov/robots.txt                                   | unavailable | status 404                                                                                                                                                         |
| sec       | wordpress    | https://www.sec.gov/wp-json/wp/v2/posts?per_page=1                   | unavailable | status 404                                                                                                                                                         |
| sec       | drupal       | https://www.sec.gov/jsonapi                                          | unavailable | status 404                                                                                                                                                         |
| sec       | news_sitemap | https://www.sec.gov/sitemap-news.xml                                 | unavailable | status 404                                                                                                                                                         |
| sec       | news_sitemap | https://www.sec.gov/news-sitemap.xml                                 | unavailable | status 404                                                                                                                                                         |
| sec       | robots       | https://www.sec.gov/robots.txt                                       | available   | https://www.sec.gov/sec-sitemap.xml, https://www.sec.gov/sitemap/sitemap-index.xml, https://www.investor.gov/sitemap.xml                                           |
| ssa       | wordpress    | https://www.ssa.gov/wp-json/wp/v2/posts?per_page=1                   | unavailable | status 403                                                                                                                                                         |
| ssa       | drupal       | https://www.ssa.gov/jsonapi                                          | unavailable | status 404                                                                                                                                                         |
| ssa       | news_sitemap | https://www.ssa.gov/sitemap-news.xml                                 | unavailable | status 404                                                                                                                                                         |
| ssa       | news_sitemap | https://www.ssa.gov/news-sitemap.xml                                 | unavailable | status 404                                                                                                                                                         |
| ssa       | robots       | https://www.ssa.gov/robots.txt                                       | available   | https://www.ssa.gov/sitemap.xml, https://www.ssa.gov/sitemap1.xml, https://www.ssa.gov/search-gov/sitemap.xml                                                      |
| ssa       | wordpress    | https://blog.ssa.gov/wp-json/wp/v2/posts?per_page=1                  | unavailable | text/html; charset=UTF-8                                                                                                                                           |
| ssa       | drupal       | https://blog.ssa.gov/jsonapi                                         | unavailable | text/html; charset=UTF-8                                                                                                                                           |
| ssa       | news_sitemap | https://blog.ssa.gov/sitemap-news.xml                                | unavailable | no news namespace                                                                                                                                                  |
| ssa       | news_sitemap | https://blog.ssa.gov/news-sitemap.xml                                | unavailable | no news namespace                                                                                                                                                  |
| ssa       | robots       | https://blog.ssa.gov/robots.txt                                      | unavailable | no sitemap declarations                                                                                                                                            |
| state     | wordpress    | https://www.state.gov/wp-json/wp/v2/posts?per_page=1                 | unavailable | no posts returned                                                                                                                                                  |
| state     | drupal       | https://www.state.gov/jsonapi                                        | unavailable | status 404                                                                                                                                                         |
| state     | news_sitemap | https://www.state.gov/sitemap-news.xml                               | unavailable | status 404                                                                                                                                                         |
| state     | news_sitemap | https://www.state.gov/news-sitemap.xml                               | unavailable | status 404                                                                                                                                                         |
| state     | robots       | https://www.state.gov/robots.txt                                     | available   | https://www.state.gov/sitemap_index.xml                                                                                                                            |
| treasury  | wordpress    | https://home.treasury.gov/wp-json/wp/v2/posts?per_page=1             | unavailable | status 404                                                                                                                                                         |
| treasury  | drupal       | https://home.treasury.gov/jsonapi                                    | unavailable | status 404                                                                                                                                                         |
| treasury  | news_sitemap | https://home.treasury.gov/sitemap-news.xml                           | unavailable | status 404                                                                                                                                                         |
| treasury  | news_sitemap | https://home.treasury.gov/news-sitemap.xml                           | unavailable | status 404                                                                                                                                                         |
| treasury  | robots       | https://home.treasury.gov/robots.txt                                 | unavailable | no sitemap declarations                                                                                                                                            |
| uscis     | wordpress    | https://www.uscis.gov/wp-json/wp/v2/posts?per_page=1                 | unavailable | status 404                                                                                                                                                         |
| uscis     | drupal       | https://www.uscis.gov/jsonapi                                        | unavailable | status 404                                                                                                                                                         |
| uscis     | news_sitemap | https://www.uscis.gov/sitemap-news.xml                               | unavailable | status 404                                                                                                                                                         |
| uscis     | news_sitemap | https://www.uscis.gov/news-sitemap.xml                               | unavailable | status 404                                                                                                                                                         |
| uscis     | robots       | https://www.uscis.gov/robots.txt                                     | unavailable | no sitemap declarations                                                                                                                                            |
| usda      | wordpress    | https://www.usda.gov/wp-json/wp/v2/posts?per_page=1                  | unavailable | status 404                                                                                                                                                         |
| usda      | drupal       | https://www.usda.gov/jsonapi                                         | unavailable | status 404                                                                                                                                                         |
| usda      | news_sitemap | https://www.usda.gov/sitemap-news.xml                                | unavailable | status 404                                                                                                                                                         |
| usda      | news_sitemap | https://www.usda.gov/news-sitemap.xml                                | unavailable | status 404                                                                                                                                                         |
| usda      | robots       | https://www.usda.gov/robots.txt                                      | unavailable | no sitemap declarations                                                                                                                                            |
| usgs      | wordpress    | https://www.usgs.gov/wp-json/wp/v2/posts?per_page=1                  | unavailable | status 404                                                                                                                                                         |
| usgs      | drupal       | https://www.usgs.gov/jsonapi                                         | unavailable | status 404                                                                                                                                                         |
| usgs      | news_sitemap | https://www.usgs.gov/sitemap-news.xml                                | unavailable | status 404                                                                                                                                                         |
| usgs      | news_sitemap | https://www.usgs.gov/news-sitemap.xml                                | unavailable | status 404                                                                                                                                                         |
| usgs      | robots       | https://www.usgs.gov/robots.txt                                      | available   | https://www.usgs.gov/sitemap.xml                                                                                                                                   |
| usps      | wordpress    | https://about.usps.com/wp-json/wp/v2/posts?per_page=1                | unavailable | status 403                                                                                                                                                         |
| usps      | drupal       | https://about.usps.com/jsonapi                                       | unavailable | status 403                                                                                                                                                         |
| usps      | news_sitemap | https://about.usps.com/sitemap-news.xml                              | unavailable | status 404                                                                                                                                                         |
| usps      | news_sitemap | https://about.usps.com/news-sitemap.xml                              | unavailable | status 404                                                                                                                                                         |
| usps      | robots       | https://about.usps.com/robots.txt                                    | unavailable | no sitemap declarations                                                                                                                                            |
| va        | wordpress    | https://news.va.gov/wp-json/wp/v2/posts?per_page=1                   | available   | 1 post(s) returned                                                                                                                                                 |
| va        | drupal       | https://news.va.gov/jsonapi                                          | unavailable | status 404                                                                                                                                                         |
| va        | news_sitemap | https://news.va.gov/sitemap-news.xml                                 | unavailable | status 404                                                                                                                                                         |
| va        | news_sitemap | https://news.va.gov/news-sitemap.xml                                 | unavailable | status 404                                                                                                                                                         |
| va        | robots       | https://news.va.gov/robots.txt                                       | available   | https://news.va.gov/sitemap_index.xml                                                                                                                              |
| va        | wordpress    | https://www.va.gov/wp-json/wp/v2/posts?per_page=1                    | unavailable | status 404                                                                                                                                                         |
| va        | drupal       | https://www.va.gov/jsonapi                                           | unavailable | status 404                                                                                                                                                         |
| va        | news_sitemap | https://www.va.gov/sitemap-news.xml                                  | unavailable | status 404                                                                                                                                                         |
| va        | news_sitemap | https://www.va.gov/news-sitemap.xml                                  | unavailable | status 404                                                                                                                                                         |
| va        | robots       | https://www.va.gov/robots.txt                                        | available   | https://www.va.gov/sitemap_index.xml, https://www.va.gov/sitemap-cb.xml, https://www.va.gov/sitemap-nb.xml                                                         |

## Findings

The automated probe covered all 20 cohort publishers across 22 origins. A
verdict of `available` means the structured surface responded with the shape
required by its adapter; it does not by itself make that surface a historical
backfill winner.

### Candidate strategy decisions

| Publisher        | Candidate                                                | Evidence                                                                                                                                                                                                            | Decision                                                                                                                                       |
| ---------------- | -------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------- |
| CDC              | `https://www.cdc.gov/media/wcms-auto-sitemap.xml`        | Declared through the CDC sitemap index. Dry run found 69 candidates, 68 valid in-window releases, and 68/68 summaries at least 200 characters.                                                                      | Prepend as the primary v3 source; retain the search endpoint as fallback and independent provenance.                                           |
| DOJ              | `https://www.justice.gov/sitemap.xml`                    | Declared in `robots.txt`. Dry run found 1,292 last-modified-filtered candidates and 1,248 valid in-window press releases after article hydration. All 1,248 accepted rows had summaries of at least 200 characters. | Prepend as a complementary live source; retain archived listings for deleted or otherwise unavailable releases.                                |
| NCBI             | `https://ncbiinsights.ncbi.nlm.nih.gov/news-sitemap.xml` | Google News namespace is present, but the live document contains only the site root and zero news article records.                                                                                                  | Do not use for the historical run. Keep Google News sitemap support available for current-tail collection when a publisher exposes real items. |
| NOAA             | `https://www.noaa.gov/jsonapi`                           | A JSON:API envelope exists but advertises no node collections. Manual checks of likely `node/news`, `node/news_release`, and `node/article` collections returned 404.                                               | Do not replace the productive NOAA sitemap. Keep the Drupal adapter tested and dormant for publishers with usable collections.                 |
| NASA and VA      | WordPress endpoints                                      | Both probes returned post-shaped JSON. These are already the v2 strategies.                                                                                                                                         | Retain unchanged.                                                                                                                              |
| Other publishers | Robots-declared or generic sitemaps                      | Either already used by v2, contained no article-level news inventory, or did not improve on the existing structured/archive source.                                                                                 | Retain v2 source selection.                                                                                                                    |

### Dry-run quality evidence

| Source                | Candidates | Accepted | Rejected | Summary present | Summary at least 200 chars |
| --------------------- | ---------: | -------: | -------: | --------------: | -------------------------: |
| CDC media sitemap     |         69 |       68 |        1 |              68 |                         68 |
| CDC search endpoint   |         83 |       68 |       15 |              68 |                          1 |
| DOJ live sitemap      |      1,292 |    1,248 |       44 |           1,248 |                      1,248 |
| DOJ archived listings |        120 |      110 |       10 |             110 |                         91 |

The DOJ increase is larger than the plan's five-times-change review threshold.
The change is intentional: the archived-listing method yielded only 110 valid
releases, while the publisher's live sitemap exposes the complete current
press-release inventory. The expansion adds article URLs rather than merging
same-event coverage, so it preserves the clustering evaluation requirement.

CDC pages expose their actual publication time in `cdc:first_published` rather
than the metadata fields previously read by the extractor. The v3 collector
reads that field so the sitemap is not forced to use a page-update timestamp.

## Frozen v3 manifest

- Cohort: `top-20-diversity-v3`
- Window: `2025-07-18T00:00:00.000Z` through `2026-07-18T00:00:00.000Z`
- Publishers: 20
- Source targets: 28
- SHA-256: `864ae3f53b231879117c5ee7399d439b98dd56e1bcc0a2a1bdfd5b564eb6efc9`

The completed v2 run remains immutable. The v3 run uses the same event-time
window and upserts into the shared `news_entries` corpus, so existing canonical
article URLs gain new run/source provenance while genuinely new URLs become new
article rows. The staged hosted run is
`fed1e29e-2086-448c-b913-b5646fae87c5`.

## Hosted execution evidence

The first v3 execution was deliberately filtered to the two publishers whose
source selection changed. It is a delta over the completed v2 run, not a claim
that all unchanged publishers were replayed under v3 provenance. Because a
publisher-filtered execution does not close the full 20-publisher run envelope,
the run remains `running`; its four materialized targets are all terminal and
successful.

| Publisher | Target                               | Candidates | Inserted | Existing | Rejected | Conflicts | Status    |
| --------- | ------------------------------------ | ---------: | -------: | -------: | -------: | --------: | --------- |
| CDC       | `cdc-media-sitemap`                  |         69 |        1 |       67 |        1 |         0 | succeeded |
| CDC       | `cdc-newsroom-search`                |         83 |        0 |       68 |       15 |         0 | succeeded |
| DOJ       | `doj-press-release-live-sitemap`     |      1,293 |    1,140 |      108 |       45 |         0 | succeeded |
| DOJ       | `doj-press-release-wayback-listings` |        120 |        0 |      110 |       10 |         0 | succeeded |

The shared corpus grew from 6,553 to 7,694 unique URL-distinct
`news_entries`: 1,141 new rows, all attributable to the changed source targets.
An identical CDC/DOJ rerun reported every target as already terminal and left
the corpus at 7,694 rows, proving idempotency. This URL-level identity behavior
is intentional: separate government URLs covering the same event remain
separate rows for the clustering evaluation.

The live completeness results hold the dry-run decision:

- CDC's sitemap accepted 68 in-window releases with publication dates and
  summaries of at least 200 characters for all 68; the retained search source
  accepted the same 68 releases but produced only one summary at that length.
- DOJ's live sitemap accepted 1,248 in-window releases with publication dates
  and summaries of at least 200 characters for all 1,248. The retained archive
  source accepted 110 releases, of which 91 had summaries at that length.

The live DOJ candidate count is one higher than the earlier dry run because the
publisher sitemap changed between observations; accepted completeness and the
source-selection conclusion are unchanged.
