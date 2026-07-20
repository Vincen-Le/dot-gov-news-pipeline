# News corpus topology and seeded-category audit

**Snapshot:** July 18, 2026
**Scope:** All 9,657 hosted `news_entries`; read-only analysis
**Purpose:** Estimate which entries belong to a continuing storyline, which belong to the same episode, and which remain singleton episode/storylines.

## Executive summary

The corpus is predominantly singleton material, but the clusterable minority accounts for a meaningful share of rows:

- An estimated **94.48–95.51% of storylines are singleton episode/storylines**.
- An estimated **4.03–5.09% are multi-episode storylines**: one continuing story with distinct developments over time.
- An estimated **0.43–0.46% are multi-entry, single-episode storylines**: multiple reports about the same development.
- Combined, only **4.49–5.52% of storylines are non-singletons**, but they contain **14.75–17.88% of all entries**.
- Only **0.72–0.91% of estimated episodes contain multiple entries**. Those episodes account for **169–262 entries**, or **1.75–2.71% of the corpus**.

This makes the corpus useful for both singleton retrieval and storyline experiments, but the chain-rich material is concentrated. `advisory` and `release` rows, especially disaster/wildfire, labor statistics, tax policy, financial regulation, public health, and environmental response, produce far more continuing storylines than the corpus average.

## Coverage and confidence

| Measure                                |         Result |
| -------------------------------------- | -------------: |
| Entries audited                        |          9,657 |
| Entries with body text                 | 9,433 (97.68%) |
| Publishers                             |             29 |
| Origin/news subtypes                   |              4 |
| Seeded topic categories                |             23 |
| Category assignment: high confidence   | 8,031 (83.16%) |
| Category assignment: medium confidence |    823 (8.52%) |
| Category assignment: low confidence    |    803 (8.32%) |

The table does not contain adjudicated storyline, episode, or entry-level topic labels, so these are estimates rather than ground truth. Two deterministic passes bracket the likely distribution:

- **Strict** is a high-precision floor based on explicit event identifiers, incident/case names, strong title and entity overlap, and close timing.
- **Balanced** adds modest lexical and entity similarity while retaining split-biased timing rules.

Both passes use a four-hour episode dormancy threshold and a 72-hour near-duplicate window. Generic recurring editorial formats such as public schedules and weekly job roundups are excluded. Named continuing statistical series such as JOLTS are retained as storylines with successive episodes; treating every periodic release as a new storyline would lower the multi-episode estimate.

## Estimated storyline topology

| Topology                              | Strict storylines | Strict share | Balanced storylines | Balanced share | Entries, strict | Entries, balanced |
| ------------------------------------- | ----------------: | -----------: | ------------------: | -------------: | --------------: | ----------------: |
| Multi-episode storyline               |               347 |        4.03% |                 427 |          5.09% |  1,340 (13.88%) |    1,636 (16.94%) |
| Multi-entry, single-episode storyline |                40 |        0.46% |                  36 |          0.43% |      84 (0.87%) |        91 (0.94%) |
| Singleton episode/storyline           |             8,233 |       95.51% |               7,930 |         94.48% |  8,233 (85.25%) |    7,930 (82.12%) |
| **Total estimated storylines**        |         **8,620** |     **100%** |           **8,393** |       **100%** |       **9,657** |         **9,657** |

### Episode size

| Episode measure                 |                Strict |              Balanced |
| ------------------------------- | --------------------: | --------------------: |
| Estimated episodes              |                 9,557 |                 9,481 |
| Single-entry episodes           |                 9,488 |                 9,395 |
| Multi-entry episodes            |            69 (0.72%) |            86 (0.91%) |
| Entries in multi-entry episodes | 169 (1.75% of corpus) | 262 (2.71% of corpus) |

The counts answer two different questions. A multi-episode storyline may contain several single-entry episodes, while a multi-entry episode may sit inside either a one-episode or continuing storyline.

## Distribution by origin/news subtype

| Subtype         | Entries | Corpus share | Estimated non-singleton storyline rate | Interpretation                                          |
| --------------- | ------: | -----------: | -------------------------------------: | ------------------------------------------------------- |
| `press_release` |   6,131 |       63.49% |                             4.03–5.14% | Most corpus volume; modest chain yield overall          |
| `agency_news`   |   2,803 |       29.03% |                             2.83–3.57% | Mostly standalone agency reporting                      |
| `advisory`      |     501 |        5.19% |                           42.28–47.06% | Highest chain yield, driven heavily by active incidents |
| `release`       |     222 |        2.30% |                           17.43–20.59% | Strong recurring-policy and statistical-release yield   |

The small `advisory` slice is disproportionately valuable for storyline evaluation: it is only 5.19% of rows, yet roughly half of its estimated storylines are non-singletons.

## Distribution across the 23 seeded categories

“Non-singleton rate” includes both multi-episode storylines and multi-entry, same-episode storylines. The range is strict to balanced.

