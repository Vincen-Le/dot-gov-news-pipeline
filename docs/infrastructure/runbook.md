# Infrastructure Runbook

## Resource inventory

| Resource                     | Name                             |
| ---------------------------- | -------------------------------- |
| Supabase project             | `qdqmahimrnwhzdjlcont`           |
| Cloudflare Worker            | `dot-gov-news-pipeline-dev`      |
| Cloudflare Operator API      | `dot-gov-news-operator-api-dev`  |
| Cloudflare Queue             | `dot-gov-news-events-dev`        |
| Cloudflare dead-letter queue | `dot-gov-news-events-dlq-dev`    |
| Discovery Queue              | `dot-gov-site-discovery-dev`     |
| Discovery dead-letter queue  | `dot-gov-site-discovery-dlq-dev` |
| Cloudflare R2 bucket         | `dot-gov-news-artifacts-dev`     |
| Local Chroma container       | `dot-gov-news-chroma`            |

Verified Cloudflare identifiers:

| Resource          | ID                                 |
| ----------------- | ---------------------------------- |
| Account           | `a2d6c849c1770d0e7e4fc042db14de25` |
| Main queue        | `876468b58ff94eccb37059575e2cc831` |
| Dead-letter queue | `8e03befacac24593b0ace47310373467` |
| Discovery Queue   | `8a5a339bee9d467791dd3679233fed9a` |
| Discovery DLQ     | `ab38d22f2cfc45f88fa8c60910f048ae` |

The discovery Queue and DLQ were provisioned on 2026-07-17. The committed
Worker configuration now binds their producer and consumer, and the deployed
Worker carries those bindings. `DISCOVERY_ENABLED` remains `false`, so
deployment alone cannot claim sites.

## Install dependencies

Run all Node commands through the repository's Node 24 toolchain:

```sh
mise install
mise exec -- pnpm install --frozen-lockfile
```

## Verify the repository

```sh
mise exec -- pnpm format:check
mise exec -- pnpm lint
mise exec -- pnpm typecheck
mise exec -- pnpm test
mise exec -- pnpm --filter @dot-gov-news/pipeline-worker check:deploy
mise exec -- pnpm --filter @dot-gov-news/operator-api check:deploy
mise exec -- pnpm --filter @dot-gov-news/operator-console build
```

## Supabase development

Start and verify the local stack:

```sh
mise exec -- pnpm supabase start
mise exec -- pnpm supabase db reset
mise exec -- pnpm test:migration
mise exec -- pnpm supabase test db
```

`test:migration` creates a temporary database inside the local Supabase
Postgres container, applies the legacy schema, loads representative source,
relationship, discovery, and fetch-state rows, runs the generalized migration,
and verifies field-for-field preservation before deleting the temporary
database. It never connects to the hosted project.

This repository uses dedicated local ports in the `5742x` range so it can run
alongside other Supabase or Postgres projects. Local analytics is intentionally
disabled because it is not needed for migration or RPC testing and its Vector
collector cannot bind the default Colima Docker socket reliably.

Link and apply migrations to the hosted development project:

```sh
mise exec -- pnpm supabase link --project-ref qdqmahimrnwhzdjlcont
mise exec -- pnpm supabase db push --dry-run
mise exec -- pnpm supabase db push
```

The CLI prompts for the database password when it needs a direct connection. Do not pass it on the command line. Confirm that the hosted migration catalog is current with a second `db push --dry-run`; it should report `Remote database is up to date`.

Before a destructive migration or once hosted data becomes valuable, take a manual dump and store it outside the repository:

```sh
mise exec -- pnpm supabase db dump --linked --file pipeline-backup.sql
```

`pipeline-backup.sql` matches the ignored `*-backup.sql` pattern. Still move the dump outside the repository immediately. Automated backups to R2 are required before production use.

## Site feed discovery

