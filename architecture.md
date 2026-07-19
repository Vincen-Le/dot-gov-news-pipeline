# Dot-Gov News Pipeline Architecture

**Architecture snapshot:** 2026-07-18
**Repository:** `dot-gov-news-pipeline`
**Status:** Infrastructure and GSA inventory reconciliation hosted-verified; bounded news-source discovery implemented locally and provisioned disabled; the generalized news-source database model is implemented; a manifest-driven news-corpus backfill (`apps/news-backfill`) and an offline Python clustering pipeline (`pipeline/`: entries → episodes → storylines → cards → topic themes) are implemented with an operator-console clustering lab; recurring hosted source fetching and the public API/UI remain planned work
**Primary design context:** Codex tasks `019f7117-db3b-7eb2-bf27-dda5fae1cf23` and `019f7129-622b-7bf3-93f1-f5de84d2e559`

This document is the architectural handoff for a new implementation session. It combines the proposed end-state design with the infrastructure that exists in this working tree. Where an older plan conflicts with code, migrations, or the hosted verification record, the repository and hosted evidence in `docs/infrastructure/runbook.md` are authoritative.

## Executive summary

The pipeline is designed as a sequence of independently schedulable stages:

1. Reconcile the weekly GSA Federal Website Index into a durable government-site inventory.
2. Visit eligible sites on a slower cadence to discover and validate syndication, publisher API, HTML archive, and sitemap endpoints.
3. Maintain a canonical news-source registry and fetch due sources adaptively.
4. Normalize and deduplicate new news items.
5. Cluster related entries into real-world stories, rank the clusters, and serve a materialized result to a central interface.

External news sources are not persistent streams. The default ingestion
mechanism is timer-based fetching with conditional requests where the adapter
supports them. WebSub or publisher-specific webhooks can reduce latency when a
publisher offers them, but scheduled fetching remains the universal fallback.

Supabase Postgres is the durable system of record and authoritative scheduler state. Cloudflare Cron and Queues wake bounded work; they are not the permanent backlog. R2 stores raw snapshots and large artifacts. The current Cloudflare Worker and event contract prove the asynchronous path end to end. GitHub Actions is the implemented batch runtime for the GSA inventory import because the source CSV is too CPU-heavy for the Cloudflare Workers Free budget.

TypeScript is the default implementation language for inventory, discovery, backfill, and polling because these are I/O-bound workloads and the active runtime is Cloudflare Workers. SQL owns atomic reconciliation and leasing. Python now hosts the implemented clustering/ranking pipeline (`pipeline/`): embeddings, enrichment, episode/storyline clustering, event cards, and topic themes run offline against the same Postgres state through language-neutral contracts.

## Status at a glance

| Area                                     | Status                       | Evidence / next step                                                                            |
| ---------------------------------------- | ---------------------------- | ----------------------------------------------------------------------------------------------- |
| TypeScript monorepo and pinned toolchain | Implemented                  | pnpm workspace, Node 24 via `mise`, strict TypeScript, ESLint, Prettier, Vitest                 |
| Cloudflare Worker                        | Implemented and deployed     | HTTP, scheduled, and queue handlers under `apps/pipeline-worker/`                               |
| Cloudflare Queue and DLQ                 | Provisioned and smoke-tested | Main queue retry and poison-message DLQ behavior recorded in the runbook                        |
| Cloudflare R2                            | Provisioned and smoke-tested | Deterministic heartbeat artifact was retrieved remotely                                         |
| Supabase                                 | Provisioned and migrated     | Event and GSA inventory schemas are hosted with service-role-only access                        |
| End-to-end heartbeat                     | Implemented and verified     | `Cron -> Queue -> Worker -> R2 + Supabase`, including replay idempotency                        |
| CI                                       | Implemented                  | App verification plus migration reset and database assertions                                   |
| Chroma                                   | Local-only bootstrap         | Docker Compose with persistent named volume; not part of hosted ingestion                       |
| GSA inventory sync                       | Implemented and hosted       | 29,569 rows reconciled; 25,367 usable sites; checksum replay verified unchanged                 |
| Site news-source discovery               | Implemented, disabled        | Lease RPCs, dedicated Queue/DLQ, bounded Worker, provenance, and canary tooling                 |
| Operator observability                   | Implemented                  | Read-only Worker API, CLI, local dashboard, and sampled lifecycle log tail                      |
| News corpus backfill                     | Implemented                  | `apps/news-backfill`: manifest-driven fetch, R2 raw-artifact archival, `ingest_news_entries_v2` |
| Entry normalization/deduplication        | Implemented                  | `news_entries` schema, extraction/normalization in backfill + `pipeline/normalize.py`           |
| Clustering, ranking, cards, topics       | Implemented (offline)        | `pipeline/` stages: episodes → storylines → event/overview cards → topic themes                 |
| Clustering lab                           | Implemented                  | Operator-console lab surface (`pnpm ops lab …`) plus `complex_v1_experiment_runs` history       |
| Recurring source fetching                | Architected, not implemented | Add adaptive due-source scheduler and adapter-based TypeScript fetchers                         |
| Public API, UI                           | Future                       | Serve materialized ranked results downstream of collection                                      |

## System context and end-state flow

```mermaid
flowchart LR
    GSA["GSA Federal Website Index\nweekly source"]
    GSCAN["GSA Site Scanning data\noptional enrichment"]
    ACTION["GitHub Actions\ninventory batch"]
    R2[("Cloudflare R2\nraw snapshots and artifacts")]
    DB[("Supabase Postgres\nauthoritative state")]

    DCRON["Cloudflare Cron\ndiscovery tick"]
    DQ["Cloudflare Queue\ncontrol jobs"]
    DISC["TypeScript discovery worker"]

    FSCHED["Due-source scheduler"]
    FQ["Fetch queue"]
    POLL["TypeScript async pollers"]
    WEB["WebSub callback\noptional"]

    NORM["Normalize + per-source deduplicate"]
    ENTRY[("News items")]
    CLUSTER["Cross-source story clustering"]
    RANK["Ranking pipeline"]
    TOP[("Materialized ranked stories")]
    API["JSON API + SSE"]
    UI["Central interface"]

    GSA --> ACTION
    ACTION --> R2
    ACTION --> DB
    GSCAN -.-> DB

    DCRON --> DQ
    DQ --> DISC
    DB -->|"claim due sites"| DISC
    DISC --> DB

    DB -->|"claim due sources"| FSCHED
    FSCHED --> FQ
    FQ --> POLL
    POLL --> R2
    POLL --> DB
    POLL --> NORM
    WEB --> NORM

    NORM --> ENTRY
    ENTRY --> CLUSTER
    CLUSTER --> RANK
    RANK --> TOP
    TOP --> API
    API --> UI
```

