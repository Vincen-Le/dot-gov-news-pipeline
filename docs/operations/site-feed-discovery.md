# Site feed discovery operations

Site discovery is a lease-driven, at-least-once pipeline. Supabase is the
authoritative backlog; `dot-gov-site-discovery-dev` contains only near-term
leased work. A Queue pause or expired message does not lose the underlying
site.

## Safety gates

Keep `DISCOVERY_ENABLED=false` until all of these are true:

1. Migration `20260717000400_create_feed_discovery.sql` is applied.
2. The dedicated Queue and DLQ exist and the Worker bindings validate.
3. `DISCOVERY_CONTACT` is a monitored email address or HTTPS contact page.
4. A single manually selected site has been measured in hosted Worker logs.
5. The 25-site canary passes before preparing 250 sites.

After the 1-site and 25-site gates, the measured settings claim up to 10 sites
per minute, consume one message per invocation, allow 10 concurrent consumers,
and stop dispatching at a 20-message Queue high-water mark. Each claim contains
distinct base domains, and the database advisory lock prevents simultaneous
claim calls from bypassing an active same-domain lease.

The scaled settings are suitable for the 250-site canary. They require Workers
Paid before the full 25,367-site backlog is enabled: 10 sites/minute would use
about 43,200 Queue operations/day, above the Free plan's 10,000-operation daily
allowance. Keep discovery disabled after the canary until the account tier or
steady-state rate is explicitly selected.

The hosted 250-site gate completed with 14 succeeded sites, 80 valid no-feed
outcomes, 156 bounded publisher failures, and no stale leases or system
failures. Completed-crawl duration was 4.9 seconds at the median and 13.2
seconds at p95; one 97-second outlier remained within policy.

## Initial backfill

Use the direct runner to seed a large initial inventory without consuming
Cloudflare Queue operations. It calls the same claim, completion, and failure
RPCs and the same bounded discovery implementation as the Worker. The only
runtime-specific component is a Node HTML link extractor. Supabase is the
checkpoint: completed sites advance their next schedule, publisher failures
enter backoff, and an interrupted run resumes the remaining due rows.
The runner requests pending-only claims, so a long seed does not retry failures
whose backoff expires before the untouched inventory is exhausted. Recurring
Worker claims continue to include due refreshes and backoffs.

Keep `DISCOVERY_ENABLED=false` for the direct run. Dry-run first; it reads the
summary but makes no claims, publisher requests, or database writes:

```sh
export SUPABASE_URL=https://qdqmahimrnwhzdjlcont.supabase.co
export SUPABASE_SECRET_KEY=...
export DISCOVERY_CONTACT=vincen_le@berkeley.edu
pnpm discovery:backfill --dry-run --concurrency 60
pnpm discovery:backfill --concurrency 60 --progress-every 500
```

`--max-sites N` bounds a canary. The runner claims no more than 25 sites per RPC,
keeps at most one active crawl per base domain, retries transient repository
calls with bounded jitter, stops new claims on SIGINT/SIGTERM, and waits for
active work to settle. A persistent system failure stops the run after
token-aware lease compensation. On macOS, wrap the command with
`caffeinate -ims` for an unattended run.

Production validation showed that 120 concurrent domains can create an
unnecessary Supabase write burst. The measured default is therefore 60. Raising
global concurrency does not speed up a tail dominated by many subdomains under
the same parent domain; changing that domain-safety invariant requires a
separate review.

## Observe

Run `supabase/queries/discovery-health.sql` with an operator database role. It
shows state counts, oldest due work, active/expired leases, recent outcomes,
duration percentiles, publisher error classes, canonical feeds, and shared
relationships.

Inspect Cloudflare separately:

```sh
mise exec -- pnpm --filter @dot-gov-news/pipeline-worker exec wrangler queues info dot-gov-site-discovery-dev
mise exec -- pnpm --filter @dot-gov-news/pipeline-worker exec wrangler queues info dot-gov-site-discovery-dlq-dev
mise exec -- pnpm --filter @dot-gov-news/pipeline-worker exec wrangler tail --format json
```

Structured logs contain site/event IDs, outcomes, bounded error codes, feed
counts, and publisher request counts. They intentionally omit response bodies,
credentials, and full publisher URLs.

## Canary

Disable the dispatcher and wait for active discovery leases to drain before
preparing a cohort. The script takes the same advisory lock as the claim RPC
and refuses to continue while any lease is active.

Copy `supabase/queries/prepare-discovery-canary.sql`, replace its placeholder
with exactly one reviewed eligible site ID, and run it transactionally for the
hosted smoke test. The script shifts every non-cohort schedule forward by 100
years so no future/backoff row can become due during a long canary. Its inverse
statement subtracts the same interval and restores every original schedule.
Do not run inventory synchronization until the dispatcher is disabled and the
fence is restored.

Keep `DISCOVERY_ENABLED=false` for the single-site smoke test. Use the
lease-aware operator command to claim the only due site and publish its exact
event through Cloudflare's Queue HTTP API:

```sh
export SUPABASE_URL=https://qdqmahimrnwhzdjlcont.supabase.co
export SUPABASE_SECRET_KEY=...
export CLOUDFLARE_ACCOUNT_ID=a2d6c849c1770d0e7e4fc042db14de25
export CLOUDFLARE_DISCOVERY_QUEUE_ID=8a5a339bee9d467791dd3679233fed9a
export CLOUDFLARE_API_TOKEN=... # requires Queues Edit
pnpm discovery:dispatch-canary <reviewed-site-uuid>
```

The command verifies that the database claim matches the reviewed site and
releases the lease if Queue publication fails. It does not print credentials.
This exercises the hosted Queue consumer without allowing the minute Cron to
claim work.

After the one-site review, disable dispatch, restore the fence, then prepare 25
IDs and enable the dispatcher. Repeat that sequence for 250 IDs. Check every
error class, Queue retry/DLQ result, relationship, and lease transition. A
partial scan must end in `backoff`; it must never increment relationship-miss
counters.

## Pause and recover

1. Set `DISCOVERY_ENABLED=false` and deploy that configuration.
2. If publisher traffic must stop immediately, pause Queue delivery.
3. Let active leases expire or call the token-aware release/recovery RPC.
4. Inspect the DLQ before resuming; do not purge it as a first response.

For a direct backfill, rerun the same command after the transient clears.
Database schedules are authoritative, so do not maintain or import a separate
checkpoint file.

The additive migration can remain during a Worker rollback. Do not delete feed
or provenance rows. Expired leases recover on ordinary future claim traffic.