Discovery uses `site_discovery_state` as its durable backlog and the dedicated
Queue only for leased near-term work. Apply the migration sequence through
`20260718000300_generalize_news_sources` (discovery state arrives in `00300`,
the feed tables in `00400`, and `...000300` generalizes them to
`news_sources`) before deploying the Worker bindings. Configure `DISCOVERY_CONTACT` before enabling dispatch;
the Worker refuses to claim sites when enabled without a valid email address or
HTTPS contact page.

After the 1-site and 25-site gates, the measured canary settings are 10 claims
per minute, Queue batch size one, consumer concurrency 10, and a 20-message
high-water mark. `supabase/queries/prepare-discovery-canary.sql`
provides a reversible, full-schedule fence for the 1/25/250-site review gates.
The one-site gate uses `pnpm discovery:dispatch-canary <site-id>` while Cron is
disabled; the command compensates the database lease if direct Queue HTTP
publication fails. Pause inventory synchronization for every active canary.
`docs/operations/site-feed-discovery.md` is the pause/recovery runbook.

Current Cloudflare documentation (verified 2026-07-17) lists 50 external
subrequests, 128 MiB memory, 10,000 Queue operations/day, and 24-hour Queue
retention for Workers Free. Queue consumers default to 30 seconds of CPU and a
15-minute wall-time limit on both Free and Paid; this implementation uses a
10-minute site deadline and a 15-minute database lease. The hosted 25-site run
peaked at 308 ms CPU and 1.83 MiB per response.

Do not enable the full backlog on Workers Free at 10 sites/minute. That rate
uses about 43,200 Queue operations/day. Upgrade Workers or lower the
steady-state claim rate before full rollout.

The initial database seed is a separate operator path and does not publish
Queue messages. Run
`pnpm discovery:backfill --dry-run --concurrency 60 --max-per-base-domain 10`,
then the same command without `--dry-run`, while the recurring dispatcher
remains disabled. The runner shares discovery policy and persistence with the
Worker, uses durable database leases for resume, and keeps at most 10 active
crawls per base domain. Recurring Worker claims continue to default to one
active crawl per base domain. Full operating and recovery guidance is in
`docs/operations/site-feed-discovery.md`.

### Hosted rollout record (2026-07-18)

Hosted migrations match local history through
`20260718000200_add_backfill_domain_lanes.sql`. The 1-, 25-, and 250-site gates
passed before the direct seed. All 25,367 eligible inventory rows received
policy-version-1 discovery between `2026-07-17T23:03:05Z` and
`2026-07-18T04:23:54Z`, an observed processing window of 5 hours, 20 minutes,
and 49 seconds. The final 698-site, single-parent-domain tail settled in 339.7
seconds at 60 global lanes and 10 lanes per base domain, with no stale writes or
system failures.

Final hosted state at handoff:

- 1,661 `succeeded`, 9,603 `no_feed`, 14,103 `backoff`, 4,202 `disabled`, and
  zero `pending` or `leased` rows across all 29,569 inventory rows.
- 1,372 active canonical feeds (1,300 RSS and 72 Atom), 3,446 active
  site-to-feed relationships, and 200 feeds shared by more than one site.
- 1,372 pending `feed_fetch_state` rows; feed polling remains out of scope and
  no polling consumer is enabled.
- Zero expired leases, zero future-fence residue, and zero discovery Queue or
  DLQ backlog. Restoring the temporary schedule fence made 12,771 refresh or
  backoff rows legitimately due; a pending-only proof run claimed zero of them.

Worker deployment `d175f696-0f40-493c-8781-9c188f35d175` has valid bindings and
contact configuration with `DISCOVERY_ENABLED=false`. Both Cron triggers and
the dedicated Queue consumer remain provisioned for a deliberate future
trigger. Do not enable recurring discovery until its steady-state rate and
Workers tier are selected; recurring claims retain one base-domain lane.

Validate without deploying:

```sh
mise exec -- pnpm --filter @dot-gov-news/pipeline-worker generate-types
mise exec -- pnpm --filter @dot-gov-news/pipeline-worker check:deploy
```

