# Onboarding

Set up a local experiment environment for the clustering pipeline: the hosted
corpus synced into a local Postgres, entries embedded with **your own**
Cloudflare Workers AI account, and the full experiment loop
(`prepare` → `cluster` → `experiment`) running locally.

Nothing you do here can write to the hosted database. The sync credential is
read-only and limited to three corpus tables; every pipeline command refuses
a non-local `DATABASE_URL`.

## Prerequisites (one time)

1. **Docker Desktop** — <https://docs.docker.com/desktop/>. Must be running;
   the local Supabase stack lives in containers.
2. **mise** — `brew install mise` (or `curl https://mise.run | sh`), then add
   the activation line it prints to your shell profile.
3. **A free Cloudflare account with a Workers AI token:**
   - Sign up: <https://dash.cloudflare.com/sign-up>
   - Account ID: dashboard → Workers & Pages → right sidebar ("Account ID")
   - API token: dashboard → My Profile → API Tokens → Create Token →
     use the **Workers AI** template (Read permission is enough)

## Setup (two commands)

```sh
mise install && pnpm install
pnpm ops onboard
```

The wizard checks your toolchain, prompts for the Cloudflare credentials,
starts local Supabase, applies migrations, syncs the hosted corpus (via the
repo's committed read-only publishable key — nothing to configure), embeds a
25-entry sample with your models to prove the token works, and runs a smoke
experiment. Safe to re-run: completed steps are skipped. `--dry-run` shows
the plan; `--fresh` rebuilds the local database from scratch.

## Everyday commands

| Command                                                       | Purpose                                      |
| ------------------------------------------------------------- | -------------------------------------------- |
| `pnpm ops doctor`                                             | verify toolchain, credentials, hosted access |
| `uv run python -m pipeline.cli sync`                          | refresh the local corpus                     |
| `uv run python -m pipeline.cli prepare --limit 500`           | embed more entries                           |
| `uv run python -m pipeline.cli experiment <name> --limit 500` | run an experiment                            |
| `pnpm ops:start`                                              | open the operator dashboard                  |

Full command reference: `docs/operations/cli-cheatsheet.md`.

## Your models, your quota

Embedding and LLM calls use your Cloudflare account. Model choices are env
vars (see `pipeline/config.py`): `EMBEDDING_MODEL`, `ENRICHER_MODEL`,
`ADJUDICATOR_MODEL`, `JUDGE_MODEL`. The `embedding_model` column records
which model produced each embedding, so switching models is detectable —
run `uv run python -m pipeline.cli reset --features` after a switch.

Experiment history (`experiment_runs` and rank snapshots) is purely local.
Your runs never leave your machine.

## Optional: live queries against hosted data

For read-only SQL against the hosted database (fresher than your last sync),
ask the repo owner for a `corpus_reader` connection string, then store it
with `pnpm ops env init`. Use it directly:

```sh
psql "$HOSTED_READONLY_DATABASE_URL"
```

The role can `SELECT` only `news_entries`, `news_sources`, and
`news_source_publishers`.

## Optional: deploying your own Workers

Local experiments never need this. If you work on ingestion/worker code,
follow `docs/infrastructure/access.md`.

## Troubleshooting

`pnpm ops doctor` names each failing check and prints the fix. Common ones:

| Doctor check           | Usual cause                     | Fix                                                              |
| ---------------------- | ------------------------------- | ---------------------------------------------------------------- |
| `mise`                 | mise not installed              | Install mise: https://mise.jdx.dev/getting-started.html          |
| `docker`               | Docker Desktop not running      | start Docker Desktop                                             |
| `node` / `pnpm` / `uv` | shell not using mise            | `mise install`, check shell activation                           |
| `supabase`             | Supabase CLI not installed      | Run: pnpm install                                                |
| `local database`       | Supabase stack down             | `pnpm supabase start`                                            |
| `cloudflare token`     | token lacks Workers AI scope    | recreate token from the Workers AI template, `pnpm ops env init` |
| `hosted corpus read`   | publishable key missing/rotated | ask the repo owner; see `docs/infrastructure/access.md`          |
| `hosted direct read`   | stale optional DSN              | remove it from `.env` or request a fresh one                     |
