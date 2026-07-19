# High-volume alert agencies and major U.S. event chains

Research date: 2026-07-18

Research window: 2025-07-18 through 2026-07-18

Purpose: identify new official publishers that can broaden the news corpus while increasing the probability of multi-entry episodes and multi-source storylines.

## Executive conclusion

The best expansion is not another traffic-ranked list of general press rooms. It is a set of incident systems and case systems whose publishing process naturally produces updates.

The strongest immediate additions are:

1. **NIFC/InciWeb plus state fire incident systems, beginning with CAL FIRE.** This is the highest-confidence way to add dense, named natural-disaster episodes. InciWeb's sitemap contained 3,890 incident-content `node` URLs modified during the research window. CAL FIRE published 140 status updates for the Gifford Fire alone.
2. **U.S. Coast Guard operational press releases.** The archive contains an estimated 560–600 releases in the window and repeatedly produces search → update → suspension/rescue and port-condition → assessment → reopening chains. It needs strong exclusions for ceremonies and routine personnel news.
3. **Nuclear Regulatory Commission event notifications.** NRC published 243 daily reports in the window. Those reports contained 75 distinct event numbers; 42 of the 75 appeared in more than one report. That observed 56% repeat rate is unusually strong evidence of update-chain yield.
4. **U.S. Army Corps of Engineers operational districts.** Headquarters output is modest, but district and dedicated response pages create dense disaster sequences. Seattle District issued 16 releases during the December 2025 atmospheric-river response alone.
5. **OSHA plus the Chemical Safety Board.** Their volume is lower, but an industrial accident naturally becomes an investigation-opening, factual update, recommendation, citation, contest, settlement, and sometimes final-report chain.
6. **NTSB plus FAA.** This pair has low newsroom volume but exceptional event identity and lifecycle depth. The UPS Flight 2976 investigation already has an accident ID, preliminary report, multiple media briefings, a two-day hearing, and a 123-item public docket.
7. **CFTC enforcement and NLRB case/decision streams.** These are better legal-story sources than another undifferentiated press feed because complaints, orders, judgments, appeals, and case numbers can be joined deterministically.
8. **State emergency-management, transportation, fire, and governor incident pages.** They provide the missing local onset and operational detail around federal declarations. Texas and Washington are the first states to add based on events in this window.

CBP and ICE are also genuinely high-volume publishers, but most of their output is singleton-prone. They should be a second-wave, case-linked expansion rather than the foundation of a storyline-oriented cohort.

## Scope: what “outside the current agencies” means

This report excludes publishers already represented in either active research cohort:

`bls`, `cdc`, `cisa`, `doj`, `eeoc`, `epa`, `fda`, `fema`, `fsa`, `ftc`, `irs`, `nasa`, `ncbi`, `noaa`, `nps`, `nws`, `sec`, `sec-enforcement`, `ssa`, `state`, `treasury`, `uscis`, `usda`, `usgs`, `usps`, and `va`.

An already-covered publisher may appear in an event map as a corroborating source, but it is not counted as a new-agency recommendation.

## Method

The research used four signals:

- **Observed publishing volume:** dates and rows counted from official archives, sitemaps, APIs, or daily-report indexes for the twelve-month window.
- **Chain yield:** whether the publisher exposes a stable incident, event, accident, inspection, release, or case identifier and whether the same event demonstrably receives updates.
- **Multi-source compatibility:** whether other official organizations predictably report a different stage or operational perspective on the same event.
- **Technical accessibility:** RSS, XML sitemap, paginated archive, structured incident page, raw dataset, or predictable identifier-based URL.

Traffic is a secondary signal only. The “visits” figures below come from the supplied `Top 100000 Domains Last 30 Days.csv` dataset and aggregate each root plus its subdomains. A high-traffic site can still be poor for clustering, and a low-traffic regulator can be excellent.

Counts labeled “observed” are direct counts. Counts labeled “estimate” use visible archive pagination or sitemap modification dates and should be validated by a dry-run probe before a production backfill.

## Demand baseline: the country produced enough clusterable events