## GSA government-site inventory

Validate the current upstream snapshot and write the active, unfiltered,
ingestion-usable hostname list without changing Supabase or R2:

```sh
mise exec -- pnpm inventory:sync --dry-run
mise exec -- pnpm inventory:sync --dry-run --output /tmp/dot-gov-usable-sites.txt
```

To exercise the complete reconciliation against local Supabase without R2
credentials, load the local Supabase URL and service-role key and use a
temporary artifact directory:

```sh
mise exec -- pnpm inventory:sync --local-artifact-directory /tmp/dot-gov-inventory-artifacts
```

The command refuses local artifact storage when `SUPABASE_URL` is not localhost.

The durable synchronization additionally requires the Supabase server key and
R2 S3-compatible credentials listed in `.env.example`. The Cloudflare API token
used by Wrangler is not an R2 S3 access key. Create a narrowly scoped R2 token
for the artifact bucket, then run:

```sh
mise exec -- pnpm inventory:sync
```

The batch downloads the GSA CSV over HTTPS, enforces a 20 MiB maximum, computes
its SHA-256 checksum, archives it under
`inventory/gsa/<sha256>.csv`, stages rows in batches, and asks PostgreSQL to
validate and reconcile the complete snapshot atomically. Filtered, malformed,
duplicate-normalized, and missing records remain stored for audit; only active,
unfiltered, ingestion-usable records appear in
`public.usable_government_sites`.

### Service-only inventory API

Supabase exposes the public-schema functions through PostgREST under
`/rest/v1/rpc/<function_name>`. They require the server-side service key; `anon`
and `authenticated` cannot execute them.

| Operation | RPC or relation                     | Purpose                                                     |
| --------- | ----------------------------------- | ----------------------------------------------------------- |
| Create    | `begin_gsa_inventory_sync`          | Open one auditable running sync                             |
| Update    | `record_gsa_inventory_snapshot`     | Attach checksum, ETag, artifact key, and parsed count       |
| Update    | `stage_gsa_inventory_batch`         | Idempotently commit up to 1,000 source rows                 |
| Update    | `finalize_gsa_inventory_sync`       | Validate and atomically reconcile the complete snapshot     |
| Update    | `mark_gsa_inventory_sync_unchanged` | Close a verified ETag/checksum replay without staging       |
| Update    | `fail_gsa_inventory_sync`           | Close a pre-finalization failure with bounded diagnostics   |
| Read      | `get_government_inventory_summary`  | Return inventory, eligibility, and discovery-state counts   |
| Read      | `list_government_sites`             | Keyset-paginate and filter sites, including discovery state |
| Read      | `usable_government_sites`           | Query the active, unique discovery targets directly         |

For example, a server-side Supabase client can page usable sites with:

```ts
const { data, error } = await supabase.rpc("list_government_sites", {
  p_after_id: previousPageLastId,
  p_limit: 250,
  p_usable_only: true,
});
```

There is intentionally no generic update or hard-delete endpoint for
`government_sites`. GSA-owned fields change only through snapshot
reconciliation, and missing records are soft-deactivated. This prevents an API
caller from creating inventory state that cannot be explained by a source run.

Inspect recent runs and inventory counts with:

```sql
select
    status,
    source_row_count,
    staged_count,
    inserted_count,
    updated_count,
    reactivated_count,
    deactivated_count,
    eligible_count,
    started_at,
    completed_at,
    error_code
from public.inventory_sync_runs
order by started_at desc
limit 10;

select
    count(*) filter (
        where inventory_active and not gsa_filtered and inventory_usable
    ) as usable,
    count(*) filter (where inventory_active and gsa_filtered) as filtered,
    count(*) filter (where inventory_active and not inventory_usable) as excluded,
    count(*) filter (where not inventory_active) as inactive
from public.government_sites;
```