| Seeded category                   |   Entries | Corpus share | Estimated multi-episode storylines | Estimated non-singleton rate |
| --------------------------------- | --------: | -----------: | ---------------------------------: | ---------------------------: |
| Foreign Affairs & Trade           |     1,778 |       18.41% |                                 86 |                        5.73% |
| Public Lands & Natural Resources  |     1,154 |       11.95% |                              22–27 |                   2.47–2.98% |
| Justice & Law Enforcement         |     1,055 |       10.92% |                              21–38 |                   2.14–3.99% |
| Science & Space                   |       899 |        9.31% |                              17–20 |                   1.95–2.31% |
| Energy & Environment              |       866 |        8.97% |                              22–38 |                   4.43–6.84% |
| Veterans Affairs                  |       856 |        8.86% |                                  4 |                        0.47% |
| Disaster Response & Emergency     |       705 |        7.30% |                              83–84 |                 29.87–31.58% |
| Financial Regulation              |       428 |        4.43% |                              27–33 |                   7.55–9.60% |
| Taxes & Revenue                   |       382 |        3.96% |                              15–20 |                   5.76–6.98% |
| Agriculture                       |       332 |        3.44% |                              11–20 |                   3.79–6.98% |
| Courts & Legal Rulings            |       313 |        3.24% |                               6–14 |                   1.96–4.73% |
| Economy & Labor                   |       192 |        1.99% |                              16–17 |                 20.24–22.78% |
| Food & Drug Safety                |       127 |        1.32% |                                0–1 |                      0–0.79% |
| Elections & Government Operations |       113 |        1.17% |                                2–7 |                   1.83–6.86% |
| Public Health                     |       110 |        1.14% |                               9–10 |                 11.49–12.79% |
| Immigration & Border              |       105 |        1.09% |                                  4 |                   3.96–4.08% |
| Education                         |        67 |        0.69% |                                  0 |                           0% |
| Defense & Military                |        66 |        0.68% |                                  0 |                           0% |
| Social Security & Benefits        |        39 |        0.40% |                                  1 |                        2.63% |
| Technology & Cybersecurity        |        27 |        0.28% |                                0–2 |                      0–8.00% |
| Civil Rights & Liberties          |        21 |        0.22% |                                  1 |                        5.00% |
| Transportation & Infrastructure   |        12 |        0.12% |                                  0 |                           0% |
| Housing & Urban Development       |        10 |        0.10% |                                  0 |                           0% |
| **Total**                         | **9,657** |     **100%** |                                    |                              |

The largest categories mostly reflect the current publisher mix. The best combination of meaningful volume and chain yield is Disaster Response & Emergency. Economy & Labor, Public Health, Financial Regulation, Taxes & Revenue, and Energy & Environment also have above-average chain yield, though some are small in absolute volume.

The tail is extremely sparse. Housing, Transportation, Civil Rights, Technology, Social Security, Defense, and Education together contribute only 242 entries (2.51%). Their observed zero or low chain rate should be read primarily as a source-coverage gap, not evidence that those topics lack continuing events.

## Concrete examples

### Multi-episode storylines

- **Babylon Fire (InciWeb):** 32 entries across an estimated 28 episodes from June 27 to July 14, 2026. Updates cover changing containment, acreage, operations, closures, and status.
- **Pocket Fire (InciWeb):** 23 entries across 23 estimated episodes from June 21 to July 14, 2026.
- **Working Families Tax Cuts / One Big Beautiful Bill implementation (IRS):** 23 entries across 22 estimated episodes from July 30, 2025 to April 30, 2026.
- **Job Openings and Labor Turnover Survey (BLS):** 18 entries across 18 monthly-release episodes from July 23, 2025 to June 30, 2026.
- **Kīlauea chronology (USGS):** 16 photo/video and status entries across 16 estimated episodes from July 22, 2025 to July 15, 2026.
- **Tangipahoa cleanup (EPA):** 14 entries from October 3–24, 2025, covering successive response and cleanup developments.
- **Tennessee April 2–24 storms (FEMA):** 10 entries from July 18 to August 21, 2025, spanning declarations, assistance, deadlines, and follow-up actions.

### Multiple entries in the same episode

- **EPA Brownfields grant announcement:** 17 coordinated local releases published within roughly four hours on June 24, 2026. They describe the same nationwide funding episode for different recipients.
- **EPA PFAS state-grant announcement:** five related releases published within about 15 minutes on May 19, 2026.
- **CFTC and SEC joint crypto statement:** two agency releases covering the same joint regulatory development on September 2, 2025.
- **State Department ICC sanctions:** two substantively identical releases tied to the same sanctions action.

### Singleton episode/storylines

- FDA clinical hold on Sarepta’s Elevidys program.
- Secretary Rubio’s call with the president of Djibouti.
- DOJ indictment of eight Young Mob gang members.
- Federal Student Aid notice concerning a student-loan provision.

These singleton examples have no sufficiently strong companion entry in this snapshot. That does not mean the underlying real-world subject had no history; it means the corpus does not currently contain another row that clears the audit’s storyline threshold.

## Operational implications

1. **Use the current corpus as a mixed benchmark.** It offers a large singleton retrieval set plus roughly 1,400–1,700 rows in estimated non-singleton storylines.
2. **Stratify evaluations.** Report results separately for multi-episode storylines, multi-entry episodes, and singleton episode/storylines; aggregate accuracy will otherwise be dominated by singletons.
3. **Oversample advisories and chain-rich categories when testing storyline behavior.** Disaster, labor, public health, financial regulation, tax, and environmental sources provide the highest yield.
4. **Do not infer topic quality from the sparse tail.** Additional raw ingestion is needed before evaluating clustering performance for Housing, Transportation, Civil Rights, Technology, Social Security, Defense, or Education.
5. **Keep periodic-series policy explicit.** JOLTS-like releases can reasonably be modeled as episodes within a continuing storyline or as independent stories. Evaluation labels should state which interpretation is intended.

## Reproduction and safeguards

Run the read-only audit from the repository root:

```bash
.venv/bin/python scripts/audit-news-corpus.py --mode strict --pretty
.venv/bin/python scripts/audit-news-corpus.py --mode balanced --pretty
```

By default, the script reads the hosted tables, verifies that all 23 expected seeded categories are present, asserts that category, subtype, storyline, episode, and entry totals reconcile, and performs **zero database writes**. An explicit `--publish` option can write the derived labels to the versioned topology sidecar tables; it still does not run enrichment, create embeddings, modify `news_entries`, or persist production clusters. See [Topology-label curation](topology-label-curation.md).
