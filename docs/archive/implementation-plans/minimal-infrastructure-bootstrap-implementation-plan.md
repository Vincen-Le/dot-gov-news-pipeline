# Implementation Plan: Minimal Infrastructure Bootstrap

**Date:** 2026-07-17
**Owner:** Vincent Le / independent project
**Type:** Infrastructure and external-service integration
**Status:** Implemented and verified

## Problem Statement

The dot-gov news pipeline needs a small, independent infrastructure foundation that future implementation sessions can build on. It must not depend on Zip infrastructure, should stay within free hosted tiers where practical, and should avoid prematurely operating Kubernetes, Kafka, Redis, a hosted Chroma cluster, or multiple deployment environments.

The bootstrap must prove that durable storage and asynchronous execution work end to end without implementing the news pipeline itself.

## Proposed Solution

Create one development environment containing:

1. One hosted Supabase free-plan project as the durable system of record.
2. One Cloudflare Worker containing HTTP, Cron, queue-producer, and queue-consumer entry points.
3. One Cloudflare Queue and one dead-letter queue for asynchronous event delivery.
4. One Cloudflare R2 bucket for raw or unstructured artifacts.
5. One local-only Chroma service running through Docker Compose.
6. One idempotent infrastructure heartbeat that proves the path `Cron -> Queue -> Worker -> R2 + Supabase`.

The heartbeat is deliberately the only functional workflow. News source inventory reconciliation, source discovery, polling, parsing, embeddings, clustering, ranking, search, and UI work are reserved for subsequent sessions.

## Minimal Resource Inventory

| Provider | Resource | Proposed name | Purpose |
|---|---|---|---|
| Supabase | Project | `dot-gov-news-pipeline-dev` | Durable development database |
| Cloudflare | Worker | `dot-gov-news-pipeline-dev` | HTTP, scheduled, and queue handlers |
| Cloudflare | Queue | `dot-gov-news-events-dev` | Asynchronous event delivery |
| Cloudflare | Dead-letter queue | `dot-gov-news-events-dlq-dev` | Failed-message inspection |
| Cloudflare | R2 bucket | `dot-gov-news-artifacts-dev` | Raw payloads and artifacts |
| Local Docker | Chroma | `dot-gov-news-chroma` | Local vector-store development |

Do not create staging or production variants during this bootstrap.

### Resolved Provider Context

| Setting | Value |
|---|---|
| Supabase project reference | `qdqmahimrnwhzdjlcont` |
| Supabase project URL | `https://qdqmahimrnwhzdjlcont.supabase.co` |
| Supabase region | `us-east-2` |
| Cloudflare account ID | `a2d6c849c1770d0e7e4fc042db14de25` (verified by Wrangler OAuth) |
| Cloudflare `workers.dev` subdomain | `vincen-le.workers.dev` |
| Cloudflare R2 activation | Active; bucket created 2026-07-17 |

## Requirements

1. All configuration, migrations, and resource names are committed to the repository.
2. No Zip-owned service, secret, network, package, or deployment system is required.
3. No credential is committed to Git or copied into documentation.
4. The hosted baseline has no mandatory monthly charge when it remains within provider free-tier quotas.
5. Cloudflare receives database access through a server-side secret, never a browser-visible key.
6. Supabase Row Level Security is enabled for application tables and exposes no anonymous write policy.
7. Queue processing is idempotent because Cloudflare Queues provides at-least-once delivery.
8. A scheduled smoke event is delivered through the queue and appears in both Supabase and R2.
9. Failed messages are retried and eventually sent to the dead-letter queue.
10. Chroma starts locally with persistent Docker storage and is not required by the hosted smoke path.
11. A later session can add domain tables and Worker handlers without restructuring the repository.
12. The setup and teardown commands are documented and reproducible.

## Constraints and Dependencies

- Supabase Free has a 500 MB database limit and no included automatic backups or point-in-time recovery.
- Cloudflare Queues Free includes 10,000 operations per day and 24-hour message retention. Queue every meaningful change, not every eventual source poll.
- Cloudflare Workers Free has strict CPU limits. The bootstrap performs only small JSON operations.
- Chroma open source requires persistent compute when hosted. This plan intentionally keeps it local.
- R2 must be activated in the target Cloudflare account before bucket creation.
- Docker is required for local Supabase and Chroma development.
- Provider CLIs should use interactive authentication on the developer machine. CI credentials are intentionally deferred until deployment automation is needed.