The GitHub workflow runs Thursday at `04:17 UTC` and also supports manual
dispatch. Configure the `development` GitHub environment with:

- Variables: `CLOUDFLARE_ACCOUNT_ID`, `R2_BUCKET_NAME`, `SUPABASE_URL`.
- Secrets: `R2_ACCESS_KEY_ID`, `R2_SECRET_ACCESS_KEY`,
  `SUPABASE_SECRET_KEY`.

The workflow file reads `R2_ACCESS_KEY_ID` from the environment's **secrets**
scope. A same-named GitHub variable does not satisfy that expression. Verify
names and scopes without printing values before the first run:

```sh
gh variable list --env development
gh secret list --env development
```

GitHub evaluates scheduled workflows only from the default branch. The schedule
therefore becomes active only after `.github/workflows/gsa-inventory-sync.yml`
is merged into `main`; use `workflow_dispatch` for the first controlled run.

Use the manual `allow_large_decrease` input only after inspecting the archived
snapshot. It bypasses the 80% week-over-week guard, but not required columns,
duplicate-hostname detection, staged-count equality, or the absolute 20,000-row
minimum.

### Local verification record (2026-07-17)

The live GSA snapshot was downloaded and reconciled into a reset local
Supabase instance:

| Check                            |                          Result |
| -------------------------------- | ------------------------------: |
| Source bytes                     |                       8,182,959 |
| Source rows staged               |                          29,569 |
| Usable unique hostnames          |                          25,367 |
| GSA-filtered rows retained       |                           4,195 |
| Ingestion-excluded rows retained |                               7 |
| Duplicate usable hostnames       |                               0 |
| Replay result                    | `unchanged`, zero rows restaged |

The seven ingestion exclusions comprise six malformed hostname values and one
duplicate normalized Unicode/punycode hostname. The raw snapshot SHA-256 was
`044512695181e8366a661c9597e27f66e645424b3d34302b1812b6e277f13a68`.

### Hosted inventory verification record (2026-07-17)

Migration `20260717000300_create_government_site_inventory.sql` was applied to
the hosted development project. The same source snapshot was uploaded to R2,
downloaded again, and verified at 8,182,959 bytes with the SHA-256 above before
its artifact key was attached to the hosted sync run.

| Check                            |                                 Result |
| -------------------------------- | -------------------------------------: |
| Successful run                   | `1ef2749e-ca15-45da-a945-72c986e60ead` |
| Source rows committed            |                                 29,569 |
| Usable discovery targets         |                                 25,367 |
| GSA-filtered rows retained       |                                  4,195 |
| Ingestion-excluded rows retained |                                      7 |
| Pending discovery states         |                                 25,367 |
| Replay run                       | `29853ecc-8446-46e4-832d-072e9744963a` |
| Replay result                    |        `unchanged`, zero rows restaged |

The service-key summary and paginated-list RPCs returned the same counts from
hosted PostgREST. The one-time archive bootstrap used authenticated Wrangler.
At this verification point the scheduled workflow remained inactive because it
had not yet been merged into the default branch; additionally,
`R2_ACCESS_KEY_ID` existed as a GitHub environment variable while the workflow
reads it as a secret. Correct that scope mismatch before the first controlled
dispatch.

## News corpus backfill artifacts and content

The news backfill archives every immutable source response in R2 before it
normalizes an entry. Object keys are content-addressed under
`news-backfill/objects/<sha256>`, and
`news_backfill_run_entries.raw_artifact_key` stores that exact key. Identical
response bodies from any publisher or run share one object. The run-entry and
candidate-outcome rows retain the publisher, run, fetch, and disposition
context; a changed response body receives a new object key.
Backfill run keys include the extractor version so a corrected extractor gets a
fresh candidate ledger instead of reusing terminal outcomes from an older
normalization pass.

`news_entries.summary` is the publisher-provided RSS/API summary or page
description. `news_entries.body_text` is the complete cleaned article or report
text. Neither field is sliced by the backfill. The runner limits RPC request
size by sending smaller entry batches, not by truncating an individual entry.