An [OpenFEMA Disaster Declarations Summaries](https://www.fema.gov/about/openfema/disaster-declarations-summaries) API query for declaration dates in the window returned 1,719 state/county/tribal rows belonging to **114 distinct declarations**. The row count is not an incident count; the unique disaster number is.

| Incident type       | Distinct declarations |
| ------------------- | --------------------: |
| Fire                |                    46 |
| Winter storm        |                    21 |
| Flood               |                    16 |
| Severe storm        |                    15 |
| Straight-line winds |                     5 |
| Tropical storm      |                     4 |
| Typhoon             |                     2 |
| Chemical            |                     1 |
| Severe ice storm    |                     1 |
| Tropical depression |                     1 |
| Hurricane           |                     1 |
| Other               |                     1 |
| **Total**           |               **114** |

This is enough demand to support a recurring disaster cohort. Fire alone accounts for 40% of declarations, while winter, flood, and severe-storm declarations account for another 46%. The current corpus should therefore treat operational disaster sources as a permanent source family rather than an occasional backfill.

## Measured new-source volume

| Publisher or system      |                                                                                       Direct observation in the window |                      30-day root visits | Chain evidence                                                                            | Interpretation                                                        |
| ------------------------ | ---------------------------------------------------------------------------------------------------------------------: | --------------------------------------: | ----------------------------------------------------------------------------------------- | --------------------------------------------------------------------- |
| NIFC / InciWeb           |                                                  3,890 `node` sitemap rows modified; 4,124 recent sitemap URLs overall |    `nifc.gov` 682k; `wildfire.gov` 431k | Named incident pages contain news, closures, maps, photographs, and repeated updates      | Highest-volume incident-content system in this review                 |
| CAL FIRE incident system |                  8,232 wildfires and 608,571 emergency responses in calendar 2025; Gifford Fire has 140 status updates |            Not in supplied top-100k cut | Stable incident URL with child update URLs                                                | Best state-level proof that one event can yield a dense episode       |
| U.S. Coast Guard         | **Estimate: 560–600** releases; archive boundary fell between pages showing Aug. 12 and July 9, 2025, at 10 items/page |                                  1.865m | Explicit `UPDATE`, search/rescue, port condition, pollution, and recovery sequences       | Very high volume; operational filters are mandatory                   |
| CBP                      |                                      **Observed: 560** media releases: 275 in 2026 plus 285 from Jul. 18–Dec. 31, 2025 |                                  8.090m | Repeated operations and major seizures exist, but local release stream is mostly one-offs | Useful for breadth after case/operation linking is available          |
| ICE                      |                                                                               **Observed: 363** dated newsroom entries |                                  2.133m | Investigation → charge → sentence/removal chains can join with DOJ and courts             | High volume, but likely singleton-heavy without entity/case joins     |
| NRC event notifications  |                                           **Observed: 243** daily reports, 75 event numbers, 42 repeated event numbers |                                    539k | Event number is explicit; 56% of observed events reappeared                               | Best structured federal alert feed in this review                     |
| CFTC press releases      |                                                                                             **Observed: 175** releases |                                    673k | Release numbers plus complaint/order/judgment language                                    | Strong legal lifecycle source                                         |
| OSHA news releases       |                                                     **Observed floor: 66** in the currently exposed all-releases index | 4.076m (`osha.gov`); 6.532m (`dol.gov`) | Accident → inspection → citation → contest/settlement                                     | Moderate volume, high chain value when paired with CSB                |
| USACE                    |           HQ archive is small, but district output is distributed; Seattle District published 16 releases in Dec. 2025 |                    10.592m (`army.mil`) | Dedicated response hubs and district update series                                        | Ingest selected districts/event hubs, not the entire Army news estate |
| NTSB                     |      12 press releases visible across the two year archives in-window; investigation pages and dockets are much deeper |                                     85k | Accident number, preliminary/final reports, hearings, recommendations, docket             | Low gross volume, exceptional precision and episode depth             |
| NLRB                     |                                                Officially states the Board issues “several hundred decisions per year” |                                    283k | Charge → complaint → ALJ → Board → appellate review                                       | Ingest cases/decisions rather than the sparse press room              |
| CSB                      |                                                      Six new and eight total ongoing investigations at FY2025 year-end |             Below supplied top-100k cut | Investigation ID, updates, recommendations, status changes, final report                  | Small but almost entirely cluster-dense                               |
| CENTCOM                  |                                                            Event-burst source rather than steady domestic-alert source |                                    273k | Named operations and dated operational updates                                            | Important war/national-security vertical                              |
| NORAD / USNORTHCOM       |                                                                                         Low-to-moderate release volume |                                     36k | Recurring ADIZ events, exercises, and domestic security operations                        | Good corroborator; not a large standalone cohort                      |

### Measurement notes

- The [InciWeb sitemap](https://inciweb.wildfire.gov/sitemap.xml) is a four-page Drupal sitemap. `lastmod` measures publication or modification, so 3,890 is a content-activity measure, not necessarily 3,890 new incidents.
- The [CAL FIRE 2025 incident archive](https://www.fire.ca.gov/incidents/2025) reports the annual response/wildfire totals. The [Gifford Fire updates page](https://www.fire.ca.gov/incidents/2025/8/1/gifford-fire/updates) exposed 140 unique update URLs when counted on July 18, 2026.
- The [Coast Guard press archive](https://www.news.uscg.mil/Press-Releases/) is live and re-paginates as new releases arrive, so its number is intentionally a range.
- CBP's [media-release archive](https://www.cbp.gov/newsroom/media-releases/all) exposes result counts by year and paginated release dates. ICE's [newsroom](https://www.ice.gov/newsroom) exposed 41 pages in the measurement.
- NRC exposes [year/day indexes, last-month raw data, and a data dictionary](https://www.nrc.gov/reading-rm/doc-collections/event-status/event/index), plus official [Daily Event Report and news RSS feeds](https://www.nrc.gov/public-involve/rss-feeds).
- CFTC's [press-release archive](https://www.cftc.gov/PressRoom/PressReleases) is a paginated Drupal view with year and enforcement filters. OSHA's [all-releases index](https://www.osha.gov/news/newsreleases/all) is date-structured but appears to be a rolling view, so 66 is a lower bound.

## Ranked source expansion

### Tier A — add to the next research/probe cohort

| Rank | New publisher family              | Target content                                                                                           | Why it should form chains                                                                                | Adapter shape                                                                | Required guardrail                                                                        |
| ---: | --------------------------------- | -------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------- |
|    1 | NIFC/InciWeb + CAL FIRE           | Incident news/updates, closures, recovery/BAER; CAL FIRE incident updates                                | Incidents have names, start dates, coordinates, status, and many child updates                           | Drupal sitemap + incident/update archive; probe CAL FIRE structured payloads | Exclude media-only duplicates; group on incident code/name + geography                    |
|    2 | NRC                               | Event notifications, Daily Event Report, NRC follow-up releases, inspections/enforcement                 | Event number persists across update reports and downstream action                                        | RSS/raw report/year archive                                                  | Do not turn empty daily reports into entries; preserve event number                       |
|    3 | U.S. Coast Guard                  | Search/rescue, port conditions, spills, storm/flood response, icebreaking, major interdiction operations | Operational releases use `UPDATE`, named operations, locations, vessels, and explicit status transitions | WEB.mil/DNN HTML archive; test ArticleCS RSS variants                        | Exclude change-of-command, commissioning, recruiting, routine ceremonies                  |
|    4 | USACE districts and response hubs | Emergency power, flood-fight, dam/levee operations, debris, recovery                                     | Missions begin before a declaration and continue through restoration                                     | WEB.mil district monthly archives and dedicated response pages               | Whitelist districts tied to declarations; exclude recreation notices and routine projects |
|    5 | OSHA + CSB                        | Fatal/major industrial incidents, investigations, citations, recommendations, settlements                | Two agencies cover different lifecycle stages and expose inspection/investigation identifiers            | OSHA sitemap/archive + CSB investigation/news/document pages                 | Require accident/company/location join; dedupe the same release syndicated by DOL         |
|    6 | NTSB + FAA                        | Major aviation, rail, highway, pipeline, and marine accidents                                            | Accident number anchors initial statement, preliminary report, hearing, docket, recommendations, ADs     | NTSB investigation/docket pages + FAA statements/AD pages                    | Select significant investigations; do not ingest every minor aviation occurrence          |
|    7 | CFTC enforcement                  | Complaints, orders, judgments, settlements, market alerts                                                | Release number and named respondents make deterministic joins possible                                   | Drupal archive, enforcement filter                                           | Keep enforcement only at first; exclude speeches/general announcements                    |
|    8 | State incident publishers         | Texas Governor/TDEM/TxDOT; Washington EMD/WSDOT; state fire and health agencies                          | State sources publish activation and local impacts before federal recovery sources                       | State-specific RSS/sitemap/archive                                           | Start with event-bound whitelists, not every governor appointment/award release           |

### Tier B — valuable after identifier-aware joining

| Publisher                  | Why it is useful                                                                                                                    | Why it is not Tier A                                                                                                     |
| -------------------------- | ----------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------ |
| CBP                        | Approximately 560 releases in-window; strong coverage of border operations, ports, trade enforcement, and World Cup travel/security | Local seizures and counterfeit discoveries are usually singletons; require operation, seizure, case, or port-level joins |
| ICE / HSI                  | Approximately 363 releases; can connect investigation, arrest, extradition, charging, and sentencing                                | Many removal and arrest releases are isolated; much content duplicates DOJ case reporting                                |
| DEA / ATF / U.S. Marshals  | Case-oriented, geographically distributed enforcement reporting                                                                     | Technical endpoints need probing and the output will skew toward one-off arrests unless joined by case/operation         |
| NLRB cases and decisions   | Several hundred Board decisions per year and an inherently multi-stage case process                                                 | The newsroom is not the right feed; case/docket ingestion is a distinct adapter project                                  |
| FDIC / CFPB                | Bank failure/receivership and enforcement pages can form long legal and remediation chains                                          | Current general press volume is modest; target enforcement/receivership objects instead of the newsroom                  |
| CENTCOM + service commands | Named military operations generate dense bursts and multiple service perspectives                                                   | Campaign coverage is episodic and mainly international rather than a domestic alert stream                               |
| NORAD / USNORTHCOM         | Recurring ADIZ events, exercises, and defense support of civil authorities                                                          | Lower volume; best used as a corroborating defense/homeland-security source                                              |

## Major event chains in the last year

These events validate the proposed sources against real reporting behavior rather than hypothetical fit.

### 1. Gifford Fire, California — Aug. 1 to Oct. 14, 2025

Why it matters: CAL FIRE records the fire at 131,612 acres, active for 74 days, with five structures destroyed, three civilian injuries, and 15 firefighter injuries. Its incident page has **140 dated status updates**.

Official reporting chain:

1. Incident creation and early acreage/containment — CAL FIRE, Los Padres National Forest, InciWeb.
2. Repeated operational updates, evacuation/closure changes, maps, and damage — CAL FIRE and InciWeb.
3. Transfer of command and late containment — the [Sept. 17 CAL FIRE update](https://www.fire.ca.gov/incidents/2025/8/1/gifford-fire/updates/39e81dca-4e52-40b0-a80d-d7aea147eb24) documents transition to a local Type 3 organization.
4. Final containment and post-fire/BAER work — Forest Service/InciWeb/state sources.

Expected corpus shape: one storyline, many operational episodes, multiple entries per episode where CAL FIRE, InciWeb, Forest Service, county sheriff, and transportation sources describe the same status change.

### 2. Pacific Northwest atmospheric rivers and flooding — Dec. 8–23, 2025

Why it matters: this is an unusually clean multi-agency sequence. Seattle District's [December archive](https://www.nws.usace.army.mil/Media/News-Releases/Year/2025/Month/12/) contains 16 releases.

Episode sequence:

1. Dec. 8 — [USACE activates its emergency and reservoir control centers](https://www.nws.usace.army.mil/Media/News-Releases/Article/4354253/army-corps-of-engineers-assists-with-local-flood-fight-efforts/).
2. Dec. 10 — [24-hour operation of five dams](https://www.nws.usace.army.mil/Media/News-Releases/Article/4356939/usace-battles-historic-flooding-manages-five-dams-to-protect-communities/) as back-to-back atmospheric rivers arrive.
3. Dec. 13–17 — peak-flow regulation, new storm cycles, levee/HESCO breaches, flood-fight materials, and field expertise.
4. Dec. 20–23 — recovery briefing, infrastructure status, safe reservoir drawdowns, and navigation hazards.

Additional official reporters: Washington Emergency Management Division, WSDOT, county governments, Coast Guard, FEMA, NWS, and dam-owning utilities. The Coast Guard's [2025 operational summary](https://www.news.uscg.mil/Press-Releases/Article/4374170/us-coast-guard-highlights-historic-operational-successes-in-2025/) says it flew 17 air missions for the flooding.

Expected corpus shape: forecast/preparation episode → active flood/dam-control episodes → levee-breach episodes → recovery/navigation episodes.

### 3. Winter Storm Fern — Jan. 21 through Feb. 2026

Why it matters: FEMA data shows emergency or major-disaster declarations across a broad multi-state footprint. USACE created a dedicated [January 2026 winter-storm response hub](https://www.usace.army.mil/Missions/Emergency-Operations/Winter-Storm-Jan-2026/) that links deployments and updates through Feb. 17.

Official reporters and distinct roles:

- FEMA: declarations, mission assignments, assistance and recovery.
- USACE: temporary power, school/site assessments, generator installation, debris advice, and demobilization. Its hub says teams supported multiple states and received national, regional, and temporary-power mission assignments.
- Coast Guard: [regional icebreaking and waterway response](https://www.news.uscg.mil/Press-Releases/Article/4394250/multimedia-release-coast-guard-east-district-responds-to-winter-ice-conditions/) and Operation RENEW.
- State emergency agencies and DOTs: local outages, road conditions, shelters, and county impacts.

Expected corpus shape: pre-positioning → declarations → outage/emergency-power episode → ice/navigation episode → restoration and demobilization.

### 4. Super Typhoon Sinlaku, Guam and CNMI — Apr. 2026 onward

Why it matters: the event produced separate port, navigation, relief-logistics, debris, power, field-office, and recovery stories.

Official chain:

- FEMA: Guam/CNMI emergency and major-disaster declarations.
- Coast Guard: port conditions and numbered recovery releases, including [Recovery Update 2](https://www.news.uscg.mil/Press-Releases/Article/4464018/recovery-update-2-us-coast-guard-surges-to-cnmi-as-recovery-push-intensifies-co/) and [Recovery Update 5](https://www.news.uscg.mil/Press-Releases/Article/4470955/recovery-update-5-us-coast-guard-shifts-focus-to-environmental-recovery-followi/).
- USACE: emergency power, debris, roof work, creation of the Sinlaku Recovery Field Office, and later recovery stories.
- Guam and CNMI emergency-management/governor sources: local orders, shelters, public services, and recovery eligibility.

Expected corpus shape: port closure/preparation → impact assessment → staged reopening → emergency power/debris → environmental and long-term recovery.

### 5. Texas severe weather and flooding — July 2026, ongoing at cutoff

Why it matters: this event was already generating a daily multi-source chain when research closed.

Observed official sequence:

1. July 12 — state resources activated ahead of flash-flood danger.
2. July 14 — the [Governor declared a disaster in 59 counties](https://gov.texas.gov/news/post/governor-abbott-issues-disaster-declaration-for-texas-severe-weather-7-14).
3. July 15–16 — statewide response briefings and escalating rescue/asset counts.
4. July 17 — the [Governor requested a presidential major-disaster declaration for 28 counties](https://gov.texas.gov/news/post/governor-abbott-signs-major-disaster-declaration-after-severe-weather-and-flooding); the state reported more than 270 rescues and over 2,700 deployed personnel.
5. July 17 — [USACE reported Canyon Lake was holding floodwater](https://www.swf.usace.army.mil/Media/News-Releases/Article/4548786/us-army-corps-of-engineers-statement-on-canyon-lake/) to reduce downstream risk.

Additional reporters: TDEM, TxDOT/DriveTexas, Texas A&M Forest Service, Texas DPS, National Guard, county/local authorities, NWS, FEMA, and Coast Guard.

Expected corpus shape: forecast/pre-positioning → state declaration → rescue/response → reservoir operations → federal declaration/assistance → recovery.

### 6. UPS Flight 2976 crash, Louisville — Nov. 4, 2025 onward

Why it matters: this is the clearest transportation example of a long, multi-source storyline.

Official chain:

1. Nov. 4–5 — [FAA incident statements](https://www.faa.gov/newsroom/statements/accident_incidents) and [Kentucky emergency-response briefing](https://www.kentucky.gov/Pages/Activity-stream.aspx?n=GovernorBeshear&prId=2624).
2. Nov. 5–7 — NTSB on-scene work and repeated media briefings.
3. Nov. 8 — FAA emergency airworthiness directive grounding affected MD-11/MD-11F aircraft pending inspections.
4. Jan. 14, 2026 — NTSB investigative update; later preliminary report.
5. May 19–20 — two-day NTSB investigative hearing.
6. Public docket — **123 items** under accident number `DCA26MA024` as of June 29.
7. Environmental response — EPA created a [CERCLA site profile](https://cumulis.epa.gov/supercpad/CurSites/csitinfo.cfm?id=0421244) for the crash site.

The [NTSB investigation page](https://www.ntsb.gov/investigations/Pages/DCA26MA024.aspx) is the stable storyline anchor. FAA, Kentucky, EPA, local airport/public safety, and NTSB each cover a different episode or facet.

### 7. U.S. Steel Clairton Coke Works explosion — Aug. 11, 2025 onward

Why it matters: it demonstrates the ideal CSB + OSHA lifecycle.

Official chain:

1. Aug. 12 — [CSB opens an investigation](https://www.csb.gov/csb-opens-investigation-into-fatal-incident-/).
2. Sept. 29 — factual investigation update.
3. Dec. 23 — [two interim safety recommendations](https://www.csb.gov/csb-issues-interim-safety-recommendations-to-us-steel-clairton-coke-works-/?CategoryId=60&pg=2).
4. Feb. 18, 2026 — [OSHA cites two employers](https://www.osha.gov/news/newsreleases/philadelphia/20260218), proposing penalties after its own investigation.
5. Future expected stages — employer contest/settlement, recommendation-status changes, and final CSB report.

The [CSB investigation page](https://www.csb.gov/united-states-steel-corporation-clairton-plant-coke-oven-explosion-/) exposes investigation status, related news/documents, recommendation IDs, and open/closed state.

### 8. Horizon Biofuels explosion, Nebraska — July 29, 2025 onward

Why it matters: another proven cross-agency industrial chain, not a one-off release.

Official chain:

- Incident and local emergency response.
- Sept. 17 — [CSB factual investigation update](https://www.csb.gov/csb-issues-update-on-its-investigation-of-the-fatal-explosion/) under investigation `2025-NE-I-02`.
- Feb. 10, 2026 — OSHA citation for willful and serious safety violations, followed by OSHA's Feb. 13 safety communication.
- Future stages — contest/settlement and CSB final findings/recommendations.

The [CSB incident page](https://www.csb.gov/horizon-biofuels-explosions/) is the canonical anchor; OSHA, state/local responders, and courts or the Review Commission can add later episodes.

### 9. FIFA World Cup 2026 in the United States — planning through July 19, 2026

Why it matters: this planned event spans 11 U.S. host cities and naturally creates security, aviation, border, transportation, and local-operations episodes.

Official source roles:

- FHWA: the [mobility-planning overview](https://ops.fhwa.dot.gov/pse/spotlight/2026worldcup.htm) covers 104 games across 16 North American venues and host-region coordination.
- FAA: [air-traffic procedures and temporary flight restrictions](https://www.faa.gov/fifaworldcup2026), including stadium/fan-zone no-drone restrictions.
- Coast Guard: [enhanced maritime safety and security](https://www.news.uscg.mil/Press-Releases/Article/4516345/coast-guard-enhances-maritime-safety-and-security-posture-for-world-cup/) around ports, ferry routes, and waterfront fan zones.
- NORAD/USNORTHCOM: [defense and counter-UAS support](https://www.norad.mil/Newsroom/Article/4549519/norad-usnorthcom-provide-quiet-behind-the-scenes-support-to-world-cup/) coordinated with federal, state, and local partners.
- CBP/DHS and host-city agencies: international arrivals, screening, local public safety, transit, and crowd operations.

Expected corpus shape: planning → pre-event restrictions → city-by-city match operations → violations/security incidents → final and demobilization/after-action reporting.

### 10. Operation Epic Fury — Feb. 28, 2026 onward

Classification note: this is a U.S.-led international military storyline, not a domestic incident. It belongs in the expansion because the user specifically wants war coverage and because it generates sustained official U.S. reporting.

Official chain:

- Feb. 28 — [CENTCOM launches the named operation](https://www.centcom.mil/MEDIA/PUBLIC-RELEASES/Article/4418396/us-forces-launch-operation-epic-fury/).
- Mar.–Jul. — operational updates, target/force updates, commander briefings, service-specific releases, imagery, and fact sheets.
- Apr. 6 — CENTCOM's [fact sheet](https://www.centcom.mil/Portals/6/Documents/Publications/260406-FactSheet.pdf) reported more than 13,000 targets struck at that point.
- Additional official reporters: Department of War, military services, State Department, White House, and congressional committees/members.

Expected corpus shape: launch → repeated operational phases → force-protection/incidents → diplomatic and congressional episodes → campaign assessment.

## Backfill design recommendation

### First source pack

Use a bounded eight-pack rather than a broad “all news” crawl:

1. **Wildfire operations:** InciWeb incident content and CAL FIRE incidents/updates.
2. **Nuclear events:** NRC Daily Event Report plus event notifications and follow-up releases.
3. **Maritime response:** Coast Guard operational releases only.
4. **Disaster engineering:** selected USACE district archives and dedicated response hubs.
5. **Industrial safety:** all CSB active investigations plus OSHA releases that name a serious/fatal incident or inspection.
6. **Transportation safety:** significant NTSB investigations/dockets plus FAA incident statements and airworthiness actions.
7. **Legal/regulatory:** CFTC enforcement releases and a probe of NLRB decisions/case objects.
8. **Defense operations:** CENTCOM public releases by named operation and NORAD/USNORTHCOM operational releases.

Suggested allocation by expected entries:

| Vertical                                     | Share |
| -------------------------------------------- | ----: |
| Wildfire and disaster operations             |   35% |
| Maritime operational response                |   15% |
| Industrial and transportation investigations |   20% |
| Legal/regulatory cases                       |   20% |
| Defense/national security                    |   10% |

### Admission rules that increase cluster yield

Admit an item when at least one is true:

- It has a stable official incident, event, accident, inspection, release, docket, or case identifier.
- Its title contains a clear progression marker such as `update`, `preliminary`, `reopens`, `suspends`, `concludes`, `recovery`, `citation`, `settlement`, `judgment`, `recommendation`, or `final report`.
- It belongs to a named operation, wildfire, storm, disaster number, vessel casualty, or declared emergency.
- It matches an already-admitted event by identifier or by a strong name + place + time signature.

Reject or heavily downweight:

- change-of-command, commissioning, award, anniversary, recruiting, hiring, and routine exercise publicity;
- isolated local seizures, arrests, removals, and sentencings without a case/operation join;
- routine recreation closures, contract awards, and public meetings unrelated to an active incident;
- translated duplicates and same-agency syndication;
- content whose only relationship is a broad topic such as “wildfire,” “border,” or “safety.”

### Event keys to preserve at ingestion

| Source           | Key                                                                  |
| ---------------- | -------------------------------------------------------------------- |
| FEMA             | `disasterNumber`                                                     |
| NRC              | event number                                                         |
| NTSB             | accident/investigation number, e.g. `DCA26MA024`                     |
| CSB              | investigation and recommendation IDs                                 |
| OSHA             | inspection number, release number, employer + worksite               |
| CFTC             | release number, docket/case number, respondent                       |
| NLRB             | case number, e.g. `22-CA-029179`                                     |
| InciWeb/CAL FIRE | incident code/slug, incident name, start date, coordinates           |
| Coast Guard      | named operation, vessel/aircraft, incident location, numbered update |
| USACE            | disaster/mission name, district, project/dam/levee, location         |
| CENTCOM          | named operation and operational date                                 |

## Practical priority order

1. Probe InciWeb, CAL FIRE, NRC, Coast Guard, and the Seattle/Fort Worth USACE district archives.
2. Run a small backfill and compute the percentage of entries sharing an event key with at least one other entry.
3. Add CSB, OSHA, NTSB, FAA, and CFTC once identifier extraction is verified.
4. Add CBP/ICE only behind operation/case filters and publisher quotas.
5. Add NLRB only through the case/decision objects, not its press releases.
6. Promote a source only when its observed multi-entry yield beats the existing corpus baseline; traffic should be a tie-breaker, not the admission criterion.

The core strategic change is to select **publishing systems with state transitions**, not simply agencies with press rooms. That produces a more even publisher distribution and a materially better event graph at the same backfill size.
