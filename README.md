# dot-gov-news-pipeline

Independent infrastructure and source inventory for collecting news from U.S.
government websites.

**New contributor?** See [ONBOARDING.md](ONBOARDING.md) — two commands to a
working local experiment environment.

The repository currently implements:

- Supabase for durable pipeline events, GSA inventory runs, government sites,
  lease-based site-discovery state, canonical news sources, site/source
  provenance, and source fetch scheduling.
- A Node/TypeScript batch application that validates and reconciles the weekly
  GSA Federal Website Index.
- Content-addressed source snapshot archival in Cloudflare R2.
- A scheduled and manually dispatchable GitHub Actions inventory workflow.
- Cloudflare Workers, Cron Triggers, Queues, and R2 for asynchronous compute
  and artifacts, including bounded site feed discovery.
- Canonical `news_sources`, site-to-source provenance, source-fetch handoff
  state, and a resumable direct discovery backfill runner for initial database
  seeding.
- A Node/TypeScript news-corpus backfill (`apps/news-backfill`) that fetches
  curated publisher histories from manifests in `config/news-backfill/`,
  archives every raw response in R2, and ingests normalized entries.
- A Python clustering pipeline (`pipeline/`) that prepares entries
  (extraction, normalization, fp16 embeddings stored in Postgres), clusters
  them into episodes and storylines, assigns topics and themes, and generates
  event and overview cards.
- A clustering lab in the operator console (`pnpm ops lab …`) for corpus QA,
  experiments, quality metrics, and borderline labeling.
- Local Chroma through Docker, retained as unused scaffolding for a possible
  future vector store; pipeline embeddings currently live in Postgres.

The database and shared TypeScript contracts support RSS, Atom, JSON Feed,
publisher APIs, HTML archives, and sitemaps through the generalized
`news_sources` model. Recurring source fetching at scale, learned ranking,
search, the public API, and the user interface remain follow-up work.

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
ingestion-usable hostnames become due for news-source discovery. A full hosted import
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
    -> lease-safe claim with bounded base-domain lanes
        -> bounded publisher crawl and source validation
            -> news_sources
            -> government_site_news_sources
            -> news_source_fetch_state
```

Cloudflare Queue/Cron is the recurring path and keeps one active lane per base
domain. The initial inventory seed can run directly with
`pnpm discovery:backfill` using a wider, explicit lane cap; Supabase remains the
checkpoint, so the job is safe to resume after interruption. See the
[discovery operations guide](docs/operations/site-feed-discovery.md).

## News corpus backfill and clustering lab

Seed the corpus from a curated manifest (raw responses archive to R2 by
default):

```sh
mise exec -- pnpm news:backfill --manifest ../../config/news-backfill/top-20-diversity-v3.json
```

Then sync, prepare, and cluster locally with the Python pipeline, and QA the
result in the lab:

```sh
uv run python -m pipeline.cli sync
uv run python -m pipeline.cli prepare
pnpm ops lab run --name baseline --stub
pnpm ops lab storylines --min-episodes 2
```

See the [clustering lab guide](docs/operations/clustering-lab.md) and the
[runbook's backfill section](docs/infrastructure/runbook.md#news-corpus-backfill-artifacts-and-content).
The [golden news curation guide](docs/operations/golden-news-curation.md)
covers the chronological July-August human-review loop and September-forward
anchored experiments.

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

Python 3.12+ hosts the clustering pipeline in `pipeline/` (sync, prepare,
cluster, reset, and experiment stages behind `uv run python -m pipeline.cli`)
with its test suite in `tests/`.

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
mise exec -- pnpm test:migration
mise exec -- pnpm supabase test db
```

## Local secrets

Copy the committed root template and add credentials only to the ignored `.env` file:

```sh
cp .env.example .env
```

Never add real credentials to `.env.example` or commit `.env`. Worker-local secrets belong in the ignored `apps/pipeline-worker/.dev.vars`, copied from its adjacent example file.

## Operator CLI and dashboard

The operator surface is read-only. Cloudflare continues running the pipeline
when the local console is closed; the local process only protects credentials,
proxies bounded reads, and optionally follows sampled Worker logs.

For the one-time setup, add `SUPABASE_SECRET_KEY` to the ignored root `.env`,
then let the bootstrap validate and deploy the Operator API, generate its token,
and write the remaining local configuration:

```sh
pnpm ops deploy --dry-run
pnpm ops deploy
```

After that, everyday startup is one command:

```sh
pnpm ops:start
```

The individual CLI queries remain available without Mise:

```sh
pnpm ops remote health --deep
pnpm ops remote queues
pnpm ops remote inventory summary
pnpm ops lab corpus
```

See [the generated CLI cheatsheet](docs/operations/cli-cheatsheet.md) for the
complete read-only command catalog, including the clustering lab commands.

## Infrastructure documentation

- [Documentation index](docs/index.md)
- [Architecture and implementation status](architecture.md)
- [Provider access](docs/infrastructure/access.md)
- [Operations runbook](docs/infrastructure/runbook.md)
- [Teardown procedure](docs/infrastructure/teardown.md)
- [Operator CLI cheatsheet](docs/operations/cli-cheatsheet.md)
- [Operator dashboard design proposal](docs/superpowers/specs/2026-07-17-operator-dashboard-nds-design.md)
- [Ranking pipeline design proposal](docs/superpowers/specs/2026-07-17-ranking-pipeline-design.md)
- [Operator observability implementation plan](.claude/plans/operator-cli-dashboard-observability-implementation-plan.md)
- [Implementation plan](.claude/plans/minimal-infrastructure-bootstrap-implementation-plan.md)
- [Inventory and news-source-discovery plan](.claude/plans/gsa-inventory-and-news-source-discovery-implementation-plan.md)