`news_source_publishers` records the one publisher key allowed for each curated
source. Backfill target creation stamps this mapping and rejects a conflicting
publisher. Clustering and Lab surfaces use that publisher key as `agency`; they
never infer agency from the live-source or Wayback hostname.

R2 is the default artifact store:

```sh
mise exec -- pnpm news:backfill --manifest ../../config/news-backfill/top-20-diversity-v3.json
```

Use a local artifact directory only as an explicit development fallback:

```sh
mise exec -- pnpm news:backfill --manifest ../../config/news-backfill/top-20-diversity-v3.json --artifact-directory ../../.data
```

To copy legacy local artifacts into the global content-addressed R2 namespace,
preview and then run the resumable migration:

```sh
mise exec -- pnpm --filter @dot-gov-news/news-backfill upload-artifacts --dry-run
mise exec -- pnpm --filter @dot-gov-news/news-backfill upload-artifacts --concurrency 16
mise exec -- pnpm --filter @dot-gov-news/news-backfill consolidate-artifacts --dry-run
mise exec -- pnpm --filter @dot-gov-news/news-backfill consolidate-artifacts --concurrency 16
```

The uploader uses HEAD before PUT, so retrying skips keys already present in
R2. Use `consolidate-artifacts` to copy legacy run-scoped R2 objects into the
same global namespace before applying the artifact-key consolidation database
migration. Verify database migrations that add `body_text` and
`ingest_news_entries_v2` before running the new extractor against a hosted
project.

## Operator CLI and dashboard

The Operator API is a separate read-only Worker. It can be deployed without
changing the pipeline Worker, Cron, or Queue consumers. Add
`SUPABASE_SECRET_KEY` to the ignored root `.env`, then use the one-time
bootstrap:

```sh
pnpm ops deploy --dry-run
pnpm ops deploy
```

The command validates the bundle, checks Cloudflare authentication, deploys with
`OPS_API_ENABLED=false` while supplying both required Worker secrets from a
permission-restricted temporary file, records the detected API URL and token
with an atomic mode-`0600` write, and then deploys the enabled version. It
performs an authenticated deep health check and restores the disabled deployment
if enablement or verification fails. Temporary secret directories are removed
on success, failure, and termination, with stale owned directories swept on the
next setup. The tracked Wrangler configuration remains disabled as a
kill-switch-safe default.
Use `--rotate-token` when the token must be replaced and `--yes` only for an
already-authorized non-interactive run.

An unauthenticated request, wrong token, mutation method, and unknown route must
all fail without provider details. Then verify individual queries as needed:

```sh
pnpm ops remote health --deep
pnpm ops remote queues --json
pnpm ops remote inventory summary
pnpm ops remote events list --since 30m
```

Start the local dashboard with:

```sh
pnpm ops:start
```

The server binds only to `127.0.0.1`. The browser calls the loopback proxy and
does not receive `OPS_API_TOKEN` or the Supabase service key. A one-time local
bootstrap URL establishes an HttpOnly session; strict Host and Origin checks
reject cross-site and DNS-rebinding requests. The optional live ledger launches
`wrangler tail --format json` with a lifecycle-log filter and a sampling rate.
Tail state is transient and sampled; Supabase leases and records remain
authoritative.

Discovery, feeds, and polling remain `not_enabled` until their durable schemas,
read models, Worker versions, and Queue bindings are present. Do not interpret
that state as a zero count.

To disable observation without touching processing, set
`OPS_API_ENABLED=false`, redeploy `operator-api`, and stop the local dashboard.

## Local Chroma

Start Chroma:

```sh
mise exec -- pnpm dev:chroma
docker compose -f infra/chroma/compose.yaml ps
curl --fail http://127.0.0.1:8000/api/v2/heartbeat
```

Stop it without deleting the persistent named volume:

