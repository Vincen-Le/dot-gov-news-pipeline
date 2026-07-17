# dot-gov-news-pipeline

Minimal independent infrastructure for collecting and processing news from U.S. government websites.

The current bootstrap intentionally implements infrastructure only:

- Supabase for durable, idempotent pipeline events.
- Cloudflare Workers, Cron Triggers, Queues, and R2 for asynchronous compute and artifacts.
- Local Chroma through Docker for future semantic-search development.

Feed discovery, polling, parsing, embeddings, ranking, search, and the public UI are separate follow-up projects.

## Architecture smoke path

```text
Cloudflare Cron
    -> Cloudflare Queue
    -> queue consumer Worker
        -> Supabase pipeline_events
        -> R2 health/<event-id>.json
```

The queue is at-least-once. Event idempotency is enforced by the unique Supabase `idempotency_key`, and R2 objects use deterministic keys.

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
