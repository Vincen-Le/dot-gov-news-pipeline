# Operator Dashboard Design Proposal

**Date:** 2026-07-17

**Status:** Proposed, pre-implementation

**Scope:** A local-first operations dashboard paired with the pipeline CLI and
query cheatsheet. This document defines the product and visual design; it is
not an implementation plan.

**Interactive artifact:**
[`operator-dashboard-nds-preview.html`](../../design/operator-dashboard-nds-preview.html)

## Product definition

The operator dashboard is a private control room for one person developing and
running the dot-gov news pipeline. It should answer four questions quickly:

1. Is the pipeline healthy?
2. What is queued, due, or currently leased?
3. What happened in this test run or inventory sync?
4. Why did this site, feed, or job fail?

The dashboard is desktop-first and normally runs on localhost. Pipeline work
continues on Cloudflare, GitHub Actions, and Supabase when the dashboard is not
running. The dashboard is an observer, not a scheduler or source of truth.

## Design thesis

**A civic editorial control room:** compact, exact, and visibly live, with the
typographic confidence and structural simplicity of National Design Studio's
work. The interface should feel like a public-service operations ledger rather
than a generic SaaS analytics page.

The page is organized around the pipeline itself, not around disconnected
metric cards. Inventory, discovery, feed validation, polling, and downstream
processing appear as one horizontal system spine. Counts, active work, queue
pressure, and failures sit in context beneath the stage they affect.

### Safe choices

- Familiar top navigation, persistent header, tables, filters, and an inspector
  drawer make the tool immediately legible.
- Semantic status colors use conventional meanings: green for healthy, amber
  for attention, red for failure, blue for informational state.
- Dense tables, explicit timestamps, and monospace numeric data support the
  investigative work expected of an operator console.

### Deliberate risks

- The overview begins with a pipeline spine instead of a row of interchangeable
  KPI cards. This makes the architecture memorable and exposes stalled handoffs,
  at the cost of needing a purpose-built layout.
- The first viewport borrows National Design Studio's asymmetric, numbered
  editorial composition: orientation on the left, current system meaning on the
  right, and a ruled data field below. This adds identity without turning an
  operations tool into a marketing site.
- Dark mode is the default because this is an ambient local monitor. A complete
  light mode remains available for daytime and accessibility preferences.
- The live activity area resembles an editorial wire ledger: terse event verbs,
  strong timestamps, and restrained density. It is more characterful than a
  typical log viewer while remaining operationally precise.

## National Design Studio reference study