The diagram is the end-state flow. Today the `NORM -> ENTRY -> CLUSTER ->
RANK` path is realized without the adaptive fetch loop: `apps/news-backfill`
ingests curated publisher histories directly into `news_entries`, and the
offline Python pipeline produces episodes, storylines, cards, and topic
themes from that corpus.

The pipeline has two scheduling clocks that must remain separate:

```text
Website rediscovery: site_discovery_state.next_discovery_at
Source fetching:     news_source_fetch_state.next_fetch_at
```

The first determines when a website should be searched for generalized news
sources. The second determines when an already-discovered source should be
fetched for new content.

## Architectural decisions

| Decision                                                          | Rationale                                                                                                                                                                                 |
| ----------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Supabase is the durable source of truth.                          | Inventory, leases, due times, idempotency, and provenance require transactional state. Queue retention must not determine whether work exists.                                            |
| Queues carry bounded transient work, not the complete backlog.    | At-least-once delivery, retries, DLQ behavior, and backpressure are useful; tens of thousands of long-lived queued site/source messages are not.                                          |
| Inventory reconciliation runs in a Node/TypeScript GitHub Action. | The GSA CSV is currently roughly 8 MB and 29,000-plus rows. Streaming, hashing, parsing, staging, and validation are batch work that do not credibly fit a 10 ms Workers Free CPU budget. |
| Discovery and Cloudflare-based ingestion use TypeScript.          | The workloads are HTTP/HTML/XML/JSON orchestration, TypeScript is the mature Workers path, and the existing workspace/contracts/tooling are TypeScript.                                   |
| SQL owns reconciliation and leasing.                              | Atomic set-based changes, advisory locks, `FOR UPDATE SKIP LOCKED`, and lease validation belong next to the data.                                                                         |
| Site-to-source is many-to-many.                                   | One site may expose several sources, while redirects or duplicate GSA targets may advertise the same canonical source.                                                                    |
| Delivery is at least once; writes are idempotent.                 | Exactly-once transport is unnecessary. Unique keys, lease tokens, replay-safe RPCs, and deterministic R2 object keys make retries converge.                                               |
| Polling is adaptive and timer-based.                              | External observers cannot reliably see publication events inside government infrastructure. WebSub is opportunistic, not universal.                                                       |
| Collection is separate from ranking.                              | Fetch workers should normalize facts; clustering and “interestingness” are downstream concerns that can evolve independently.                                                             |
| Chroma is currently local development infrastructure only.        | It is not required for ingestion, durability, or the hosted smoke path. A production vector-store choice remains open.                                                                    |

## Current infrastructure foundation

### Repository and runtime

The repository is a pnpm monorepo:

```text
apps/pipeline-worker/       Cloudflare Worker
apps/inventory-sync/        GSA inventory batch importer
apps/news-backfill/         Manifest-driven news-corpus backfill batch
apps/operator-api/          Read-only token-protected operator Worker
apps/operator-console/      Local CLI, dashboard, and clustering lab
packages/contracts/         Provider-neutral runtime-validated event contract
pipeline/                   Python clustering pipeline (sync/prepare/cluster/experiment)
config/news-backfill/       Curated backfill manifests
scripts/                    Discovery backfill and canary operator scripts
supabase/                   Local project config and additive SQL migrations
infra/chroma/               Local Chroma Docker Compose service
docs/infrastructure/        Access, operations, and teardown procedures
```

Node 24 is pinned with `mise`. The root package uses pnpm 11.9.0. The Python 3.12+ `uv` environment hosts the implemented clustering pipeline (`pipeline/`) and its pytest suite (`tests/`).

CI runs on pushes to `main` and pull requests. The application job installs the
locked pnpm dependencies and runs formatting, linting, typechecking, Vitest,
and `wrangler deploy --dry-run`. A separate database job starts local Supabase,
reapplies every migration from scratch, runs the legacy transition harness, and
executes the pgTAP suites.

### Deployed development resources

| Resource                      | Name                                               |
| ----------------------------- | -------------------------------------------------- |
| Supabase project              | `qdqmahimrnwhzdjlcont`                             |
| Cloudflare Worker             | `dot-gov-news-pipeline-dev`                        |
| Cloudflare main queue         | `dot-gov-news-events-dev`                          |
| Cloudflare DLQ                | `dot-gov-news-events-dlq-dev`                      |
| Cloudflare R2 bucket          | `dot-gov-news-artifacts-dev`                       |
| Local Chroma container/volume | `dot-gov-news-chroma` / `dot-gov-news-chroma-data` |

The operational commands, provider identifiers, secret setup, hosted evidence, and teardown sequence live in:

- `docs/infrastructure/access.md`
- `docs/infrastructure/runbook.md`
- `docs/infrastructure/teardown.md`

Do not copy secrets into this document. The Worker receives
`SUPABASE_SECRET_KEY` through Wrangler secrets and uses it only server-side. The
inventory batch uses separate bucket-scoped R2 S3 credentials. Cloudflare OAuth
is stored in the OS keychain for local work.

### Implemented heartbeat path

The current hourly Cron invokes the scheduled handler, which creates a deterministic `infra.heartbeat` event and sends it to the queue:

```text
Cloudflare Cron (0 * * * *)
    -> PIPELINE_EVENTS_QUEUE
    -> queue consumer
        -> R2 health/<event-id>.json
        -> Supabase public.pipeline_events
```