## Technical Approach

### Architecture Overview

```text
Cloudflare Cron (hourly smoke only)
        |
        v
Cloudflare Queue  ----failure----> Dead-letter queue
        |
        v
Queue consumer Worker
        |                 |
        v                 v
Supabase event row     R2 JSON artifact

Local development only:
application -> Chroma container -> named Docker volume
```

The scheduled handler creates an event with a stable UUID and idempotency key, then enqueues a small JSON envelope. The queue consumer writes a JSON artifact to R2 under a deterministic key and upserts the event into Supabase using the idempotency key. Retrying the same message therefore converges on the same state.

### Intended Repository Structure

```text
.
├── .github/
│   └── workflows/
│       └── ci.yml
├── apps/
│   └── pipeline-worker/
│       ├── src/
│       │   ├── handlers/
│       │   │   ├── health.ts
│       │   │   ├── queue.ts
│       │   │   └── scheduled.ts
│       │   ├── env.ts
│       │   └── index.ts
│       ├── test/
│       │   └── heartbeat.test.ts
│       ├── .dev.vars.example
│       ├── package.json
│       ├── tsconfig.json
│       ├── vitest.config.ts
│       └── wrangler.jsonc
├── docs/
│   └── infrastructure/
│       ├── access.md
│       ├── runbook.md
│       └── teardown.md
├── infra/
│   └── chroma/
│       └── compose.yaml
├── packages/
│   └── contracts/
│       ├── src/
│       │   └── pipeline-event.ts
│       ├── test/
│       │   └── pipeline-event.test.ts
│       ├── package.json
│       └── tsconfig.json
├── supabase/
│   ├── migrations/
│   │   └── 20260717000100_create_pipeline_events.sql
│   └── config.toml
├── .gitignore
├── package.json
├── pnpm-lock.yaml
├── pnpm-workspace.yaml
└── tsconfig.base.json
```

## Implementation Steps

### 1. Establish the repository and TypeScript workspace

**Complexity:** Small
**Dependencies:** None

Create:

- `package.json`
- `pnpm-workspace.yaml`
- `tsconfig.base.json`
- `.gitignore`
- `apps/pipeline-worker/.dev.vars.example`

Pin the project to Node 24 LTS, then use pnpm, strict TypeScript, ESLint, Prettier, and Vitest. Do not use the machine's currently installed Node 25 release because it is end-of-life. The root scripts should include:

```text
pnpm lint
pnpm typecheck
pnpm test
pnpm dev:worker
pnpm dev:chroma
```

Ensure every `.dev.vars` and `.env` file, Supabase temporary files, Chroma data, Wrangler local state, database dumps, and provider credentials are ignored. Keep the example file next to the Worker because Wrangler resolves local secrets from the Worker working directory.

**Deliverable:** A clean install supports linting, type checking, and testing before cloud resources exist.

### 2. Add a provider-neutral event contract

**Complexity:** Small
**Dependencies:** Step 1

Create:

- `packages/contracts/src/pipeline-event.ts`
- `packages/contracts/test/pipeline-event.test.ts`
- `packages/contracts/package.json`
- `packages/contracts/tsconfig.json`

Define and validate a versioned message envelope:

```ts
type PipelineEvent = {
  id: string;
  schemaVersion: 1;
  type: string;
  idempotencyKey: string;
  occurredAt: string;
  payload: Record<string, unknown>;
};
```

Use a runtime validator so malformed queue messages fail predictably. Do not place Cloudflare or Supabase types in this package.

**Deliverable:** Future publishers and consumers share one portable event schema.

### 3. Initialize Supabase and create the minimal durable event table

**Complexity:** Medium
**Dependencies:** Step 1; Supabase project reference and interactive login

Create:

- `supabase/config.toml`
- `supabase/migrations/20260717000100_create_pipeline_events.sql`

The migration should create `public.pipeline_events` with:

```text
id UUID PRIMARY KEY
schema_version SMALLINT NOT NULL
event_type TEXT NOT NULL
idempotency_key TEXT NOT NULL UNIQUE
occurred_at TIMESTAMPTZ NOT NULL
payload JSONB NOT NULL DEFAULT '{}'
artifact_key TEXT NULL
created_at TIMESTAMPTZ NOT NULL DEFAULT now()
```