```sh
mise exec -- pnpm dev:chroma:down
```

## Provision Cloudflare

Authenticate as described in `docs/infrastructure/access.md`, then create the resources once:

```sh
mise exec -- pnpm --filter @dot-gov-news/pipeline-worker exec wrangler whoami
mise exec -- pnpm --filter @dot-gov-news/pipeline-worker exec wrangler r2 bucket list
mise exec -- pnpm --filter @dot-gov-news/pipeline-worker exec wrangler queues create dot-gov-news-events-dev
mise exec -- pnpm --filter @dot-gov-news/pipeline-worker exec wrangler queues create dot-gov-news-events-dlq-dev
mise exec -- pnpm --filter @dot-gov-news/pipeline-worker exec wrangler r2 bucket create dot-gov-news-artifacts-dev
mise exec -- pnpm --filter @dot-gov-news/pipeline-worker exec wrangler secret put SUPABASE_SECRET_KEY
```

If the R2 list command returns Cloudflare API code `10042`, the account owner must open **Storage & databases > R2 > Overview** in the Cloudflare dashboard and complete the subscription checkout before bucket creation. R2 includes free monthly usage, but activation requires accepting billing terms.

Deploy only after the migration and secret are present:

```sh
mise exec -- pnpm --filter @dot-gov-news/pipeline-worker deploy
```

The Worker URL is `https://dot-gov-news-pipeline-dev.vincen-le.workers.dev`.

For the first deployment, temporarily remove the `triggers.crons` entry, deploy and complete the manual smoke test, then restore the committed schedules (`0 * * * *` heartbeat plus the `* * * * *` discovery dispatch tick, which is a no-op while `DISCOVERY_ENABLED=false`) and deploy again. To pause future scheduled work, repeat that procedure; deleting a Cron Trigger can take several minutes to propagate.

## Smoke verification

Check the public, secret-safe health response:

```sh
curl --fail https://dot-gov-news-pipeline-dev.vincen-le.workers.dev/health
```

After a scheduled heartbeat is delivered:

1. Confirm `dot-gov-news-events-dev` has no growing backlog.
2. Confirm `public.pipeline_events` contains one `infra.heartbeat` row for that scheduled time.
3. Confirm R2 contains `health/<event-id>.json`.
4. Redeliver the same event and confirm the unique `idempotency_key` leaves the row count at one.

### Hosted verification record (2026-07-17)

The initial hosted smoke was completed with the Cron Trigger disabled, then the
hourly trigger was enabled only after the durable path passed. This record
predates the discovery rollout; the current Worker configuration carries two
Cron triggers and two Queue producer/consumer pairs.

| Check             | Evidence                                                                                                                                                             |
| ----------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Health            | `GET /health` returned `status: ok` with Queue, R2, and Supabase bindings present.                                                                                   |
| Valid event       | Event `019f713d-4c00-8000-8000-000000000001` was published through the production Queue API.                                                                         |
| Supabase          | One `infra.heartbeat` row exists with idempotency key `infra.heartbeat:manual:2026-07-17T19:19:20.000Z`; its original `created_at` is `2026-07-17T19:19:40.134633Z`. |
| R2                | Direct retrieval of `health/019f713d-4c00-8000-8000-000000000001.json` returned the matching event.                                                                  |
| Replay            | Replaying the exact event left one Supabase row and rewrote the same deterministic R2 key.                                                                           |
| DLQ               | Poison event `malformed-dlq-smoke-20260717T1919Z` drained from the main queue and produced a DLQ backlog of one 43-byte message after three configured retries.      |
| Scheduled handler | Wrangler produced event `fb1ff2e4-1496-88ab-94d6-43d838fe9b6a` with source `cloudflare-cron`; the exact event produced one Supabase row and R2 object.               |
| Scheduled replay  | Replaying that scheduled event retained one row with original `created_at` `2026-07-17T19:37:03.441595Z` and the same R2 key.                                        |
| Final deployment  | Worker version `b4a9ab17-5d63-4de5-88ec-b14dc40178dc` is live with schedule `0 * * * *`, one producer, and one consumer.                                             |
| Cleanup           | Both Queue API backlog metrics returned zero after the known poison test message was purged from the DLQ.                                                            |

