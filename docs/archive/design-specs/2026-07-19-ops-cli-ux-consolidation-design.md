# Ops CLI UX Consolidation Design

Date: 2026-07-19
Status: Approved
Base: main@47bc8d2 (post autoresearch/spine/eval/golden merges), branch claude/local-dev-setup-process-67aa52

## Goal

Reduce the operator CLI's 33-command surface to a structure a contributor can
navigate by audience, and add one idempotent `pnpm ops setup` that prepares
the databases for every pipeline in `config/pipelines.json` (today:
`complex_v1` on the primary `postgres` database, `simple_v1` on
`simple_v1_db`).

## Decisions

| Question            | Decision                                                            |
| ------------------- | ------------------------------------------------------------------- |
| setup vs onboard    | Layered: `setup` = idempotent core; `onboard` = first-run wrapper    |
| `lab setup`         | Absorbed into `ops setup`; deprecation alias prints pointer          |
| Remote observability| Capability-gated on `OPS_API_URL` presence (CF infra torn down)      |
| `ops:setup` script  | Renamed `ops deploy` (CF operator-API deploy)                        |
| Regrouping          | Full pass: remote group; local + lab + meta                          |
| Old command names   | One-release shims printing the new name, then exit 2                 |

## Target surface

```
pnpm ops                       # bare = grouped help; "start here: onboard"
  LOCAL:  onboard | setup [--fresh] | doctor [--json] | env init | dashboard
  LAB:    lab corpus|storylines|themes|storyline <id>|metrics|borderline|experiments|run
  REMOTE (gated): remote health|queues|events|inventory|discovery|site|worker
  META:   deploy | docs:generate
```

## 1. `ops setup`

Idempotent, non-interactive. Steps, each state-checked and skippable:

1. Local stack: probe 57422; `pnpm supabase start` if down.
2. Migrations: `pnpm supabase migration up --local` — never `db reset`.
   `--fresh` runs `db reset` after explicit stdin confirmation (or `--yes`).
3. Corpus: `uv run python -m pipeline.cli sync` into the primary database.
4. Registry provisioning: for each `config/pipelines.json` entry, reuse
   `setupPipeline` from `apps/operator-console/src/lab/setup.ts` (verify
   required tables/RPC; managed `<name>_db` databases created via
   `scripts/create-pipeline-db.sh`; the primary `postgres` database is only
   verified, never provisioned or reset).
5. Report table: pipeline, database, status (ready | provisioned | verified |
   failed + fix).

`ops lab setup` remains registered for one release: prints
"moved: pnpm ops setup" and exits 2.

## 2. `ops onboard` refactor

Wizard becomes: tooling doctor gate → env init (if creds missing) →
**`setup` core (shared code path, not a subprocess)** → 25-entry embed proof
(unchanged) → smoke experiment (unchanged) → summary. The wizard's own
supabase-start/db-reset/sync steps are deleted; `--fresh` forwards to setup's
confirm-gated reset.

## 3. Registry-aware `doctor`

- One check row per registry pipeline: connectivity + required tables
  (reusing `setupPipeline`'s verification queries) —
  `✗ pipeline simple_v1 (simple_v1_db) — missing experiment tables; fix: pnpm ops setup`.
- New row `remote API`: "not deployed (optional)" when `OPS_API_URL` unset;
  probe when set.
- Falls back to the single-db check when `config/pipelines.json` is absent.

## 4. Remote group + capability gate

- `health`, `queues`, `events`, `inventory`, `discovery`, `site`, `worker`
  move under `program.command("remote")`. Implementations unchanged — pure
  re-registration.
- Gate: when `OPS_API_URL` is missing from env/.env, the `remote` group is
  registered hidden (commander `.hidden()`) and bare `pnpm ops` help prints
  one footer line: "remote: not configured — deploy the operator API first
  (pnpm ops deploy)". Invoking a remote command while unconfigured prints
  that line and exits 3 (matches existing `not_enabled` exit-code
  convention).
- Old top-level names (`ops health`, `ops queues`, …) register as hidden
  shims: print "moved: pnpm ops remote <name>", exit 2.

## 5. `deploy` rename

`package.json`: `"ops:setup"` script renamed `"ops:deploy"`; the operator
console gains `ops deploy` forwarding to the existing `setup.ts`
implementation (unchanged behavior, `--dry-run`/`--rotate-token` kept).
`ops:setup` script name removed — grep shows only docs reference it; docs
update in this work.

## 6. Hygiene

- `LOCAL_DSN` in `src/onboarding/checks.ts` re-exports
  `LOCAL_DATABASE_URL` from `src/config.ts` (single source).
- Fix the stale port-54322 wording in `src/lab/db.ts::labCapability`'s
  not-enabled message to name 57422.
- Out of scope: `pipeline/config.py`'s 54322 default (pinned by
  `tests/test_cache.py`; owned by the pipeline sessions).

## 7. Help & docs

- Bare `pnpm ops` prints grouped help (commander `configureHelp` sort +
  group headers via command descriptions) with "start here: pnpm ops onboard".
- Regenerate `docs/operations/cli-cheatsheet.md` (recipes update to new
  names); update `ONBOARDING.md`, `docs/operations/clustering-lab.md`,
  `docs/infrastructure/access.md`, README where command names appear.

## Error handling

All new/moved actions wrap in the existing `runAction` helper. Setup step
failures stop the sequence, print the failing step's stderr tail and a fix
line, exit nonzero. Provisioning failures for one pipeline do not block
verification of the others (report table shows per-pipeline status; exit
nonzero if any failed).

## Testing

- `ops setup` orchestration unit-tested with injected deps (mirroring
  `onboard.test.ts` fakes): skip logic, fresh confirm gate, per-pipeline
  fan-out, report shape.
- Doctor registry rows unit-tested with a fake registry + probes.
- Gate behavior: help hides remote when unconfigured; shims exit 2 —
  covered via commander invocation tests.
- Existing `lab-setup.test.ts`, `onboard.test.ts` updated, not deleted:
  the underlying `setupPipeline` and wizard logic keep their coverage.
- Full suites (pytest, console vitest, typecheck) green on node 24 and 25.

## Out of scope

- Ops API (worker) route changes — untouched.
- `pipeline/config.py` default DSN.
- Redeploying Cloudflare infra.
- Dashboard UI changes beyond none required.