The event envelope is currently:

```ts
type PipelineEvent = {
  id: string; // UUID
  schemaVersion: 1;
  type: string;
  idempotencyKey: string;
  occurredAt: string; // offset-aware datetime
  payload: Record<string, unknown>;
};
```

Zod performs strict runtime validation. Unknown fields, malformed UUIDs, and unsupported schema versions are rejected.

The consumer writes R2 first, then upserts Supabase on `idempotency_key`, and acknowledges only after both writes succeed. Failures use bounded exponential retry. After the configured maximum of three retries, Cloudflare moves the message to the DLQ. Because the R2 key is deterministic and the database key is unique, partial failure and replay converge safely.

The hosted smoke verification completed on 2026-07-17 and proved:

- The public `/health` endpoint sees its Queue, R2, and Supabase bindings.
- A valid queue event reaches both R2 and Supabase.
- Replaying the same event retains one database row and one deterministic R2 key.
- A malformed event retries and reaches the DLQ.

R2 activation, direct artifact retrieval, and the full hosted smoke are verified in the implementation plan and infrastructure runbook.

### Existing database schema

`public.pipeline_events` contains the event ID, schema version, event type,
idempotency key, occurrence time, JSON payload, optional artifact key, and
creation time. It has:

- A unique constraint on `idempotency_key`.
- Indexes on event type/time and creation time.
- Row Level Security enabled.
- No `anon` or `authenticated` privileges.
- `SELECT`, `INSERT`, and `UPDATE` granted to `service_role`.

`pipeline_events` is diagnostic event history. It must not become the authoritative inventory, discovery backlog, or source schedule.

The inventory migration additionally provides `inventory_sync_runs`,
`government_sites`, private per-run staging, `site_discovery_state`, and the
`usable_government_sites` view. Service-only RPCs own run lifecycle, batch
staging, atomic reconciliation, summary reads, keyset pagination, and due-site
leasing. GSA-owned site fields cannot be mutated through generic CRUD; source
reconciliation updates them and missing rows are soft-deactivated.

The generalized source migration provides `news_sources`,
`government_site_news_sources`, and `news_source_fetch_state`. It supports RSS,
Atom, JSON Feed, publisher APIs, HTML archives, and sitemaps, preserves
many-to-many provenance, and exposes service-only generalized completion and
summary RPCs. The prior feed-only relations are absent after the migration.

The entry and clustering migrations (`20260718000400` through
`20260718100400`) add the downstream model: `news_entries` (with fp16 `bytea`
embeddings and `body_text`), `entity_stats`, `storylines`, `episodes`,
`episode_entries`, `event_cards`, `rubric_weights`, `complex_v1_experiment_runs`, the
backfill control tables (`news_backfill_runs`, `news_backfill_targets`,
`news_backfill_run_entries`, candidate/identity audit tables,
`news_entry_origins`), the topic-clustering tables (`topic_categories`,
`topic_themes`, seeded with a 23-category taxonomy), and
`news_source_publishers`. Service-only RPCs cover entry ingestion
(`ingest_news_entries_v2`), episode/storyline lifecycle
(`create_episode_with_storyline`, `attach_entry_to_episode`, `close_episode`),
cards and ranking (`insert_event_card`, `compute_rank_key`), backfill run
lifecycle, and topic-theme management.

## Phase 1: GSA inventory reconciliation

### Source semantics

