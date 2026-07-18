# dot-gov-news-pipeline

Independent infrastructure and source inventory for collecting news from U.S.
government websites.

The repository currently implements:

- Supabase for durable pipeline events, GSA inventory runs, government sites,
  and lease-based site-discovery due state.
- A Node/TypeScript batch application that validates and reconciles the weekly
  GSA Federal Website Index.
- Content-addressed source snapshot archival in Cloudflare R2.
- A scheduled and manually dispatchable GitHub Actions inventory workflow.
- Cloudflare Workers, Cron Triggers, Queues, and R2 for asynchronous compute
  and artifacts, including bounded site feed discovery.
- Canonical `feeds`, site-to-feed provenance, feed-fetch handoff state, and a
  resumable direct backfill runner for initial database seeding.
- Local Chroma through Docker for future semantic-search development.

Feed polling, article parsing, embeddings, ranking, search, and the public UI
remain follow-up work.

## Architecture smoke path

```text
Cloudflare Cron
    -> Cloudflare Queue
    -> queue consumer Worker
        -> Supabase pipeline_events
        -> R2 health/<event-id>.json
```

The queue is at-least-once. Event idempotency is enforced by the unique Supabase `idempotency_key`, and R2 objects use deterministic keys.

## GSA inventory path

```text
GSA Federal Website Index
    -> inventory-sync batch (local or GitHub Actions)
        -> R2 inventory/gsa/<sha256>.csv
        -> Supabase private staging
        -> atomic reconciliation
            -> government_sites
            -> site_discovery_state
            -> usable_government_sites
```

Every source row is retained for audit. Only active, GSA-unfiltered, and
ingestion-usable hostnames become due for feed discovery. A full hosted import
has reconciled 29,569 source rows into 25,367 usable discovery targets; replay
of the same checksum completed as an unchanged no-op.

Run a read-only source inspection with:

```sh
mise exec -- pnpm inventory:sync --dry-run
```

The durable sync, credential setup, hosted verification record, and recovery
queries are documented in the
[infrastructure runbook](docs/infrastructure/runbook.md#gsa-government-site-inventory).

## Site feed discovery path

```text
site_discovery_state
    -> lease-safe claim by distinct base domain
        -> bounded publisher crawl and feed validation
            -> feeds
            -> government_site_feeds
            -> feed_fetch_state
```

Cloudflare Queue/Cron is the recurring path. The initial inventory seed can run
directly with `pnpm discovery:backfill`; Supabase remains the checkpoint, so the
job is safe to resume after interruption. See the
[discovery operations guide](docs/operations/site-feed-discovery.md).

## Dependency management

This repository uses **pnpm** for Node.js and TypeScript dependencies and **uv** for Python dependencies. Generated dependency directories are local-only and ignored by Git.

### Node.js tooling

Install the pinned Node 24 toolchain and dependencies from the repository root:

```sh
mise install
mise exec -- pnpm install --frozen-lockfile
```

Run the repository-managed Supabase CLI with:

```sh
mise exec -- pnpm supabase --version
```

Do not install or commit individual files from `node_modules`. The committed `package.json` and `pnpm-lock.yaml` files are the reproducible dependency source.

### Python tooling

Python is not required by the infrastructure bootstrap, but the repository preserves an empty uv environment for later pipeline work.

Create `.venv` and install the exact dependencies from `uv.lock`:

```sh
uv sync --locked
```

Run Python commands inside the managed environment without activating it:

```sh
uv run python --version
```

Add or remove a Python dependency with `uv add <package>` or `uv remove <package>`. These commands update both `pyproject.toml` and `uv.lock`.

`requirements.txt` is an exported compatibility file for tools that only understand pip-style requirements. Regenerate it after dependency changes:

```sh
uv export --format requirements-txt --no-dev --no-emit-project --output-file requirements.txt
```

Do not edit `requirements.txt` directly. The `.venv` directory is generated locally and must not be committed.

## Local verification

```sh
mise exec -- pnpm format:check
mise exec -- pnpm lint
mise exec -- pnpm typecheck
mise exec -- pnpm test
mise exec -- pnpm supabase test db
mise exec -- pnpm --filter @dot-gov-news/pipeline-worker check:deploy
```

Start Chroma locally:

```sh
mise exec -- pnpm dev:chroma
curl --fail http://127.0.0.1:8000/api/v2/heartbeat
```

Run the local Supabase stack:

```sh
mise exec -- pnpm supabase start
mise exec -- pnpm supabase db reset
mise exec -- pnpm supabase test db
```

## Local secrets

Copy the committed root template and add credentials only to the ignored `.env` file:

```sh
cp .env.example .env
```

Never add real credentials to `.env.example` or commit `.env`. Worker-local secrets belong in the ignored `apps/pipeline-worker/.dev.vars`, copied from its adjacent example file.

## Infrastructure documentation

- [Documentation index](docs/index.md)
- [Architecture and implementation status](architecture.md)
- [Provider access](docs/infrastructure/access.md)
- [Operations runbook](docs/infrastructure/runbook.md)
- [Teardown procedure](docs/infrastructure/teardown.md)
- [Implementation plan](.claude/plans/minimal-infrastructure-bootstrap-implementation-plan.md)
- [Inventory and feed-discovery plan](.claude/plans/gsa-inventory-and-feed-discovery-implementation-plan.md)