R2 bucket-level object counters can lag behind direct object reads. Use a direct
`wrangler r2 object get ... --remote` as the authoritative smoke-test check.

Inspect resources without exposing secrets:

```sh
mise exec -- pnpm --filter @dot-gov-news/pipeline-worker exec wrangler queues list
mise exec -- pnpm --filter @dot-gov-news/pipeline-worker exec wrangler queues info dot-gov-news-events-dev
mise exec -- pnpm --filter @dot-gov-news/pipeline-worker exec wrangler queues info dot-gov-news-events-dlq-dev
mise exec -- pnpm --filter @dot-gov-news/pipeline-worker exec wrangler r2 bucket list
mise exec -- pnpm --filter @dot-gov-news/pipeline-worker exec wrangler r2 object get dot-gov-news-artifacts-dev/health/<event-id>.json --remote --file /tmp/dot-gov-news-heartbeat.json
```

Cloudflare's Queues dashboard is the supported operator UI for individual messages. Open the queue, select **Messages**, then use **Send** to publish JSON or **List** to preview messages without acknowledging them. Send the exact same valid heartbeat JSON twice to verify that Supabase retains one row and R2 retains one deterministic object.

To verify the DLQ, send this JSON to `dot-gov-news-events-dev` from that dashboard:

```json
{ "id": "malformed" }
```

Wait for the configured retries, then open `dot-gov-news-events-dlq-dev` and use **Messages > List**. Previewing does not acknowledge the message. After recording the result, explicitly acknowledge only that test message so it does not remain until retention expiry.

## Failure handling

- Queue messages are acknowledged only after both R2 and Supabase writes succeed.
- Failures retry with bounded exponential delay.
- After three retries, Cloudflare moves the message to `dot-gov-news-events-dlq-dev`.
- Pause the Cron Trigger or remove the queue consumer before investigating a persistent failure.
- Logs include event IDs and outcomes but never database credentials.

Pause and resume queue delivery during an incident with the exact queue name:

```sh
mise exec -- pnpm --filter @dot-gov-news/pipeline-worker exec wrangler queues pause-delivery dot-gov-news-events-dev
mise exec -- pnpm --filter @dot-gov-news/pipeline-worker exec wrangler queues resume-delivery dot-gov-news-events-dev
```

## Secret rotation

Create a new modern Supabase secret key, update Cloudflare interactively, deploy, and verify `/health` plus one heartbeat before revoking the previous key:

```sh
mise exec -- pnpm --filter @dot-gov-news/pipeline-worker exec wrangler secret put SUPABASE_SECRET_KEY
mise exec -- pnpm --filter @dot-gov-news/pipeline-worker deploy
mise exec -- pnpm --filter @dot-gov-news/pipeline-worker exec wrangler secret list
```

Never place the key in a command argument, shell history, tracked file, or support message.

## Chroma recovery

Recreating the container with the same `dot-gov-news-chroma-data` volume preserves local collections. The bootstrap has no Chroma backup because hosted search is out of scope. If the volume is lost or corrupt, rebuild the future vector index from Supabase source records; delete the named volume only when that data loss is intentional.

## Free-tier limits to watch

- Supabase database size and egress.
- Cloudflare Queue operations and 24-hour message retention.
- Worker CPU usage and errors.
- R2 object count, writes, and stored bytes.

The first likely upgrade is Cloudflare Workers Paid when polling volume exceeds the free queue or CPU allowance.

Use the provider usage dashboards as the source of truth. Upgrade signals are sustained queue backlog, Worker CPU-limit errors, Supabase database/egress pressure, or R2 storage and operation usage approaching the configured account budget.