The [GSA Federal Website Index](https://github.com/GSA/federal-website-index) is an inventory of federal website targets, not a source catalog. GSA says it is updated weekly on Wednesday at 6 p.m. Eastern. The source contains sites such as `agency.gov` and `news.agency.gov`; a separate discovery stage is required to find syndication, publisher API, HTML archive, and sitemap endpoints.

GSA Site Scanning data can later enrich final URLs, redirects, CMS hints, robots, and sitemap metadata. It is an optional input and is not part of the first implementation plan.

### Runtime and schedule

The implemented scheduler is one GitHub Actions workflow:

```text
.github/workflows/gsa-inventory-sync.yml
schedule: Thursday 04:17 UTC
manual: workflow_dispatch
local: pnpm inventory:sync
```

The off-minute schedule reduces exposure to GitHub Actions' top-of-hour congestion. Scheduled Actions can be delayed or dropped, so an operator query must flag a last successful import older than eight days and `workflow_dispatch` is the recovery path.

The workflow is present on the default branch. Its `development` environment
must expose the exact variables and secrets listed in the runbook.

Do not configure this same import in Cloudflare Cron or Supabase Cron. One workflow gets one scheduler.

### Reconciliation flow

```mermaid
flowchart LR
    SRC["GSA CSV"]
    JOB["Node inventory-sync app"]
    RAW[("R2 content-addressed snapshot")]
    RUN[("inventory_sync_runs")]
    STAGE[("private.gsa_inventory_stage")]
    VALIDATE["Validate complete snapshot"]
    RECON["Atomic SQL reconciliation"]
    SITES[("government_sites")]
    STATE[("site_discovery_state")]

    SRC --> JOB
    JOB --> RUN
    JOB --> RAW
    JOB --> STAGE
    STAGE --> VALIDATE
    VALIDATE --> RECON
    RECON --> SITES
    RECON --> STATE
```

The implemented run:

1. Create an `inventory_sync_runs` record.
2. Fetch the source over HTTPS with timeouts, a maximum response size, and `If-None-Match` when an earlier `ETag` exists.
3. Stream the response to a temporary file while enforcing the 20 MiB limit and calculating SHA-256.
4. Treat HTTP `304` or an already-successful checksum as a successful no-op before staging.
5. Archive each new source once in R2 under `inventory/gsa/<sha256>.csv`.
6. Analyze and parse the CSV with strict headers, booleans, hostname normalization, and bounded records.
7. Stage rows in 500-row batches keyed by `(sync_run_id, source_row_number)`.
8. Validate the entire snapshot before touching the current inventory.
9. Atomically upsert present sites, reactivate returning sites, and soft-deactivate missing sites.
10. Make new, reactivated, newly eligible, or reachability-changed sites due for discovery.
11. Persist counts and mark the run successful in the same finalization transaction.

### Safety invariants

Finalization fails without modifying current inventory when any of these is true:

- Required columns are missing.
- Normalized source keys are duplicated.
- The download or parse is incomplete.
- The staged row count differs from the recorded parsed count.
- The snapshot falls below an absolute minimum.
- The snapshot is less than 80% of the previous successful row count without an explicit human-reviewed override.
- Another GSA reconciliation holds the database advisory lock.

Missing sites are soft-deactivated, never deleted. This preserves source, article, and provenance history if a site disappears temporarily or later returns.

All GSA records are retained for audit, but only these are discovery-eligible:

```sql
inventory_active = true
and gsa_filtered = false
and inventory_usable = true
```

`inventory_usable` is an ingestion-owned safety classification. It keeps
malformed unfiltered source values in the audit inventory while preventing
them from entering discovery; `gsa_filtered` continues to preserve GSA's own
classification unchanged.

Changes to agency/bureau labels or other non-reachability metadata should not force rediscovery. Store a full source-row hash for audit and a separate discovery-input hash for fields that change reachability or eligibility.

Inventory API access is service-only. Controlled RPCs create and close sync
runs, stage batches, finalize reconciliation, return aggregate health, and
keyset-page sites. Source-derived site rows have no generic update or hard
delete path; reconciliation owns their lifecycle.

### Implemented verification

The hosted development project contains one fully reconciled GSA snapshot:

| Result                        |  Value |
| ----------------------------- | -----: |
| Source rows                   | 29,569 |
| Usable discovery targets      | 25,367 |
| GSA-filtered rows retained    |  4,195 |
| Ingestion-excluded rows       |      7 |
| Pending site-discovery states | 25,367 |
| Duplicate usable hostnames    |      0 |

The snapshot was retrieved back from R2 and matched its recorded SHA-256. A
second run with the same checksum completed as `unchanged` without restaging or
mutating the inventory. The runbook contains run IDs, checksum, queries, and
recovery commands.

## Phase 2: Site-level news-source discovery

### Scheduling model

`site_discovery_state` is a one-to-zero-or-one operational child of
`government_sites`. The inventory and discovery migrations create and update
these rows and implement lease-safe `claim_due_site_discoveries` and
`recover_expired_site_discovery_leases` RPCs. A claim selects at most one site
per base domain. A transaction-scoped advisory lock serializes concurrent claim
calls, and the predicate excludes base domains with an active lease; the
database concurrency suite verifies this behavior.

No Cloudflare handler invokes those RPCs yet. The next Worker phase will add a
lightweight Cron tick that places one small `site.discovery.dispatch.requested`
control event on the queue; its consumer will claim due sites transactionally
from Supabase and perform bounded discovery.

The database is the backlog:

```text
Cron tick -> one small queue message -> claim due database rows -> process -> complete/fail lease
```

Do not enqueue all 25,000-plus sites. If a control message expires or is retried, the due rows remain in Supabase.

Measured canary settings after the 1-site and 25-site gates:

- Claim at most 10 distinct-base-domain sites per tick.
- Queue-consumer batch size one.
- Queue-consumer concurrency 10.
- Stop dispatching at a 20-message Queue high-water mark.
- Add random jitter before contacting the site.
- Prefer the oldest due site while avoiding repeated claims from the same base domain.

At 10 sites per minute, the theoretical full-backlog drain is about 42 hours
before retries. That rate uses about 43,200 Queue operations/day, so it is a
Workers Paid setting; the Free-plan 10,000-operation daily allowance cannot
sustain it for the full backlog. Discovery remains disabled after the canary
until the account tier or lower steady-state rate is explicitly selected.

### Discovery cadence

| Result or change                                    | Next discovery                                     |
| --------------------------------------------------- | -------------------------------------------------- |
| New/reactivated/newly eligible site                 | Immediately                                        |
| URL, redirect, CMS, or discovery input changed      | Immediately                                        |
| Healthy site with at least one news source          | About 90 days                                      |
| Complete generalized scan finds no news source      | 30 days for first retry, then about 90 days        |
| Transient timeout/`5xx`                             | Exponential backoff from one hour up to seven days |
| Associated source becomes persistently invalid/gone | Immediately                                        |
| Filtered, inactive, or manually suppressed          | Disabled until eligibility changes                 |

### Discovery algorithm

For one claimed site:

1. Request `https://<initial_url>/` with bounded, validated redirects.
2. Inspect standard HTML alternate links for RSS, Atom, and JSON Feed.
3. Inspect explicit news, press-release, newsroom, alert, blog, API, archive,
   and sitemap links.
4. Visit only a bounded number of high-confidence same-site pages and repeat
   discovery.
5. Apply a small, versioned set of CMS and publisher-API heuristics.
6. Fetch candidate sources within strict size, timeout, redirect, and
   subrequest budgets.
7. Validate syndication formats, publisher API contracts, bounded HTML
   archives, and sitemaps with adapter-specific rules.
8. Canonicalize accepted URLs, upsert each source, and record website/source
   provenance.
9. Seed `news_source_fetch_state.next_fetch_at = now()` for every newly created
   source.
10. Emit `no_news_source` only after all generalized adapter checks complete;
    otherwise complete or fail the discovery lease atomically.

Initial per-site bounds from the implementation plan:

- Maximum five landing/news HTML pages.
- Maximum ten source candidates.
- Maximum five redirects per request.
- Maximum two MiB after decompression per bounded response.
- Target at most 40 external subrequests for the invocation, leaving headroom below the current Workers Free limit of 50.

### Discovery security

The Worker fetches destinations influenced by external data, so it must treat every redirect and candidate as untrusted:

- Allow only HTTP and HTTPS; prefer HTTPS.
- Reject URL credentials and unexpected ports.
- Reject IP literals, loopback, private, link-local, and cloud metadata destinations.
- Revalidate redirect targets and resolved destinations.
- Limit redirects, response sizes, decompressed sizes, and total time.
- Disable XML DTDs and external entities.
- Sanitize source-supplied HTML before any future UI rendering.
- Use a descriptive User-Agent with a project contact address.
- Enforce global, base-domain, hostname, and eventually origin/IP concurrency limits.
- Respect `Retry-After` and applicable publisher crawl guidance.

Thousands of GSA subdomains may share one agency infrastructure. Per-host limits alone are insufficient; base-domain throttling is a core requirement.

## Phase 3: Canonical news-source fetching

### Scheduling and worker model

One canonical source has one `news_source_fetch_state` row. A scheduler claims
due sources where:

```sql
status = 'active'
and next_fetch_at <= now()
and (lease_until is null or lease_until < now())
```

Claims use short leases and `FOR UPDATE SKIP LOCKED`. Claimed sources become
transient fetch jobs on a shared queue. Stateless TypeScript workers claim
whichever job is available; sources are not permanently assigned to workers or
fixed shards.

Dynamic ownership avoids hot or slow source groups, makes worker loss
recoverable, and allows horizontal scaling without resharding. If sharding is
eventually necessary, base it on hostname/base domain to support publisher
rate limits rather than arbitrary source IDs.

The full-scale scheduler/fetcher deployment target is not finalized. The
current Cloudflare foundation is the preferred first benchmark target, likely
on Workers Paid, but async TypeScript containers remain a valid fallback if
Workers CPU, connection, or queue economics are a poor fit. The language and
data contracts do not depend on that deployment choice.

### Fetch behavior

Each source adapter should:

1. Validate the claimed lease/job.
2. Enforce global and publisher-specific concurrency.
3. Send conditional headers from stored state:

   ```http
   If-None-Match: "previous-etag"
   If-Modified-Since: Fri, 17 Jul 2026 12:00:00 GMT
   ```

4. Treat `304 Not Modified` as a successful unchanged fetch.
5. Parse changed content with adapter-specific XML, JSON, HTML, or sitemap
   protections.
6. Identify unseen news items and insert them idempotently.
7. Optionally retain raw changed payloads in R2 for audit/debugging; do not store every unchanged response.
8. Update `ETag`, `Last-Modified`, success/error history, interval, and `next_fetch_at`.
9. Acknowledge only after durable state is updated.

### Adaptive cadence

| Observation                        | Policy                                         |
| ---------------------------------- | ---------------------------------------------- |
| New entries found                  | Temporarily shorten to roughly 2–5 minutes     |
| Normally active source             | Adapter-specific baseline                      |
| Repeated `304` or unchanged `200`  | Gradually lengthen the interval                |
| Historically quiet source          | Roughly 30 minutes to 24 hours                 |
| Timeout or `5xx`                   | Exponential backoff with jitter                |
| `429` or `503` with `Retry-After`  | Honor `Retry-After`                            |
| Permanently missing/invalid source | Mark gone/invalid and trigger site rediscovery |
| WebSub available                   | Use callbacks plus a 6–24-hour safety poll     |

Every interval receives jitter to avoid synchronized bursts. RSS `<ttl>`, `skipHours`, and `skipDays` are hints, not commands.

At 27,000 sources, average request rates require asynchronous I/O and adapter-
specific cadence and exceed the current free-tier quotas at short intervals:

| Average interval | Average fetch rate |
| ---------------- | -----------------: |
| 5 minutes        | 90 requests/second |
| 10 minutes       | 45 requests/second |
| 15 minutes       | 30 requests/second |

At 90 requests/second and two-second mean latency, average network concurrency is about 180. A later load test should establish safe fleet concurrency, publisher limits, and queue age targets.

### Push optimization

We cannot observe publications inside government CMSs or server logs. Push is possible only when a publisher deliberately exposes it:

- WebSub hub and self links.
- Publisher-specific webhooks/APIs.
- A direct CMS/deployment integration.

WebSub subscriptions still require lease renewal and periodic safety polling. Therefore, push augments the polling architecture rather than replacing it.

## Phase 4: Entries, clustering, ranking, and serving

### Implemented state

The entries → clustering → cards → topics path is implemented and runs
offline against local Postgres, seeded by the backfill rather than recurring
fetching:

- `apps/news-backfill` fetches curated publisher histories from
  `config/news-backfill/*.json` manifests, archives every raw response
  content-addressed in R2 (`news-backfill/objects/<sha256>`), records each
  run's reference in `news_backfill_run_entries.raw_artifact_key`, extracts and
  normalizes entries, and ingests them idempotently through
  `ingest_news_entries_v2`. `upload-artifacts` migrates legacy local artifacts
  to R2; `probe.ts` holds the alternate-source probe tooling.
- `pipeline/` (Python) implements the processing stages behind
  `uv run python -m pipeline.cli`: `sync` copies the hosted corpus into the
  local bench database id-preserved; `prepare` runs extraction, enrichment,
  and fp16 embeddings (stored in `news_entries.embedding`, not Chroma);
  `cluster` runs stage 1 episodes (`episodes.py`), stage 2 storylines
  (`storylines.py`), stage 3 event and overview cards with rubric rank keys
  (`cards.py`, `compute_rank_key`), and stage 4 topic themes (`topics.py`,
  nearest-centroid assignment with LLM adjudication against the seeded
  taxonomy). In stage 2, event keys and entity overlap only nominate
  candidates; every episode-to-storyline join requires an affirmative judge
  verdict. In stage 4, a spawn decision creates both a reusable, entity-resistant
  theme label and one seeded category assignment in the same model call, while
  the theme adjudicator may merge duplicate candidate themes.
- The model layer (`pipeline/ai.py`, `prompts.py`, `cache.py`, `stub.py`)
  provides the adjudicator/judge/enricher/embedder behind a decision cache
  (`.cache/decisions.sqlite`) and a stub mode for deterministic runs.
- Every episode close writes an immutable episode card and regenerates the
  storyline overview card, including for single-episode storylines, with a
  deterministic fallback when the LLM call fails.
- The operator-console clustering lab (`pnpm ops lab …`, dashboard Lab pages)
  provides corpus inspection, experiment runs recorded in `complex_v1_experiment_runs`,
  storyline QA, quality metrics, and borderline labeling. See
  `docs/operations/clustering-lab.md`.

Recurring hosted fetching, learned ranking, and the public API/UI remain
unimplemented; the design below covers both the implemented offline path and
those future stages.

### Two distinct kinds of deduplication

Per-source idempotency determines whether a news item has already been ingested.
The identity fallback order is:

1. RSS `guid` or Atom entry ID.
2. Canonicalized article URL.
3. Hash of stable fields such as title, publication date, and content.

The database should enforce a uniqueness invariant similar to:

```text
UNIQUE(news_source_id, external_item_id)
```

Cross-source clustering is different. Several agencies or offices may publish different articles about the same real-world event. Those articles should remain as sources in one story cluster rather than being deleted as duplicates.

```text
news items
    -> exact/canonical deduplication
    -> semantic story clustering
    -> one cluster with multiple source records
```

### Ranking

Start with an explainable formula and collect human feedback before training a learned ranker:

```text
score = freshness
      * novelty
      * source_quality
      * corroboration
      * topic_relevance
```

Candidate signals include freshness, publication velocity, novelty, source authority/diversity, topic and geographic relevance, and explicit user feedback. Embeddings should run only for new, already-deduplicated entries, not on every source poll.

The ranking process writes a materialized set of top stories. The API reads that prepared result rather than recomputing global rankings on every request. Use normal JSON endpoints for pages and Server-Sent Events for one-way live updates; introduce WebSockets only if the UI later needs substantial bidirectional realtime behavior.

## Proposed data model

```mermaid
erDiagram
    INVENTORY_SYNC_RUNS ||--o{ GSA_INVENTORY_STAGE : stages
    INVENTORY_SYNC_RUNS ||--o{ GOVERNMENT_SITES : reconciles
    GOVERNMENT_SITES ||--o| SITE_DISCOVERY_STATE : schedules
    GOVERNMENT_SITES ||--o{ GOVERNMENT_SITE_NEWS_SOURCES : exposes
    NEWS_SOURCES ||--o{ GOVERNMENT_SITE_NEWS_SOURCES : discovered_from
    NEWS_SOURCES ||--|| NEWS_SOURCE_FETCH_STATE : schedules
    NEWS_SOURCES ||--o{ NEWS_ENTRIES : publishes
    STORYLINES ||--o{ EPISODES : chains
    EPISODES ||--o{ EPISODE_ENTRIES : groups
    NEWS_ENTRIES ||--o{ EPISODE_ENTRIES : participates_in
    STORYLINES ||--o{ EVENT_CARDS : summarized_by

    INVENTORY_SYNC_RUNS {
        uuid id PK
        text source
        text status
        text source_etag
        text source_sha256
        int source_row_count
        timestamptz started_at
        timestamptz completed_at
    }

    GOVERNMENT_SITES {
        uuid id PK
        text source
        text initial_url
        text base_domain
        boolean gsa_filtered
        boolean inventory_active
        text source_row_hash
        text discovery_input_hash
        timestamptz first_seen_at
        timestamptz last_seen_at
    }

    SITE_DISCOVERY_STATE {
        uuid site_id PK,FK
        text status
        timestamptz next_discovery_at
        uuid lease_token
        timestamptz lease_until
        int failure_count
    }

    NEWS_SOURCES {
        uuid id PK
        text canonical_url UK
        text source_type
        text status
        timestamptz last_validated_at
    }

    GOVERNMENT_SITE_NEWS_SOURCES {
        uuid site_id FK
        uuid news_source_id FK
        text discovery_method
        numeric confidence
        boolean active
        timestamptz first_seen_at
        timestamptz last_seen_at
    }

    NEWS_SOURCE_FETCH_STATE {
        uuid news_source_id PK,FK
        text status
        timestamptz next_fetch_at
        timestamptz lease_until
        text etag
        text last_modified
        int failure_count
    }
```

Key ownership boundaries:

- Inventory reconciliation owns `government_sites` and eligibility-driven updates to `site_discovery_state`.
- Discovery owns `news_sources`, `government_site_news_sources`, and initial `news_source_fetch_state` creation.
- Fetching owns fetch leases, validators, cadence, and source health in `news_source_fetch_state`.
- Item processing owns normalized news items and per-source idempotency.
- Clustering/ranking owns story relationships and materialized ranked output.
- `pipeline_events` is diagnostic history shared across phases, not current-state ownership.

### Inventory and discovery tables

The authoritative migration sequence provides:

- `public.inventory_sync_runs`: every source attempt, checksum, counts, status, and bounded error details.
- `private.gsa_inventory_stage`: persistent bounded staging batches keyed by run and source row.
- `public.government_sites`: stable GSA-derived inventory and soft-deactivation history.
- `public.site_discovery_state`: due time, lease, status, failures, and last result.
- `public.news_sources`: globally unique canonical sources, adapter type,
  bounded configuration, backfill metadata, and validation status.
- `public.government_site_news_sources`: many-to-many discovery provenance.
- `public.news_source_fetch_state`: the explicit handoff to source fetching.

Use `TIMESTAMPTZ`, database-generated UUIDs, check constraints, and narrowly targeted indexes. Public tables must have RLS enabled and no anonymous write path. Staging belongs in a non-exposed `private` schema.

### Inventory and discovery RPCs

The implemented service-only functions include:

- Create/start an inventory sync run.
- Stage an idempotent batch of GSA rows.
- Finalize and atomically reconcile a complete GSA snapshot.
- Claim due site discoveries with `FOR UPDATE SKIP LOCKED` and leases.
- Complete a site discovery and upsert sources/provenance/fetch state atomically.
- Fail a discovery with bounded backoff.
- Recover expired discovery leases as part of normal claim traffic.

Any `SECURITY DEFINER` function must set an empty `search_path`, fully qualify relations, validate bounded arguments, and revoke execution from `PUBLIC`, `anon`, and `authenticated`.

The legacy discovery schema arrived in migrations `...00400` through
`...18000200`. Migration `...18000300` copies its data into the generalized
tables, verifies field-for-field preservation, replaces generalized RPCs, and
drops the legacy relations in the same transaction.

## Event and service contracts

The current `PipelineEvent` envelope is provider-neutral but not yet a discriminated event union. Before discovery work, add typed payload schemas and a dispatcher so the queue consumer routes by event type rather than treating every valid event as a heartbeat artifact.

The discovery control message should remain small:

```json
{
  "id": "uuid",
  "schemaVersion": 1,
  "type": "site.discovery.dispatch.requested",
  "idempotencyKey": "site.discovery.dispatch.requested:2026-07-17T20:01:00Z",
  "occurredAt": "2026-07-17T20:01:00Z",
  "payload": {
    "claimLimit": 1
  }
}
```

It intentionally contains no list of site IDs. The consumer claims authoritative rows from Supabase.

If Python is introduced later, do not create an in-process TypeScript/Python bridge. Use language-neutral boundaries:

```text
TypeScript producer
    -> versioned JSON contract / Supabase state / R2 object key / HTTP
Python processor
```

The current TypeScript side validates with Zod. A cross-language phase should publish JSON Schema and validate the same schema in Python with Pydantic. Large payloads belong in R2; messages carry identifiers and object keys.

## Reliability and failure semantics

### Idempotency

- Event transport is at least once.
- Queue events have stable idempotency keys.
- Database constraints provide the final duplicate guard.
- Inventory stage writes are replay-safe for an identical `(sync_run_id, source_row_number)` and reject conflicting content.
- Inventory finalization returns the stored result if a succeeded run is retried.
- Discovery completion validates a lease token and converges on globally unique canonical source URLs.
- R2 uses deterministic/content-addressed keys.
- News items use stable source-scoped external identities with a unique database constraint.

### Backpressure and recovery

- Queue age and due-row age are separate signals.
- Supabase due state survives queue loss and 24-hour Free-plan retention.
- Expired leases are recovered by ordinary claim traffic.
- Individual site/source failures update their own backoff and should not poison unrelated jobs in the same batch.
- Systemic failures such as Supabase unavailability retry the whole control message.
- Persistent poison messages move to the DLQ for inspection.
- Operators can pause Cron and queue delivery without deleting authoritative backlog state.

### Observability

Track at minimum:

- Last successful inventory sync age, source checksum, source row count, and week-over-week delta.
- Inserted, updated, reactivated, deactivated, active, filtered, and inactive site counts.
- Due, leased, expired, backoff, no-source, and disabled discovery counts.
- Discovery success/no-source/failure rates and oldest-due age.
- News source candidates found, rejected, canonical news sources created, and existing news sources reused.
- Queue depth/age, retries, DLQ count, Worker CPU-limit errors, and subrequest exhaustion.
- Poll success, `304` rate, latency, bytes, parse failures, and new entries per source.
- Publication-to-discovery and discovery-to-ranked-display latency.
- Deduplication and story-clustering ratios.
- Supabase database size and R2 storage/operation usage.

Structured logs should include event/site/source IDs and outcomes without source payloads, credentials, or full malformed CSV rows.

The operator surface has three deliberately separate layers:

1. `pipeline-worker` emits versioned, bounded lifecycle objects and continues to
   own Cron and Queue processing.
2. `operator-api` is a separately deployable, token-protected, read-only Worker.
   It reads bounded Supabase models, Queue metrics, R2 metadata, and the pipeline
   Worker's health endpoint through a Service Binding. It has no mutation route.
3. `operator-console` is a localhost-only Node process containing the CLI,
   browser credential boundary, React dashboard, query recipes, optional
   Wrangler tail adapter, and the clustering lab (corpus inspection,
   experiment runs, storyline QA, theme browsing, and borderline labeling
   against the local bench database). Closing it does not stop hosted
   processing.

Durable Supabase state answers what is due, leased, or complete. Queue metrics
describe transient provider pressure. Sampled real-time logs explain recent
activity but never override durable health or lease labels. Unimplemented stages
return `not_enabled` with a prerequisite rather than a fabricated zero.

## Capacity and provider constraints

As of this architecture snapshot, official provider documentation reports:

- Workers Free: 100,000 requests/day, 10 ms CPU/invocation, 50 external subrequests/invocation, 128 MB memory.
- Queues Free: 10,000 operations/day and 24-hour non-configurable retention. A successful small message normally incurs a write, read, and delete operation.
- Supabase Free: 500 MB database-size quota before read-only behavior.

These values are operating assumptions, not permanent architecture. Recheck provider limits before changing throughput or deployment topology.

At one discovery control message per minute, normal delivery costs about 4,320 queue operations/day before retries, leaving limited but useful free-tier headroom. Full source polling is a different scale: 27,000 news sources every 15 minutes means about 2.59 million fetches/day and roughly three queue operations per fetch. Therefore, the current free Queue and Worker quotas can support the controlled discovery canary, not production polling of the full corpus.

Before enabling full polling, choose and benchmark one of:

1. Cloudflare Workers/Queues Paid with explicit cost and CPU tests.
2. A TypeScript async container fleet with another managed durable queue.
3. A hybrid in which Cloudflare handles control/webhook traffic and containers perform bulk polling.

The scheduler, message contracts, database leases, and idempotent entry model remain the same in all three options.

## Deployment and environment strategy

There is currently one development environment. Do not create staging and production variants until there is a working inventory/discovery canary and a concrete promotion need.

Current deployment is manual:

1. Apply additive Supabase migrations.
2. Set/update the Cloudflare Supabase secret interactively.
3. Dry-run the Worker bundle.
4. Deploy the Worker.
5. Verify `/health`, one valid event, replay idempotency, R2 retrieval, and DLQ behavior.

CI deployment credentials and automated deployment are intentionally deferred. If added, use least-privilege account-scoped tokens and separate migration/deploy permissions.

Backups are also a production gate. The current runbook uses manual Supabase dumps. Automated database and artifact backup/restore testing is required before valuable production data accumulates.

## Next implementation sequence

The infrastructure and inventory phases are complete, and the hosted
discovery rollout (1/25/250-site gates plus the full 25,367-site direct seed)
finished on 2026-07-18 with recurring discovery still disabled. The curated
news-corpus backfill, entry normalization, offline clustering/ranking/cards,
topic themes, and the clustering lab are implemented. The remaining sequence:
select the recurring-discovery steady-state rate and Workers tier; design and
benchmark adaptive source fetching before consuming `news_source_fetch_state`
at scale; then productionize the clustering output behind a materialized
public API/UI.

## Rollout gates

Do not enable unattended schedules until the preceding gate passes:

1. Infrastructure heartbeat passes locally and hosted. **Passed.**
2. Real GSA snapshot stages and reconciles with expected counts; replay is a no-op; malformed/truncated snapshots do not change inventory. **Passed locally and hosted.**
3. Inventory manual run is observable and recoverable. **Passed.** Merge the workflow, correct the remaining GitHub environment scope mismatch, and verify one controlled dispatch before relying on the weekly schedule.
4. Discovery fixtures cover all six adapters, redirects, multiple/shared
   sources, complete generalized no-source scans, malformed sources, oversized
   payloads, SSRF targets, lease expiry, and duplicate delivery.
5. Run a 25-site discovery canary and inspect every result.
6. Run a 250-site canary and evaluate errors, subrequests, domain behavior, database growth, and queue operations.
7. Expand the controlled discovery backlog.
8. Benchmark full source polling separately; upgrade/change infrastructure before free-tier limits are approached.

## Explicit non-goals for the hosted inventory/discovery phase

- Recurring polling of discovered news sources for entries (the curated
  backfill is the implemented, bounded exception).
- Unbounded website or HTML crawling beyond the configured adapters.
- WebSub subscription delivery.
- Hosted embeddings, clustering, or ranking (these run offline in
  `pipeline/` today), learned ranking, or search.
- A public API or central UI (the operator console and lab remain local-only).
- Multi-region or multiple deployment environments.
- Hosted Chroma.

Keeping these out of the first domain phase prevents discovery reliability and inventory correctness from being obscured by downstream product work.

## Open decisions and known risks

1. **Full polling runtime and budget:** Cloudflare Paid versus async TypeScript containers requires a load/cost benchmark.
2. **Production vector store:** local Chroma is scaffolding, not a committed production choice. Supabase `pgvector`, hosted Chroma, or another service can be evaluated with the ranking workload.
3. **GSA Site Scanning enrichment:** useful for final URL/CMS hints, but not required for first inventory/discovery delivery.
4. **Domain-wide rate limiting across concurrent invocations:** addressed for discovery claims by a global advisory lock, active-domain lease exclusion, and a concurrent pgTAP test. Publisher-specific rate limits beyond one active site per base domain remain future work.
5. **News source canonicalization:** preserve path/query semantics. Do not remove trailing slashes or tracking-looking parameters without evidence that two news sources are equivalent.
6. **No-source coverage:** only a completed generalized scan across
   syndication, APIs, HTML archives, and sitemaps may record
   `no_news_source`; bounded legacy negatives must remain queued for
   rediscovery.
7. **Backups and data retention:** define R2 raw-payload retention and automated Supabase backup/restore before production.
8. **Plan drift:** the ignored `.claude/plans/` documents are useful design artifacts but may contain stale status. Code, applied migrations, this architecture snapshot, and the runbook take precedence.

## Handoff map

Use these files rather than reconstructing context from scratch:

- `architecture.md`: target architecture, current state, decisions, and phase boundaries.
- `.claude/plans/gsa-inventory-and-news-source-discovery-implementation-plan.md`: detailed inventory/discovery tasks, tests, and original field-level proposals.
- `.claude/plans/minimal-infrastructure-bootstrap-implementation-plan.md`: original foundation plan; its R2-pending status is stale.
- `README.md`: local setup and bootstrap summary.
- `apps/inventory-sync/`: implemented GSA downloader, parser, R2 snapshot store, and reconciliation orchestration.
- `apps/pipeline-worker/`: the implemented Worker entry points and current heartbeat behavior.
- `apps/news-backfill/`: manifest-driven corpus backfill, R2 artifact store, extraction, and probe tooling.
- `pipeline/`: the Python clustering pipeline (sync/prepare/cluster stages, experiment harness, model layer).
- `config/news-backfill/`: curated backfill manifests.
- `docs/operations/clustering-lab.md`: the lab QA/experiment loop.
- `packages/contracts/`: the current versioned Zod event envelope.
- `supabase/migrations/20260717000300_create_government_site_inventory.sql`: authoritative inventory schema, reconciliation, and discovery-claim RPCs.
- `supabase/migrations/`: the authoritative additive migration sequence.
- `docs/infrastructure/runbook.md`: resource inventory, hosted smoke evidence, operations, and incident procedures.
- `docs/infrastructure/access.md`: interactive authentication and secret handling.
- `docs/infrastructure/teardown.md`: destructive teardown order and safeguards.

Suggested next-session skills, if available: `global:backend-dev` for the TypeScript/SQL implementation, `global:testing` for migration and integration coverage, and `workers-best-practices` or `cloudflare` when changing Worker bindings, queue behavior, or external-fetch safety.

## External references

- [GSA Federal Website Index](https://github.com/GSA/federal-website-index)
- [GSA Site Scanning API](https://open.gsa.gov/api/site-scanning-api/)
- [Cloudflare Workers limits](https://developers.cloudflare.com/workers/platform/limits/)
- [Cloudflare Queues limits](https://developers.cloudflare.com/queues/platform/limits/)
- [Cloudflare Queues pricing and operation accounting](https://developers.cloudflare.com/queues/platform/pricing/)
- [Cloudflare Python Workers](https://developers.cloudflare.com/workers/languages/python/)
- [Supabase database-size behavior](https://supabase.com/docs/guides/platform/database-size)
- [GitHub Actions scheduled-workflow caveats](https://docs.github.com/en/actions/how-tos/troubleshoot-workflows)
- [HTTP conditional request semantics](https://www.rfc-editor.org/rfc/rfc9110.html#name-if-none-match)
- [W3C WebSub recommendation](https://www.w3.org/TR/websub/)