The proposal takes direction from the studio's own [site](https://ndstudio.gov/),
[work index](https://ndstudio.gov/work), and
[Dev Index](https://ndstudio.gov/posts), plus shipped services listed in its
portfolio. The transferable patterns are:

- black/white or tightly restrained palettes with color assigned a job;
- typography as the primary visual material;
- generous first-view composition followed by denser functional content;
- asymmetric two-column layouts and Roman-numeral section labels;
- thin rules instead of rounded card mosaics;
- direct language and extremely limited interface chrome;
- service-specific identity rather than one generic government theme.

National Design Studio uses the licensed PP Neue Montreal family on its studio
site. This dashboard uses Instrument Sans as an open, close-in-spirit alternative
rather than copying or redistributing a proprietary font. The adaptation also
follows the studio's stated
[accessibility emphasis](https://ndstudio.gov/posts/accessibility-matters):
structural simplicity, plain language, keyboard navigation, WCAG AA contrast,
and reduced motion.

## Experience modes

The same application supports two modes without a separate switch.

### Monitor mode

The dashboard is left open on a second screen. At a glance it shows overall
health, pipeline stage counts, the active test run, queue pressure, leased work,
and the latest events. Content updates in place without moving the user's focus.

### Investigate mode

Selecting any metric, stage, row, or event filters the current view and opens a
right-side inspector. The inspector shows provenance, the attempt timeline,
related records, raw identifiers, and the exact CLI command that reproduces the
view.

## Information architecture

| View      | Primary question                                | Main contents                                                                                               |
| --------- | ----------------------------------------------- | ----------------------------------------------------------------------------------------------------------- |
| Overview  | Is the whole pipeline healthy?                  | Pipeline spine, active work, current run, queue pressure, component health, live ledger                     |
| Inventory | Did the latest source sync reconcile correctly? | Verification checklist, latest/previous diff, source checksum, R2 artifact, counts, exclusions, run history |
| Discovery | What is due, leased, found, or failing?         | State funnel, due-age distribution, active attempts, result/failure breakdown, site table                   |
| Feeds     | What feeds are discoverable and reusable?       | Canonical feeds, validation state, discovery methods, site coverage, shared-feed reuse                      |
| Test runs | What happened during a canary or manual run?    | Run progress, cohort, stage timings, outcomes, comparison with earlier runs                                 |
| Events    | What are Workers doing right now?               | Structured event ledger, log filters, follow-live control, sampling/staleness warnings                      |
| System    | Can every dependency be reached?                | Shallow/deep health checks, Worker version, cron heartbeat, queue/DLQ, Supabase, R2, credentials status     |

Views for unimplemented stages should say **Not enabled** and explain the
prerequisite. They must not display a misleading zero.

## Overview layout

```text
┌────────────────────────────────────────────────────────────────────────────────────────┐
│ ▰ DOT GOV NEWS / OPERATIONS   Overview Inventory Discovery Feeds Events   Healthy ●   │
├────────────────────────────────────────────────────────────────────────────────────────┤
│ I  LIVE SYSTEM                    25,367 government sites are reconciled.               │
│                                   Discovery is processing 17 active leases.             │
│ Pipeline                                                                        14:32 ET│
│ overview.                       [Run: Live ▼] [Last 30m ▼] [Run health check]            │
├────────────────────────────────────────────────────────────────────────────────────────┤
│ INVENTORY ── DISCOVERY ── FEEDS ── POLLING ── ENTRIES ── RANKING                        │
│   25,367       17 leased     284       Not enabled                                      │
│   verified     24,981 due    valid                                                      │
├────────────────────────────────────────────────────────────────────────────────────────┤
│ II ACTIVE WORK                         │ QUEUE & COMPONENT HEALTH                        │
│ site / stage / age / lease / signal    │ backlog, oldest, retry, DLQ                     │
│ ...                                    │ Worker, Supabase, R2, cron                      │
├────────────────────────────────────────┼───────────────────────────────────────────────┤
│ III TEST RUN                           │ IV LIVE ACTIVITY                                │
│ 18 / 25 processed                      │ 14:31:59 feed accepted nasa.gov                 │
│ success / no feed / failed             │ 14:31:55 fetch started   epa.gov                │
└────────────────────────────────────────┴───────────────────────────────────────────────┘
                                                    ┌────────────────────────────────────┐
                                              row → │ Site inspector                     │
                                                    │ identity, current attempt, timeline│
                                                    │ [Copy CLI query] [Open raw event]  │
                                                    └────────────────────────────────────┘
```

### Header

- Product mark: `DOT GOV NEWS / OPERATIONS`, paired with a small pipeline glyph
  that is structurally related to the product rather than copying the NDS mark.
- Primary navigation sits in the header, matching the studio's shallow,
  low-chrome site structure while preserving fast access to operator views.
- Environment badge: local/dev/staging/production must remain visually distinct.
- Command/search field opens the command palette and accepts hostnames, UUIDs,
  run IDs, and natural command names.
- Overall health is a text label with a status symbol, never color alone.
- `Live` indicates the current event connection. Paused, reconnecting, sampled,
  and stale are separate states.
- Clock defaults to local time; hovering or focusing reveals UTC and the source
  timestamp.

### Pipeline spine

Each stage shows:

- its current state (`healthy`, `attention`, `failed`, `not enabled`);
- one primary count and one contextual count;
- a freshness label;
- a narrow throughput or completion trace when historical data exists.

Selecting a stage navigates to its detailed view with the current run and time
range preserved. The connectors between stages can show handoff backlog: for
example, many usable sites but no discovery throughput.

### Active work

This table is the most trustworthy answer to “what is processing now.” It uses
durable leases plus the latest correlated Worker event.

| Column      | Meaning                                                             |
| ----------- | ------------------------------------------------------------------- |
| Target      | Hostname or feed URL, with the durable ID secondary                 |
| Stage       | Current phase such as fetch, parse, candidate validation, or commit |
| Started     | Relative age with exact timestamp available                         |
| Lease       | Remaining lease time and explicit stale/expired state               |
| Attempt     | Attempt number and worker identifier                                |
| Last signal | Most recent correlated event and its age                            |

The interface must say **Leased, last signal 8s ago**, not simply “Running.” A
lease is durable evidence; a live log event is supporting evidence, not proof
that an edge invocation still exists.

### Queue and component health

Queue metrics show backlog, oldest message age, retry activity, and DLQ count.
Approximate Cloudflare values carry a `~` marker and a tooltip explaining their
nature. Component health lists Worker, cron, main queue, DLQ, Supabase, and R2
with the last successful observation and latency.

### Activity ledger

The ledger is a normalized stream of lifecycle events, not raw console text.

```text
14:31:59.381  ACCEPTED    feed       nasa.gov       RSS · 42 ms
14:31:55.104  FETCHING    site       epa.gov        attempt 2
14:31:51.992  NO FEED     site       archives.gov   next in 30d
14:31:48.017  RETRYING    discovery  usda.gov       timeout · 60s backoff
```

Event rows expose severity, stage, entity, concise outcome, duration, attempt,
and correlation ID. Long payloads and stack traces belong in the inspector.
Following pauses automatically when the user scrolls away from the newest row;
the UI shows a “12 new events” button instead of stealing scroll position.

## Detailed views

### Inventory

The first section is a verification receipt for the latest run:

- run status and duration;
- source timestamp, ETag, checksum, and R2 object verification;
- source, staged, inserted, updated, reactivated, deactivated, eligible, and
  excluded counts;
- reconciliation invariants with pass/fail states;
- comparison with the previous successful run.

Below it, compact charts show change by agency and exclusion reason. The site
table supports agency, branch, active, usable, filtered, and discovery-state
filters. A “Copy verification command” action emits the matching CLI recipe.

### Discovery

The top of the page is a state funnel:

```text
25,367 eligible → 24,981 due → 17 leased → 312 checked → 284 feed found
                                           ├─ 21 no feed
                                           └─  7 backoff/failure
```

Supporting views show oldest-due age, attempts over time, discovery method,
candidate rejection reason, HTTP outcome, and failure code. Active attempts sit
above historical results. The site table opens the same shared inspector used
from Overview.

### Feeds

This page appears only after canonical feed storage exists. It separates feed
discoverability from feed health:

- site coverage and canonical feed count;
- feed type and discovery method;
- candidate accepted/rejected counts;
- canonical URLs reused by multiple sites;
- validation and, later, polling state.

### Test runs

A test run is a first-class lens across every page. The run header contains its
cohort definition, requested limit, configuration/version, start/end time, and
outcome. The main comparison table shows the current run beside a selected
previous run. “Live” is simply the unbounded current lens.

### System and health checks

`Run health check` performs a shallow, read-only check. `Run deep check` is
visually secondary and verifies the complete read path, including the latest R2
artifact and database invariants. Results show each check independently so a
partial outage is not flattened into one red status.

Potentially mutating actions such as retry, release lease, queue pause, or
canary dispatch do not belong in the initial dashboard. When added later, they
must be visually separated, require confirmation, and emit an audit event.

## Shared inspector

The right-side inspector provides one consistent investigative surface for a
site, feed, run, attempt, event, or queue.

For a site it includes:

1. normalized and source identity;
2. inventory eligibility and latest sync provenance;
3. discovery state and next due time;
4. current/latest attempt with lease and Worker correlation;
5. chronological timeline of fetch, redirect, candidate, validation, and commit;
6. bounded error detail;
7. related feeds;
8. identifiers with copy buttons;
9. `Copy CLI query` and `Open in Events` actions.

The inspector URL is deep-linkable so a dashboard state can be shared or
restored after restart without exposing credentials.

## CLI and cheatsheet parity

The dashboard, CLI help, and Markdown cheatsheet should be generated from the
same command/query catalog.

- Every table and chart filter can produce an equivalent CLI command.
- The command palette groups recipes by user question: “Is it healthy?”, “What
  is running?”, “Why is this stuck?”, and “What changed?”
- Query state is serializable: environment, run, time range, status, agency,
  hostname, and correlation ID.
- `Copy CLI query` produces a safe read-only command by default.
- `pnpm ops examples` presents the same recipes as the in-dashboard palette and
  `docs/operations/cli-cheatsheet.md`.

Example parity:

```text
Dashboard: Discovery → status Backoff → agency EPA → last 2h
CLI:       pnpm ops discovery list --status backoff --agency EPA --since 2h
```

## Visual system

### Aesthetic

National Design Studio-inspired civic editorial minimalism adapted to an
operations workspace. Decoration is minimal: typography, asymmetric grid,
numbered sections, fine rules, and restrained status color carry the interface.
The first view has generous compositional space; operational sections become
compact immediately below it. No gradients, glass effects, rounded card mosaics,
or decorative illustrations.

### Typography

- **UI and headings:** Instrument Sans at primarily regular and medium weights.
  It approximates the neutral grotesk tone of PP Neue Montreal without requiring
  a proprietary font license.
- **Data, IDs, timestamps, and commands:** IBM Plex Mono with tabular numerals.
- **Scale:** 12px metadata, 13px table/body compact, 15px navigation/body,
  16px section title, 32px operational heading, and 48px first-view title.
- Headings favor regular weight and scale over heavy boldness. Uppercase is
  reserved for compact section indices and machine state.

### Color

Dark mode is the default; light mode preserves the same semantic hierarchy.

| Token     | Dark      | Light     | Use                           |
| --------- | --------- | --------- | ----------------------------- |
| Canvas    | `#000000` | `#F2F0E9` | Application background        |
| Surface   | `#080808` | `#FBFAF6` | Primary workspace             |
| Raised    | `#141414` | `#FFFFFF` | Inspector and selected state  |
| Rule      | `#343434` | `#CFCBC0` | Borders and grid lines        |
| Text      | `#F4F3EE` | `#111111` | Primary content               |
| Muted     | `#9B9B94` | `#5F5D57` | Secondary content             |
| Live      | `#8DB4FF` | `#174EA6` | Connected and active work     |
| Healthy   | `#71D68A` | `#147A35` | Successful checks             |
| Attention | `#F1BC63` | `#8B5700` | Due, backoff, stale           |
| Failure   | `#F17878` | `#B4232C` | Failed checks and errors      |
| Info      | `#8DB4FF` | `#174EA6` | Links and informational state |

The palette is overwhelmingly monochrome. Blue, green, amber, and red appear
only when they communicate interaction or state; they are not decorative
branding.

### Spacing and shape

- 4px base unit with compact density.
- Common gaps: 8, 12, 16, 24, 40, and 64px.
- First-view composition uses 40px desktop gutters and 48–72px vertical space;
  data rows return to 10–16px spacing.
- Panels share a flat canvas and are separated by hairline rules. Radius is 0px
  for sections and tables, 2px for controls, and full only for tiny status pills.
- Shadows are reserved for overlays and the inspector.
- Desktop content width is fluid because tables benefit from available space.

### Motion

- 100–180ms transitions for hover, selection, inspector, and filters.
- New live events fade and translate by no more than 4px.
- Only genuinely active work may pulse, and only its small status marker.
- Charts update without replaying entrance animation.
- `prefers-reduced-motion` disables nonessential movement.

## Interaction details

### Keyboard

- `/` focuses search/command palette.
- `g` then a view mnemonic navigates (`g o`, `g i`, `g d`, `g e`).
- `j`/`k` moves through ledger or table rows.
- `Enter` opens the inspector; `Esc` closes it.
- `f` toggles follow-live when the event ledger has focus.
- `c` copies the CLI query for the current view.

All shortcuts have menu equivalents and are disabled while typing in a field.

### Time and freshness

- Relative time is useful for monitoring; exact time is mandatory for audit.
- The visible timezone is shown in the header.
- Every provider panel carries `updated N seconds ago`.
- Staleness thresholds are source-specific rather than one global timeout.

### Loading and partial failure

Panels load independently. If Cloudflare metrics fail but Supabase remains
available, leased work and inventory state still render with a scoped warning.
The application distinguishes:

- pipeline unhealthy;
- dashboard disconnected;
- live tail sampled;
- source data stale;
- stage not enabled;
- query returned no results.

These conditions must never collapse into the same empty state.

## Accessibility

- WCAG AA contrast for text and functional controls in both themes.
- Status always uses text/symbol plus color.
- Dense mode retains a minimum 32px interactive row height; comfortable mode is
  available.
- Tables have semantic headers, keyboard navigation, and stable focus during
  live updates.
- Live announcements are summarized and rate-limited; a busy event stream is
  not exposed as a continuously speaking ARIA live region.
- Charts provide textual summaries and accessible data tables.
- No forced auto-scroll after the user leaves the live edge.

## Responsive behavior

- **1280px and wider:** persistent navigation, main canvas, optional inspector.
- **900–1279px:** compact navigation; inspector overlays rather than shrinking
  tables.
- **Below 900px:** panels stack and tables switch to prioritized columns with
  row detail. This size is supported for quick checks, not the primary monitoring
  experience.
- **Wallboard mode:** hides navigation and inspector, enlarges the pipeline spine,
  active-run progress, health, and failure feed for passive observation.

## Data honesty rules

1. Supabase scheduling and lease state is authoritative.
2. Cloudflare queue metrics may be approximate and must be labeled accordingly.
3. Live logs can be sampled or disconnected; they enrich but do not replace
   durable state.
4. “Running” is shown only when supported by an active lease and a fresh signal;
   otherwise use “Leased,” “Stale,” or “Lease expired.”
5. Missing telemetry is unknown, not healthy and not zero.
6. Every aggregate can be traced to records or a documented provider metric.

## Initial dashboard scope

The first complete release should include:

- Overview, Inventory, Discovery, Events, and System views;
- shallow and deep health checks;
- run/time/environment lens;
- active leases and structured event ledger;
- queue/DLQ metrics;
- shared inspector and deep links;
- dark/light themes and wallboard mode;
- CLI-query copy actions and command palette;
- all loading, stale, disconnected, partial-failure, empty, and not-enabled states.

Feeds and Test Run comparison can appear as designed shells until their durable
tables and run identity exist, but they must use the explicit `Not enabled`
state.

## Non-goals

- Public hosting or multi-user accounts.
- Editing inventory data in the browser.
- A general-purpose Cloudflare log explorer.
- Replacing the Cloudflare or Supabase provider dashboards.
- Mutating queue or lease controls in the first release.
- Mobile-first operation.

## Acceptance criteria for the design

- A user can identify overall health, active work, and the oldest backlog in
  under five seconds.
- A user can move from an aggregate failure count to one site's attempt timeline
  in two interactions or fewer.
- Every investigative view can produce an equivalent read-only CLI command.
- The dashboard remains useful when any one telemetry source is unavailable.
- Unimplemented stages and unavailable metrics are never represented as zero.
- A live update never steals scroll or keyboard focus.
- The interface remains legible in dark, light, compact, and reduced-motion
  settings.

## Decision log

| Date       | Decision                                                              | Rationale                                                                                                                                                      |
| ---------- | --------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 2026-07-17 | Use a pipeline spine as the overview's primary composition            | The operator reasons about handoffs and backlog across stages, not isolated KPIs                                                                               |
| 2026-07-17 | Default to dark, compact, desktop-first presentation                  | The dashboard is an ambient local monitor and investigative tool                                                                                               |
| 2026-07-17 | Join leases with live events for active-work presentation             | Durable state and transient telemetry answer different parts of “currently processing”                                                                         |
| 2026-07-17 | Keep initial controls read-only                                       | Monitoring should not accidentally change pipeline state                                                                                                       |
| 2026-07-17 | Generate dashboard recipes, CLI help, and cheatsheet from one catalog | Prevent documentation and query behavior from drifting                                                                                                         |
| 2026-07-17 | Adopt an NDS-inspired civic editorial shell                           | Numbered sections, asymmetric composition, monochrome surfaces, and thin rules create a recognizable public-service identity without compromising data density |