Add indexes on `(event_type, occurred_at desc)` and `created_at`. Enable Row Level Security without adding public policies. The Worker will use a Supabase secret key stored in Cloudflare.

Run locally first:

```text
supabase start
supabase db reset
```

Then link and dry-run before applying to the hosted development project:

```text
supabase link --project-ref <project-ref>
supabase db push --dry-run
supabase db push
```

**Deliverable:** Repeating the same `idempotency_key` cannot create duplicate durable events.

### 4. Implement the single bootstrap Worker

**Complexity:** Medium
**Dependencies:** Steps 2 and 3

Create:

- `apps/pipeline-worker/src/env.ts`
- `apps/pipeline-worker/src/index.ts`
- `apps/pipeline-worker/src/handlers/health.ts`
- `apps/pipeline-worker/src/handlers/scheduled.ts`
- `apps/pipeline-worker/src/handlers/queue.ts`
- `apps/pipeline-worker/package.json`
- `apps/pipeline-worker/tsconfig.json`
- `apps/pipeline-worker/vitest.config.ts`

The Worker should expose:

- `fetch()` with an unauthenticated `GET /health` endpoint returning only build and binding status.
- `scheduled()` producing one `infra.heartbeat` message.
- `queue()` validating each message, writing `health/<event-id>.json` to R2, and upserting the corresponding Supabase row.

The consumer must acknowledge messages individually only after both writes succeed. Invalid or repeatedly failing messages must be allowed to reach the DLQ. Logs must include `event_id`, `event_type`, and outcome but no credentials or full secret-bearing request headers.

**Deliverable:** Handler logic is testable locally without provisioning additional services.

### 5. Declare and provision the minimal Cloudflare resources

**Complexity:** Medium
**Dependencies:** Step 4; Cloudflare account ID and interactive Wrangler login

Create:

- `apps/pipeline-worker/wrangler.jsonc`
- `docs/infrastructure/runbook.md`
- `docs/infrastructure/teardown.md`

Configure these bindings:

```text
PIPELINE_EVENTS_QUEUE -> dot-gov-news-events-dev
ARTIFACTS             -> dot-gov-news-artifacts-dev
SUPABASE_URL           -> non-secret Worker variable
SUPABASE_SECRET_KEY    -> Wrangler secret
```

Configure one hourly Cron Trigger (`0 * * * *`) for smoke testing. Do not switch to every-minute scheduling until source polling is implemented.

Provision explicitly and record the exact commands in the runbook:

```text
wrangler queues create dot-gov-news-events-dev
wrangler queues create dot-gov-news-events-dlq-dev
wrangler r2 bucket create dot-gov-news-artifacts-dev
wrangler secret put SUPABASE_SECRET_KEY
wrangler deploy
```

Configure the main queue consumer with a small batch size, three retries, and `dot-gov-news-events-dlq-dev` as its dead-letter queue. Keep message payloads below 64 KB and store large data in R2 by reference.

**Deliverable:** `wrangler deploy` creates a working Worker using pre-created queue and bucket resources.

### 6. Add local-only Chroma

**Complexity:** Small
**Dependencies:** Docker

Create `infra/chroma/compose.yaml` with:

- The official Chroma image pinned to an explicit version.
- Port `8000` bound to `127.0.0.1`, not every interface.
- A named volume mounted at Chroma's persistent data path.
- A health check.
- Reset/destructive operations disabled.

Do not add Chroma Cloud credentials, a public endpoint, or a production collection. Those belong to the semantic-search implementation session.

**Deliverable:** `docker compose -f infra/chroma/compose.yaml up -d` reaches a healthy local Chroma service and preserves data across container restarts.

### 7. Add infrastructure smoke tests

**Complexity:** Medium
**Dependencies:** Steps 3 through 6

Create `apps/pipeline-worker/test/heartbeat.test.ts` and test:

1. The scheduled handler publishes a schema-valid heartbeat.
2. The consumer uses a deterministic R2 key.
3. Duplicate delivery performs an upsert rather than a duplicate insert.
4. A Supabase failure does not acknowledge the message.
5. An R2 failure does not acknowledge the message.
6. Malformed messages fail validation.
7. `/health` does not disclose secrets.

Perform one remote smoke test and record its identifiers in the runbook:

