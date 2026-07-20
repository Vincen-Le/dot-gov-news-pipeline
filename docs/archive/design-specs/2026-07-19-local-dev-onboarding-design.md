# Local Dev Onboarding & Corpus Sync Design

Date: 2026-07-19
Status: Approved

## Goal

An invited collaborator clones the private repo and reaches a working local
experiment loop — hosted corpus synced into local Postgres, entries re-embedded
with their own Cloudflare Workers AI account — with two commands:

```sh
mise install && pnpm install
pnpm ops onboard
```

## Decisions

| Question              | Decision                                                                |
| --------------------- | ----------------------------------------------------------------------- |
| Audience              | Invited collaborators on the private repo                               |
| Sync model            | Snapshot pull (default) plus optional direct read-only hosted queries   |
| Sync payload          | Raw entries only; contributors re-embed locally with their own models   |
| Hosted read credential| Publishable key committed to repo + anon RLS on three corpus tables     |
| Direct-read credential| Optional `corpus_reader` Postgres DSN, handed out individually          |
| Cloudflare scope      | Workers AI token by default; worker deploys documented as opt-in        |
| CLI shape             | `pnpm ops onboard` wizard chaining standalone subcommands               |

## 1. Credentials & access model

**Default path (zero handoff).** The Supabase publishable key
(`sb_publishable_...`) and project URL are committed to the repo — both are
designed to be exposeable. A migration adds RLS `SELECT` policies for the
`anon` role on exactly three tables:

- `news_entries`
- `news_sources`
- `news_source_publishers`

All other tables remain locked to `anon`. Corpus data is public U.S.
government news content; key exposure is acceptable.

**Contributor-owned credentials.** Each contributor creates a free Cloudflare
account and a Workers AI-scoped API token. `CLOUDFLARE_ACCOUNT_ID` and
`CLOUDFLARE_API_TOKEN` go in the gitignored, mode-0600 `.env`. Model choices
are already env-overridable via `pipeline/config.py`.

**Optional direct-read path.** A `corpus_reader` Postgres role (SELECT on the
three corpus tables, connected through the Supavisor pooler) supports live
queries against hosted data. Its connection string is handed out individually,
stored as `HOSTED_READONLY_DATABASE_URL` in `.env`, and rotated when someone
leaves. The publishable key cannot serve this mode (REST-only).

**Convention preserved:** `DATABASE_URL` never lives in `.env`. Local tools
default to `postgresql://postgres:postgres@127.0.0.1:57422/postgres`.

## 2. CLI surface

Three additions to the operator console (`apps/operator-console`); the Python
`pipeline` CLI remains the experiment tool and is shelled out to via
`uv run python -m pipeline.cli`.

- **`pnpm ops doctor`** — environment checks: mise, node/pnpm, uv/python,
  docker daemon, supabase CLI, local db reachable on 57422, Cloudflare token
  valid (live test AI call), hosted publishable-key read works (REST probe),
  optional DSN valid (`SELECT 1`) when present. `--json` output; nonzero exit
  on failure; every failure prints the exact fix command.
- **`pnpm ops env init`** — interactive prompts for Cloudflare account ID and
  API token (and optional hosted DSN). Validates each credential live before
  writing. Writes `.env` atomically at mode 0600, following the existing
  `ops:setup` pattern. Re-running updates in place.
- **`pnpm ops onboard`** — wizard chaining, in order:
  1. `ops doctor` (tooling subset)
  2. `ops env init`
  3. `supabase start`
  4. `supabase db reset` (migrations + seed)
  5. `pipeline sync` (hosted corpus → local, publishable key)
  6. `pipeline prepare` on a small sample (default 25 entries) — proves the
     contributor's Cloudflare token and models work by re-embedding real
     entries
  7. `pipeline experiment` smoke run
  8. Success summary + pointer to the CLI cheatsheet

  Idempotent: each step inspects state first and skips or resumes; safe to
  re-run after any failure. `--dry-run` validates without changing anything.

## 3. Sync & experiment mechanics

- `pipeline/bench.py::sync_corpus` already implements the id-preserving,
  feature-invalidating raw-entry pull over PostgREST. Change: authenticate
  with the publishable key instead of `SUPABASE_SECRET_KEY`. The destination
  guard (`assert_local_dsn`) stays.
- Re-embedding uses the existing `pipeline prepare` path with the
  contributor's Cloudflare credentials. The `embedding_model` column records
  which model produced each embedding, so mixed-model corpora are detectable.
- Direct-read mode: read-only pipeline commands may target
  `HOSTED_READONLY_DATABASE_URL` via an explicit flag. Write commands
  (`cluster`, `prepare`, `reset`) gain a remote-DSN refusal guard mirroring
  `assert_local_dsn` — the role has no write grants, the guard is the second
  belt.

## 4. Docs, error handling, testing

- Root `ONBOARDING.md`: prerequisites (install mise and docker, create a
  Cloudflare account and Workers AI token — exact click paths), the
  two-command setup, a troubleshooting table keyed to doctor failure
  messages, and the opt-in worker-deploy path referencing
  `docs/infrastructure/access.md`.
- Doctor checks unit-tested with mocked executables.
- Publishable-key sync tested against the `lab_test` database using the
  existing gated-test pattern.
- RLS policies covered by a migration test asserting `anon` can SELECT the
  three corpus tables and nothing else.

## Out of scope

- Public (non-invited) distribution — would need published exports; the sync
  source is isolated enough to swap later.
- Per-contributor worker/queue/R2 deployments beyond documentation pointers.
- Automated key rotation.