1. Invoke the scheduled handler through Wrangler.
2. Confirm the queue drains.
3. Confirm exactly one `infra.heartbeat` row exists in Supabase.
4. Confirm the corresponding R2 object exists.
5. Replay the same message and confirm the row count remains one.

**Deliverable:** The complete cross-provider path is verified without any news-domain logic.

### 8. Add CI verification but defer automatic deployment

**Complexity:** Small
**Dependencies:** Steps 1 through 7

Create `.github/workflows/ci.yml` that runs on pull requests and pushes:

- Dependency installation with a frozen lockfile.
- Lint.
- Typecheck.
- Unit tests.
- Wrangler configuration validation where possible without cloud credentials.

Do not add automatic cloud deployment during this bootstrap. Initial deployment should be manual through an interactively authenticated developer machine. A later session may add a short-lived, narrowly scoped Cloudflare token and protected GitHub environment after the resource model stabilizes.

**Deliverable:** Pull requests can validate the infrastructure code without provider secrets.

### 9. Document operations, limits, and recovery

**Complexity:** Small
**Dependencies:** All previous steps

Complete:

- `docs/infrastructure/access.md`
- `docs/infrastructure/runbook.md`
- `docs/infrastructure/teardown.md`

Document:

- Interactive login and logout procedures.
- Resource names and dashboard locations.
- Secret rotation.
- Queue and DLQ inspection.
- Pausing the Cron Trigger.
- Exporting the Supabase schema and data before destructive migrations.
- Restoring the local Chroma volume or rebuilding the future vector index.
- Free-tier quotas and the signals indicating an upgrade is necessary.

Automated Supabase backups are intentionally deferred, but the runbook must include a manual `supabase db dump` procedure before any hosted data becomes valuable. A scheduled backup to R2 becomes a required follow-up before labeling the system production-ready.

**Deliverable:** Another session can operate or remove every resource without relying on undocumented knowledge.

## Data Model Changes

Only `public.pipeline_events` is created during this bootstrap. It is a transport-level durability table, not the final news schema.

Explicitly defer these tables:

- `sites`
- `news_sources`
- `news_source_fetch_state`
- `entries`
- `story_clusters`
- `cluster_entries`
- `ranking_snapshots`
- `websub_subscriptions`

Each later schema change must use a new Supabase migration rather than modifying the bootstrap migration after it has been applied remotely.

## API Changes

Only `GET /health` is exposed. It must not query or return stored data. The future public news API, search API, WebSub receiver, and administration endpoints are out of scope.

## Security Model

- Prefer `npx wrangler login --use-keyring` and `supabase login` for local access.
- Use the modern Supabase `sb_secret_...` key rather than the legacy `service_role` key where available.
- Store `SUPABASE_SECRET_KEY` with `wrangler secret put`; never in `wrangler.jsonc` or `.dev.vars.example`.
- Enable RLS and create no anonymous write policy.
- Do not grant Cloudflare DNS, zone, user-management, billing, or global API-key access.
- Do not expose the Chroma development port beyond localhost.
- Add secret-pattern scanning to CI if a suitable free action is available.

## Access Required From the Owner

### Supabase

The following non-secret values have been provided:

1. Project reference: `qdqmahimrnwhzdjlcont`.
2. Project URL: `https://qdqmahimrnwhzdjlcont.supabase.co`.
3. Project region: `us-east-2`.

Perform these secret-bearing actions interactively instead of pasting values into chat:

1. Run `supabase login` in the local terminal.
2. Run `supabase link --project-ref <project-ref>` and enter the database password when prompted.
3. Run `wrangler secret put SUPABASE_SECRET_KEY` and paste the modern Supabase secret key at the prompt.

The implementation does not require Supabase organization membership, a global personal access token pasted into chat, or the database password stored in the repository.

### Cloudflare

The Cloudflare account ID was verified through the active Wrangler OAuth session as `a2d6c849c1770d0e7e4fc042db14de25`, the Workers subdomain is `vincen-le.workers.dev`, and R2 activation was verified by creating `dot-gov-news-artifacts-dev`.

Authenticate interactively by running:

```text
npx wrangler login --use-keyring
npx wrangler whoami
```

Do not provide a Cloudflare Global API Key. If CI deployment is added later, create a custom token restricted to the target account with only:

- Workers Scripts Edit
- Queues Edit
- Workers R2 Storage Edit
- Workers Tail Read, only if CI diagnostics require it

No zone or DNS permission is required until a custom domain is introduced.

### Chroma

No credential is required for the local-only bootstrap. Confirm only that Docker Desktop or an equivalent Docker runtime is installed.

## Testing Strategy

### Unit tests

- Event-envelope runtime validation.
- Scheduled event construction.
- Deterministic artifact naming.
- Supabase upsert request construction.
- Queue acknowledgment and retry behavior.
- Secret-safe health response.

### Local integration tests

- Apply Supabase migrations through `supabase db reset`.
- Start Chroma and verify its heartbeat endpoint.
- Run the Worker locally with mocked or local bindings.

### Hosted smoke test

- Produce one heartbeat.
- Verify one queue delivery, one R2 artifact, and one Supabase row.
- Redeliver the event and verify idempotency.
- Force a failing message and verify DLQ routing.

## Acceptance Criteria

The bootstrap is complete when:

- [x] The repository contains the declared configuration and documentation.
- [x] Local lint, typecheck, and unit tests pass.
- [x] The Supabase migration applies locally and remotely.
- [x] The Cloudflare Worker deploys successfully.
- [x] The main queue and DLQ exist and are bound correctly.
- [x] The R2 bucket exists and is bound correctly.
- [x] One scheduled heartbeat produces exactly one Supabase row and one R2 object.
- [x] Replaying the heartbeat does not produce duplicate durable state.
- [x] A poison message reaches the DLQ after the configured retries.
- [x] Chroma runs locally and persists across a restart.
- [x] No secret appears in Git history, tracked files, or Worker logs.
- [x] The runbook explains setup, verification, rotation, and teardown.

## Rollout and Rollback

### Rollout

1. Complete and test everything locally.
2. Apply the additive Supabase migration.
3. Provision the queue, DLQ, and R2 bucket.
4. Store the Supabase Worker secret.
5. Deploy the Worker with the Cron Trigger disabled.
6. Run a manually triggered heartbeat.
7. Enable the hourly Cron Trigger after validation.

### Rollback

1. Disable the Cron Trigger.
2. Remove or pause the queue consumer.
3. Roll the Worker back to its prior version or delete it if this is the first version.
4. Retain the Supabase table and R2 artifacts until verification is complete.
5. Delete resources only through the explicit teardown runbook.

The initial database migration is additive. Do not drop the table as an automatic rollback action because doing so destroys diagnostic data.

## Explicit Non-Goals

- Crawling the GSA inventory.
- Discovering RSS or Atom endpoints.
- Adaptive source scheduling.
- Fetching or parsing news sources.
- WebSub subscriptions.
- Embedding generation.
- Hosted Chroma.
- Semantic clustering or ranking.
- Search or public APIs beyond `/health`.
- Cloudflare Pages or a UI.
- Custom domains and DNS.
- Authentication and user accounts.
- Production or staging environments.
- Automated deployment.
- Automated backups or disaster recovery guarantees.
- Any Zip integration.

## Follow-Up Sessions

Once this bootstrap passes, separate sessions can build in this order:

1. GSA inventory ingestion and `sites` schema.
2. News source discovery and `news_sources` schema.
3. Due-source claiming and conditional fetch logic.
4. News source parsing, normalization, and entry deduplication.
5. Embedding generation and a hosted vector-store decision.
6. Story clustering and ranking.
7. Public API and user interface.
8. Automated backups, deployment environments, and production hardening.

## Open Questions

1. Is strict `$0` ongoing cost a hard constraint, or is a future approximately `$5/month` Workers upgrade acceptable when polling volume requires it?
2. Should hosted Chroma eventually use Chroma Cloud, or should semantic search initially use Supabase `pgvector`?

Neither question blocks writing, locally testing, or remotely provisioning the bootstrap.

## References

- [Supabase CLI database push](https://supabase.com/docs/reference/cli/supabase-db-push)
- [Supabase API keys](https://supabase.com/docs/guides/getting-started/api-keys)
- [Cloudflare Wrangler authentication](https://developers.cloudflare.com/workers/wrangler/commands/general/)
- [Cloudflare Queues pricing](https://developers.cloudflare.com/queues/platform/pricing/)
- [Cloudflare API-token permissions](https://developers.cloudflare.com/fundamentals/api/reference/permissions/)
- [Chroma Docker deployment](https://docs.trychroma.com/deployment/docker)
