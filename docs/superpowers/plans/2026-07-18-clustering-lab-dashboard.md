# Clustering Lab Dashboard Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

> **Revision 2 (2026-07-18):** rewritten against the executed experiment CLI (`docs/superpowers/plans/2026-07-18-experiment-cli.md`). Experiment execution now shells out to `pipeline.cli prepare/experiment/reset`; run history reads from the `experiment_runs` table (migration `20260718100200`, already claimed by that plan); the reset RPC, seed/eval stages, and the filesystem experiment store from revision 1 are gone. This plan is built **stacked on the unmerged pipeline worktree branch** (Task 0) — the pipeline stays off main until the lab has been used to evaluate it.

**Goal:** Extend the operator console (CLI + local dashboard) with a Clustering Lab: browse and QA storyline → episode → entry chains and event-card artifacts with their full attach-evidence audit trail, run clustering experiments against the synced `news_entries` corpus via the pipeline experiment CLI, and compare archived runs from `experiment_runs` — all in the existing National Design Studio visual system.

**Architecture:** A new `lab/` module inside `apps/operator-console`. The loopback express server (already session-guarded) gains `/api/lab/*` routes that read Postgres **directly** via `DATABASE_URL` (read-only transactions) — not through the hosted operator-api, because the lab targets the local bench database and needs aggregate SQL the Worker tier shouldn't carry. Experiment execution shells out to the pipeline CLI (`uv run python -m pipeline.cli prepare|experiment|reset`) exactly like `WorkerTail` shells out to wrangler, streaming progress over SSE. Run history is **database records**: each `experiment` invocation resets derived clustering state, replays, writes `docs/eval/<name>/report.md`, and inserts an `experiment_runs` row (config snapshot + summary stats + cache hits/misses) that survives every reset — the dashboard lists and compares runs from that table. The UI adds two nav sections — **Storylines** (browse/QA) and **Lab** (experiments) — built from the existing NDS components, tokens, and page grammar.

**Tech Stack:** TypeScript (strict), express 5, React 19 + react-router 7 + @tanstack/react-query 5, zod 4, `postgres` (porsager) 3, vitest + testing-library, Supabase Postgres 15, pipeline experiment CLI (Python, spawned as a child process).

**Prerequisites (all executed — verify on the branch you build against):**
- Clustering data-model migrations `20260718000400`–`20260718000800` (`news_entries`, `entity_stats`, `storylines`/`episodes`/`episode_entries`, `event_cards`, `rubric_weights`).
- Processing-pipeline plan Tasks 1–7 + experiment CLI plan Tasks 1–7, executed on the worktree branch `clustering-processing-pipeline`. **Deliberately unmerged** — the lab exists to evaluate that work before it lands, so this plan builds on a branch stacked on top of it (Task 0), not on main. Deliverables the lab consumes: `pipeline/` package with `cache.py`, `window.py`, `runner.py` (`prepare`/`cluster`), `bench.py` (`sync`/`reset_clusters`/`reset_features`, local-DSN guarded), `experiment.py` (`run_experiment` → report + DB record), `cli.py`; migrations `20260718100000` (compute_rank_key), `20260718100100` (write RPCs), `20260718100200` (**`experiment_runs`** — note: this number is taken; the lab plan adds **no migrations**).
- Corpus synced local: `uv run python -m pipeline.cli sync` (hosted → local, ids preserved, ~6,553 entries).
- The `uv` toolchain on PATH.

**Specs honored:** `docs/superpowers/specs/2026-07-17-operator-dashboard-nds-design.md` (visual system, data honesty rules, shared inspector, CLI/cheatsheet parity, keyboard).

## Design decisions (locked in by this plan)

1. **Direct Postgres reads from the console server.** The operator-api Worker stays untouched; clustering QA is a local, operator-only concern against `DATABASE_URL` (same env key and local default the pipeline uses: `postgresql://postgres:postgres@127.0.0.1:54322/postgres`). One read pool, every connection opened with `default_transaction_read_only = on` — the lab has **no database write path at all**; all mutation happens inside the spawned pipeline CLI, which is itself local-DSN guarded.
2. **Experiment execution = the pipeline experiment CLI, verbatim.** A dashboard/CLI run is at most three stages: optional `reset --features` (feature-level A/Bs: model swaps, `ENRICHMENT_ENABLED=false`) → optional `prepare [--stub]` (auto-included whenever entries have `embedding is null`) → `experiment <name> [--stub] [--limit N] [--until ISO] [--no-cache]`. The `experiment` command internally does reset-clusters → cluster replay → report → `experiment_runs` insert; the lab never re-implements any of it. Env overrides ride on the child process environment.
3. **Run history lives in `experiment_runs`, not files.** The table survives `reset --clusters` (only derived clustering tables are truncated), carries the redacted config snapshot, cluster report, summary stats (totals, both attach mixes, singleton rate, multi-episode chains, top chains), cache hits/misses, and started/finished timestamps. The dashboard lists runs, diffs two runs' summaries, **and diffs their configs** (show exactly which knobs changed). `docs/eval/<name>/report.md` is a convenience artifact the lab can display, keyed by run name.
4. **Live quality metrics are computed in TypeScript** from the clustering tables (which always hold the *latest* run's state) — similarity percentiles, dedupe calibration (`content_hash`-pair cosines → suggested `NEAR_DUP_THRESHOLD`), and shape histograms, which the coarse `summary` jsonb doesn't carry. Coarse cross-run comparison uses `experiment_runs.summary`; deep inspection uses the live snapshot.
5. **Capability is two-tier.** Reads (`storylines`, metrics, runs) work against any DSN with the migrations applied. Experiments additionally require a **local** DSN (`127.0.0.1`/`localhost`) — mirroring `pipeline/bench.py`'s structural guard — and the `experiment_runs` table. The capability payload carries both (`status` + `experimentsEnabled`/`experimentsReason`); the UI renders honest partial states.
6. **One experiment at a time.** The harness holds a single in-memory active-run slot; a second start returns HTTP 409 / CLI exit 2. Progress streams over SSE (same pattern as `/api/live`); the `experiment` stage's final stdout JSON line (`{"report": …, "run_id": …}`) links the finished run to its `experiment_runs` row.
7. **Env-override whitelist** mirrors the pipeline `Config` env keys exactly — 15 keys: `NEAR_DUP_THRESHOLD`, `CLUSTER_JOIN_THRESHOLD`, `STORYLINE_SIM_FLOOR`, `AMBIENT_EMA_CEILING`, `EPISODE_DORMANCY_HOURS`, `DEDUPE_WINDOW_HOURS`, `ENRICHMENT_ENABLED`, `EMBEDDING_MODEL`, `ENRICHER_MODEL`, `ADJUDICATOR_MODEL`, `JUDGE_MODEL`, `TAU_SECONDS`, `ENRICHER_VERSION`, `RUBRIC_VERSION`, `PROMPT_VERSION`. Unknown keys are rejected, so a typo'd override fails loudly instead of silently running the baseline.
8. **Human labels are corpus-level**: one `docs/eval/labels.csv` (`entry_a,entry_b,same_event`), appended from the UI label queue. Collection-only for now — the parent plan's eval harness (`--labels` scoring) is deferred, and the CSV is exactly the contract it will consume. Labels describe ground truth about entry pairs; they survive resets and apply to every run on the same corpus.
9. **Charts are ruled tables with proportional inline meters** (divs tinted with existing tokens) — no chart library. Matches the NDS aesthetic (hairline rules, tabular numerals) and keeps the bundle flat.
10. **Data honesty**: migrations missing / `DATABASE_URL` absent / zero storylines / experiments-disabled-on-remote-DSN each render as an explicit "Not enabled"/"No clustered state" block with the command to fix it — never a fake zero (spec's data-honesty rule). Failed experiment runs never insert an `experiment_runs` row; the archive is succeeded-runs-only and the UI says so.
11. **fp16 decoding in TS is a small hand-rolled decoder** (no typed-array lib dependency) so cosine calibration renders live in the dashboard.

## Global Constraints

- **Design system**: only the tokens and class grammar in `apps/operator-console/src/ui/styles.css` (`--canvas/--surface/--raised/--rule/--text/--muted/--live/--healthy/--attention/--failure`); Instrument Sans for text, `ui-monospace` + `tabular-nums` for numerals/ids; hairline `1px solid var(--rule)` separation, **no border-radius, no new colors, no shadows beyond the existing inspector/palette ones**; reuse `page-intro`, `ruled-section`, `section-heading` (roman-numeral `section-index`), `receipt-grid`, `metric-list`, `status-mark`, `inspector`, `filter-bar`, `table-scroll`, `activity-ledger`, `LoadingState`/`ErrorState`/`NotEnabled` components; every view exposes its CLI twin via `CopyCommand`; keyboard/dialog semantics identical to `SiteInspector` (native `<dialog>`, Escape closes); respects `prefers-reduced-motion` (already global).
- **TypeScript**: `@typescript-eslint/consistent-type-imports` and `no-explicit-any` are errors; ESM (`"type": "module"`); zod 4 schemas for every wire shape; camelCase over the wire — **except** `experiment_runs.summary`/`config`/`cluster_report` jsonb payloads, which pass through with the Python-side snake_case keys verbatim (they are the pipeline's contract, not ours).
- **Attach-method vocabulary is fixed** by the data model — entry→episode: `exact_url | content_hash | near_dup | event_key | centroid_join | entity_community | adjudicated_join | adjudicated_new | new_cluster | consolidation_merge | consolidation_split`; episode→storyline: `event_key | entity_candidate | adjudicated_join | new_storyline | consolidation_merge`. Render these strings verbatim (mono), never re-map them.
- **No new migrations.** The lab is read-only against the schema the pipeline plans created.
- **Tests**: unit tests run with `pnpm --filter @dot-gov-news/operator-console test` and must not need a database; DB-backed query tests are gated behind `LAB_DB_TESTS=1` + a running local Supabase.
- Commit after every green task; commit messages end with `Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>`.

## File structure

```
apps/operator-console/src/lab/vectors.ts        -- fp16 decode, cosine, percentiles, histogram (Task 1)
apps/operator-console/src/lab/db.ts             -- read pool, local-DSN check, two-tier capability (Task 1)
apps/operator-console/src/lab/contracts.ts      -- zod schemas for every lab wire shape (Task 2)
apps/operator-console/src/lab/queries.ts        -- all SQL reads incl. experiment_runs (Task 2)
apps/operator-console/src/lab/metrics.ts        -- live quality snapshot (Task 3)
apps/operator-console/src/lab/labels.ts         -- corpus labels.csv store (Task 4)
apps/operator-console/src/lab/harness.ts        -- staged pipeline-CLI runner, spawner seam (Task 5)
apps/operator-console/src/lab/routes.ts         -- express router /api/lab/* (Task 6)
apps/operator-console/src/server.ts             -- mount lab router (modify, Task 6)
apps/operator-console/src/config.ts             -- + databaseUrl (modify, Task 1)
apps/operator-console/src/cli.ts                -- + `ops lab …` command group (modify, Task 7)
apps/operator-console/src/recipes.ts            -- + lab recipes (modify, Task 7)
apps/operator-console/src/ui/lab-api.ts         -- browser fetch helper for /api/lab (Task 8)
apps/operator-console/src/ui/pages/StorylinesPage.tsx        -- browse (Task 8)
apps/operator-console/src/ui/pages/StorylineDetailPage.tsx   -- chain view (Task 8)
apps/operator-console/src/ui/pages/LabPage.tsx  -- corpus / run / runs / quality / labels (Task 9)
apps/operator-console/src/ui/App.tsx            -- + nav & routes (modify, Tasks 8–9)
apps/operator-console/src/ui/styles.css         -- + lab classes from existing tokens (Task 8)
apps/operator-console/test/…                    -- one test file per module
docs/operations/clustering-lab.md               -- runbook (Task 10)
docs/eval/<name>/report.md                      -- written by the pipeline CLI (displayed, not owned)
docs/eval/labels.csv                            -- corpus ground-truth labels (created on demand)
```

---

### Task 0: Stacked worktree setup

The pipeline branch is unmerged on purpose — the lab is the instrument that decides whether it merges. Build the lab on a branch stacked on top of it. Safe because file overlap is near zero (pipeline touches `pipeline/`, `supabase/`, `tests/`; lab touches `apps/operator-console/`, `docs/`) and the coupling is three stable contracts: the CLI subcommands, the `experiment_runs` schema, and `DATABASE_URL`.

**Every subsequent task's commands run from this worktree's root.** All commits land on `clustering-lab`.

- [ ] **Step 1: Create the stacked worktree**

```bash
git worktree add -b clustering-lab .claude/worktrees/clustering-lab clustering-processing-pipeline
cd .claude/worktrees/clustering-lab
```

Expected: new worktree at `.claude/worktrees/clustering-lab` on branch `clustering-lab`, whose history includes every `clustering-processing-pipeline` commit (verify: `git log --oneline -3` shows the experiment-CLI commits, e.g. `feat: persist experiment runs to db for dashboard consumption`).

- [ ] **Step 2: Verify the pipeline deliverables exist on this branch**

```bash
ls pipeline/cli.py pipeline/experiment.py pipeline/bench.py pipeline/cache.py pipeline/window.py
ls supabase/migrations/20260718100200_create_experiment_runs.sql
uv run python -m pipeline.cli --help
```

Expected: all files present; help lists exactly the subcommands the harness spawns — `sync`, `prepare`, `cluster`, `reset`, `experiment`. If any is missing, stop: wrong base branch.

- [ ] **Step 3: Verify the local bench database has the schema**

```bash
pnpm install
pnpm supabase start
pnpm supabase migration up
uv run python -c "
from pipeline.config import load_config
from pipeline.db import Db
db = Db(load_config().database_url)
print(db.one(\"select to_regclass('public.storylines') as clustering, to_regclass('public.experiment_runs') as runs, (select count(*) from public.news_entries) as entries\"))"
```

Expected: `clustering` and `runs` both non-null; `entries` > 0 (corpus synced). If `entries` is 0, run `uv run python -m pipeline.cli sync` (needs `SUPABASE_URL`/`SUPABASE_SECRET_KEY` in the root `.env`).

- [ ] **Step 4: Baseline test run**

```bash
uv run pytest -q
pnpm --filter @dot-gov-news/operator-console test
```

Expected: both green before any lab code exists — this is the executor's clean-slate receipt. Nothing to commit; Task 1 makes the first lab commit on this branch.

---

### Task 1: Lab foundation — vectors, read pool, two-tier capability, config

**Files:**
- Modify: `apps/operator-console/package.json` (add `postgres` dependency), `apps/operator-console/src/config.ts` (add `databaseUrl`), `.env.example` (document `DATABASE_URL`)
- Create: `apps/operator-console/src/lab/vectors.ts`, `apps/operator-console/src/lab/db.ts`
- Test: `apps/operator-console/test/lab-vectors.test.ts`, `apps/operator-console/test/lab-db.test.ts`

**Interfaces:**
- Produces:
  - `unpackFp16(raw: Uint8Array) -> number[]` (little-endian IEEE 754 half, matching numpy `float16.tobytes()`); `cosine(a: number[], b: number[]) -> number` (0 on zero-norm or length mismatch); `percentiles(values: number[]) -> Record<string, number>` (`p5/p25/p50/p75/p95`, linear interpolation, `{}` on empty, 4 dp); `bucketHistogram(values: number[], cap: number) -> { bucket: number; count: number }[]` (values clamped to `cap`, ascending buckets).
  - `createLabDb(databaseUrl: string) -> LabDb` where `LabDb = { read: Sql; close(): Promise<void> }` — the pool sets `default_transaction_read_only = on` at connection startup. **No write pool** (design decision 1).
  - `isLocalDsn(dsn: string) -> boolean` — hostname `127.0.0.1`/`localhost`/empty (same rule as `pipeline/bench.py::assert_local_dsn`).
  - `labCapability(db: LabDb | null, databaseUrl?: string) -> Promise<LabCapability>` where `LabCapability = { status: "available" | "not_enabled"; reason?: string; experimentsEnabled: boolean; experimentsReason?: string }`. `not_enabled` when `db` is null, `to_regclass('public.storylines')` is null, or the connection fails (reason = error message). `experimentsEnabled` requires `status === "available"` AND `to_regclass('public.experiment_runs')` present AND `isLocalDsn(databaseUrl)`; `experimentsReason` explains whichever gate failed.
  - `loadOperatorConfig()` gains optional `databaseUrl` (env `DATABASE_URL`).

- [ ] **Step 1: Add the dependency**

```bash
pnpm --filter @dot-gov-news/operator-console add postgres@3.4.7
```

Append to `.env.example` after the `OPS_ENVIRONMENT` line:

```
# Clustering lab (operator console). Same key the Python pipeline reads.
DATABASE_URL=postgresql://postgres:postgres@127.0.0.1:54322/postgres
```

- [ ] **Step 2: Write the failing tests**

```ts
// apps/operator-console/test/lab-vectors.test.ts
import { describe, expect, it } from "vitest";

import {
  bucketHistogram,
  cosine,
  percentiles,
  unpackFp16,
} from "../src/lab/vectors";

describe("fp16 vectors", () => {
  it("decodes little-endian half floats", () => {
    // 0x3c00 = 1.0, 0xbc00 = -1.0, 0x3800 = 0.5 (little-endian byte pairs)
    const raw = new Uint8Array([0x00, 0x3c, 0x00, 0xbc, 0x00, 0x38]);
    expect(unpackFp16(raw)).toEqual([1, -1, 0.5]);
  });

  it("computes cosine with zero-norm and mismatch guards", () => {
    expect(cosine([1, 0], [1, 0])).toBe(1);
    expect(cosine([1, 0], [0, 1])).toBe(0);
    expect(cosine([1, 0], [0, 0])).toBe(0);
    expect(cosine([1, 0], [1])).toBe(0);
  });
});

describe("percentiles", () => {
  it("interpolates linearly like numpy", () => {
    const p = percentiles(Array.from({ length: 100 }, (_, i) => i + 1));
    expect(p.p50).toBe(50.5);
    expect(p.p5).toBeLessThan(p.p95);
  });

  it("returns empty object for no values", () => {
    expect(percentiles([])).toEqual({});
  });
});

describe("bucketHistogram", () => {
  it("clamps to the cap and counts ascending buckets", () => {
    expect(bucketHistogram([1, 1, 2, 12], 10)).toEqual([
      { bucket: 1, count: 2 },
      { bucket: 2, count: 1 },
      { bucket: 10, count: 1 },
    ]);
  });
});
```

```ts
// apps/operator-console/test/lab-db.test.ts
import { describe, expect, it } from "vitest";

import { isLocalDsn, labCapability, type LabDb } from "../src/lab/db";

const LOCAL = "postgresql://postgres:postgres@127.0.0.1:54322/postgres";
const REMOTE = "postgresql://u:p@aws-1-us-east-2.pooler.supabase.com:5432/postgres";

function fakeDb(
  handler: () => Promise<{ clustering: boolean; runs: boolean }[]>,
): LabDb {
  return { close: async () => undefined, read: handler as unknown as LabDb["read"] };
}

describe("isLocalDsn", () => {
  it("accepts loopback hosts only", () => {
    expect(isLocalDsn(LOCAL)).toBe(true);
    expect(isLocalDsn("postgresql://postgres@localhost/postgres")).toBe(true);
    expect(isLocalDsn(REMOTE)).toBe(false);
    expect(isLocalDsn("not a dsn")).toBe(false);
  });
});

describe("labCapability", () => {
  it("reports not_enabled without a DATABASE_URL", async () => {
    const capability = await labCapability(null);
    expect(capability.status).toBe("not_enabled");
    expect(capability.experimentsEnabled).toBe(false);
    expect(capability.reason).toContain("DATABASE_URL");
  });

  it("reports not_enabled when clustering tables are missing", async () => {
    const capability = await labCapability(
      fakeDb(async () => [{ clustering: false, runs: false }]),
      LOCAL,
    );
    expect(capability.status).toBe("not_enabled");
    expect(capability.reason).toContain("migrations");
  });

  it("enables experiments only on a local DSN with experiment_runs", async () => {
    const full = await labCapability(
      fakeDb(async () => [{ clustering: true, runs: true }]),
      LOCAL,
    );
    expect(full).toEqual({ experimentsEnabled: true, status: "available" });

    const remote = await labCapability(
      fakeDb(async () => [{ clustering: true, runs: true }]),
      REMOTE,
    );
    expect(remote.status).toBe("available");
    expect(remote.experimentsEnabled).toBe(false);
    expect(remote.experimentsReason).toContain("local");

    const noRuns = await labCapability(
      fakeDb(async () => [{ clustering: true, runs: false }]),
      LOCAL,
    );
    expect(noRuns.experimentsEnabled).toBe(false);
    expect(noRuns.experimentsReason).toContain("experiment_runs");
  });

  it("surfaces connection failures as the reason", async () => {
    const capability = await labCapability(
      fakeDb(async () => {
        throw new Error("connection refused");
      }),
      LOCAL,
    );
    expect(capability.status).toBe("not_enabled");
    expect(capability.reason).toContain("connection refused");
  });
});
```

- [ ] **Step 3: Run tests to verify they fail**

Run: `pnpm --filter @dot-gov-news/operator-console test -- lab-`
Expected: FAIL — cannot resolve `../src/lab/vectors` / `../src/lab/db`.

- [ ] **Step 4: Implement**

```ts
// apps/operator-console/src/lab/vectors.ts
/** fp16 decode + similarity/statistics helpers.
 *
 * Embeddings are stored as little-endian IEEE 754 half floats (numpy
 * `float16.tobytes()`); decoded by hand so the console has no typed-array
 * lib dependency. Percentiles use linear interpolation to match numpy's
 * default, so live numbers agree with any Python-side analysis.
 */

function halfToNumber(half: number): number {
  const sign = half & 0x8000 ? -1 : 1;
  const exponent = (half >> 10) & 0x1f;
  const fraction = half & 0x3ff;
  if (exponent === 0) return sign * fraction * 2 ** -24;
  if (exponent === 31) return fraction === 0 ? sign * Infinity : Number.NaN;
  return sign * (1 + fraction / 1024) * 2 ** (exponent - 15);
}

export function unpackFp16(raw: Uint8Array): number[] {
  const view = new DataView(raw.buffer, raw.byteOffset, raw.byteLength);
  const out: number[] = [];
  for (let offset = 0; offset + 1 < raw.byteLength; offset += 2) {
    out.push(halfToNumber(view.getUint16(offset, true)));
  }
  return out;
}

export function cosine(a: number[], b: number[]): number {
  if (a.length !== b.length || a.length === 0) return 0;
  let dot = 0;
  let normA = 0;
  let normB = 0;
  for (let i = 0; i < a.length; i += 1) {
    dot += a[i] * b[i];
    normA += a[i] * a[i];
    normB += b[i] * b[i];
  }
  if (normA === 0 || normB === 0) return 0;
  return dot / (Math.sqrt(normA) * Math.sqrt(normB));
}

export function percentiles(values: number[]): Record<string, number> {
  if (values.length === 0) return {};
  const sorted = [...values].sort((left, right) => left - right);
  const at = (q: number): number => {
    const position = (q / 100) * (sorted.length - 1);
    const lower = Math.floor(position);
    const upper = Math.ceil(position);
    const weight = position - lower;
    return sorted[lower] * (1 - weight) + sorted[upper] * weight;
  };
  return Object.fromEntries(
    [5, 25, 50, 75, 95].map((q) => [`p${q}`, Number(at(q).toFixed(4))]),
  );
}

export function bucketHistogram(
  values: number[],
  cap: number,
): { bucket: number; count: number }[] {
  const counts = new Map<number, number>();
  for (const value of values) {
    const bucket = Math.min(value, cap);
    counts.set(bucket, (counts.get(bucket) ?? 0) + 1);
  }
  return [...counts.entries()]
    .sort(([left], [right]) => left - right)
    .map(([bucket, count]) => ({ bucket, count }));
}
```

```ts
// apps/operator-console/src/lab/db.ts
import postgres from "postgres";

export interface LabDb {
  read: postgres.Sql;
  close(): Promise<void>;
}

export interface LabCapability {
  experimentsEnabled: boolean;
  experimentsReason?: string;
  reason?: string;
  status: "available" | "not_enabled";
}

export function createLabDb(databaseUrl: string): LabDb {
  const read = postgres(databaseUrl, {
    connection: { default_transaction_read_only: "on" },
    max: 4,
    prepare: false,
  });
  return {
    async close() {
      await read.end({ timeout: 5 });
    },
    read,
  };
}

/** Same rule as pipeline/bench.py::assert_local_dsn — experiments only ever
 * target the local bench database. */
export function isLocalDsn(dsn: string): boolean {
  try {
    const host = new URL(dsn).hostname;
    return host === "" || host === "127.0.0.1" || host === "localhost";
  } catch {
    return false;
  }
}

export async function labCapability(
  db: LabDb | null,
  databaseUrl?: string,
): Promise<LabCapability> {
  if (db === null) {
    return {
      experimentsEnabled: false,
      reason:
        "Set DATABASE_URL in the root .env (local default postgresql://postgres:postgres@127.0.0.1:54322/postgres) to enable the clustering lab.",
      status: "not_enabled",
    };
  }
  try {
    const rows = await db.read`
      select to_regclass('public.storylines') is not null as clustering,
             to_regclass('public.experiment_runs') is not null as runs
    `;
    if (rows[0]?.clustering !== true) {
      return {
        experimentsEnabled: false,
        reason:
          "Clustering migrations are not applied to this database. Run pnpm supabase db reset (local) or supabase db push.",
        status: "not_enabled",
      };
    }
    if (rows[0]?.runs !== true) {
      return {
        experimentsEnabled: false,
        experimentsReason:
          "The experiment_runs migration (20260718100200) is not applied.",
        status: "available",
      };
    }
    if (databaseUrl === undefined || !isLocalDsn(databaseUrl)) {
      return {
        experimentsEnabled: false,
        experimentsReason:
          "Experiments only run against a local database — the pipeline bench tools structurally refuse remote DSNs.",
        status: "available",
      };
    }
    return { experimentsEnabled: true, status: "available" };
  } catch (error) {
    return {
      experimentsEnabled: false,
      reason: error instanceof Error ? error.message : "Database unreachable",
      status: "not_enabled",
    };
  }
}
```

In `apps/operator-console/src/config.ts`, extend the schema and both interfaces:

```ts
const OptionalConfigSchema = z.object({
  apiToken: z.string().min(32).optional(),
  apiUrl: z.string().transform(validateOperatorApiUrl).optional(),
  databaseUrl: z.string().trim().min(1).optional(),
  environment: z.string().trim().min(1).max(40).default("development"),
  workerName: z
    .string()
    .trim()
    .min(1)
    .max(120)
    .default("dot-gov-news-pipeline-dev"),
});

export interface OperatorConsoleConfig {
  apiToken?: string;
  apiUrl?: string;
  databaseUrl?: string;
  environment: string;
  workerName: string;
}
```

and in `loadOperatorConfig()` add `databaseUrl: process.env.DATABASE_URL,` to the parsed object.

- [ ] **Step 5: Run tests to verify they pass**

Run: `pnpm --filter @dot-gov-news/operator-console test -- lab-` and `pnpm --filter @dot-gov-news/operator-console typecheck`
Expected: PASS (10 tests), clean typecheck. Existing suites unaffected: `pnpm --filter @dot-gov-news/operator-console test`.

- [ ] **Step 6: Commit**

```bash
git add apps/operator-console/package.json pnpm-lock.yaml .env.example apps/operator-console/src/config.ts apps/operator-console/src/lab/vectors.ts apps/operator-console/src/lab/db.ts apps/operator-console/test/lab-vectors.test.ts apps/operator-console/test/lab-db.test.ts
git commit -m "feat: add clustering lab foundation (fp16 vectors, read pool, capability)

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 2: Lab contracts + read queries (clustering tables + experiment_runs)

Every wire shape as a zod schema, and every SQL read behind one class. The metrics module (Task 3), harness (Task 5), routes (Task 6), CLI (Task 7), and UI (Tasks 8–9) all consume exactly these.

**Files:**
- Create: `apps/operator-console/src/lab/contracts.ts`, `apps/operator-console/src/lab/queries.ts`
- Test: `apps/operator-console/test/lab-contracts.test.ts`, `apps/operator-console/test/lab-queries.integration.test.ts`, `apps/operator-console/test/fixtures/lab-fixture.sql`

**Interfaces:**
- Produces (contracts — exact exported names):
  - `LabCapabilitySchema` `{ status: "available"|"not_enabled", reason?, experimentsEnabled: boolean, experimentsReason? }`
  - `CorpusSummarySchema` `{ entries, sources, firstPublishedAt: string|null, lastPublishedAt: string|null, embedded, enriched, extracted, clustered, needsPrepare, agencies: { agency: string, entries: number }[] }` — `needsPrepare` = `embedding is null and published_at is not null` count, the pipeline's own resume predicate for `prepare`.
  - `StorylineListItemSchema` `{ id, headline: string|null, episodeCount, entryCount, distinctFeeds, agencies: string[], entities: string[], eventKeys: string[], firstEntryAt, newestEntryAt }`
  - `EntryEvidenceSchema` `{ id, title: string|null, url, agency, publishedAt: string|null, attachMethod, similarity: number|null, thresholdUsed: number|null, isSyndicated, matchedEntryId: string|null, entitySet: string[], eventKeys: string[] }`
  - `EventCardSchema` `{ id, kind: "overview"|"episode", version, headline, summary, timeline: { episodeId: string|null, date: string, text: string, cited: boolean }[]|null, rubric: Record<string, unknown>|null, interestReason: string|null, rankKey, supersededBy: string|null, judgeModel: string|null, generatedAt }`
  - `EpisodeDetailSchema` `{ id, status: "open"|"dormant", attachMethod, attachSimilarity: number|null, attachReason: string|null, adjudicatorModel: string|null, entryCount, firstEntryAt, newestEntryAt, entitySet: string[], eventKeys: string[], entries: EntryEvidence[], card: EventCard|null }`
  - `StorylineDetailSchema` `{ …StorylineListItem, episodes: EpisodeDetail[], overviewCards: EventCard[] }` (overview cards newest-version first)
  - `BorderlinePairSchema` `{ entryId, entryTitle: string|null, matchedEntryId: string|null, matchedTitle: string|null, attachMethod, similarity, thresholdUsed }`
  - `ExperimentSummarySchema` — **loose** object mirroring `pipeline/experiment.py::summarize()` snake_case keys verbatim: `{ entries_clustered, episodes, storylines, cards, entry_attach_mix: Record<string, number>, episode_attach_mix: Record<string, number>, singleton_episode_rate: number|null, multi_episode_storylines, top_chains: { episodes: number, headline: string }[] }` (`z.looseObject` so future summarize() additions don't break parsing).
  - `ExperimentRunSchema` `{ id, name, startedAt, finishedAt, durationSeconds, createdAt, cacheHits, cacheMisses, config: Record<string, unknown>|null, clusterReport: { processed: number, episodes_closed: number }|null (loose), summary: ExperimentSummary|null }`
  - `labResponse<T>(schema)` → `z.object({ data: schema })` envelope; inferred TS types exported for each schema.
- Produces (queries): `class LabQueries { constructor(sql: postgres.Sql) }` with methods (all return contract types):
  - `corpusSummary(): Promise<CorpusSummary>`
  - `storylines(filter: { agency?; entity?; limit?; minEpisodes? }): Promise<StorylineListItem[]>` (default limit 50, `merged_into is null`, newest first)
  - `storylineDetail(id: string): Promise<StorylineDetail | null>`
  - `volume(): Promise<{ cards; entries; episodes; multiEpisodeStorylines; storylines }>`
  - `attachMix()`, `storylineAttachMix()`, `similarityByMethod()`, `entriesPerEpisode()`, `episodesPerStoryline()`, `syndicationRate()`, `contentHashPairCosines()`, `topChains(limit?)`, `borderlinePairs(window?, limit?)` — clustering audit reads (shapes as in revision 1)
  - `experimentRuns(limit = 50): Promise<ExperimentRun[]>` — newest first; `durationSeconds = round(finished - started, 1)`
  - `experimentRun(id: string): Promise<ExperimentRun | null>`
- Agency facet derived as `split_part(ns.canonical_url, '/', 3)` (same rule as the pipeline Store).
- Timeline bullets validated against member episode ids at read time: `cited = timeline.episode_id ∈ storyline's episode ids` — the dashboard's hallucination-guard QA surface.

- [ ] **Step 1: Write the failing contract tests**

```ts
// apps/operator-console/test/lab-contracts.test.ts
import { describe, expect, it } from "vitest";

import {
  BorderlinePairSchema,
  CorpusSummarySchema,
  EventCardSchema,
  ExperimentRunSchema,
  StorylineDetailSchema,
  StorylineListItemSchema,
  labResponse,
} from "../src/lab/contracts";

describe("lab contracts", () => {
  it("parses a corpus summary with prepare coverage", () => {
    const parsed = CorpusSummarySchema.parse({
      agencies: [{ agency: "fda.gov", entries: 120 }],
      clustered: 100,
      embedded: 120,
      enriched: 110,
      entries: 130,
      extracted: 130,
      firstPublishedAt: "2026-01-02T00:00:00.000Z",
      lastPublishedAt: "2026-07-01T00:00:00.000Z",
      needsPrepare: 10,
      sources: 20,
    });
    expect(parsed.needsPrepare).toBe(10);
  });

  it("parses a storyline list item and detail with cited timeline", () => {
    const item = StorylineListItemSchema.parse({
      agencies: ["fda.gov"],
      distinctFeeds: 2,
      entities: ["valsatrex"],
      entryCount: 5,
      episodeCount: 2,
      eventKeys: ["z-2026-0143"],
      firstEntryAt: "2026-05-14T14:00:00.000Z",
      headline: "FDA recalls Valsatrex",
      id: "00000000-0000-4000-8000-000000000021",
      newestEntryAt: "2026-05-17T15:00:00.000Z",
    });
    const detail = StorylineDetailSchema.parse({
      ...item,
      episodes: [
        {
          adjudicatorModel: null,
          attachMethod: "new_storyline",
          attachReason: null,
          attachSimilarity: null,
          card: null,
          entitySet: ["valsatrex"],
          entries: [
            {
              agency: "fda.gov",
              attachMethod: "new_cluster",
              entitySet: ["valsatrex"],
              eventKeys: [],
              id: "00000000-0000-4000-8000-000000000011",
              isSyndicated: false,
              matchedEntryId: null,
              publishedAt: "2026-05-14T14:00:00.000Z",
              similarity: null,
              thresholdUsed: null,
              title: "FDA recalls Valsatrex",
              url: "https://fda.gov/a",
            },
          ],
          entryCount: 1,
          eventKeys: [],
          firstEntryAt: "2026-05-14T14:00:00.000Z",
          id: "00000000-0000-4000-8000-000000000031",
          newestEntryAt: "2026-05-14T14:00:00.000Z",
          status: "dormant",
        },
      ],
      overviewCards: [
        EventCardSchema.parse({
          generatedAt: "2026-05-17T15:00:00.000Z",
          headline: "Valsatrex recall chain",
          id: "00000000-0000-4000-8000-000000000042",
          interestReason: null,
          judgeModel: "stub",
          kind: "overview",
          rankKey: 5.2,
          rubric: { urgency: 1 },
          summary: "Recall then expansion.",
          supersededBy: null,
          timeline: [
            {
              cited: true,
              date: "2026-05-14",
              episodeId: "00000000-0000-4000-8000-000000000031",
              text: "Recall announced",
            },
          ],
          version: 2,
        }),
      ],
    });
    expect(detail.overviewCards[0].timeline?.[0].cited).toBe(true);
  });

  it("parses an experiment run with pipeline-side snake_case payloads", () => {
    const run = ExperimentRunSchema.parse({
      cacheHits: 12,
      cacheMisses: 3,
      clusterReport: { episodes_closed: 420, processed: 1000 },
      config: { enrichment_enabled: true, near_dup_threshold: 0.9 },
      createdAt: "2026-07-18T12:00:05.000Z",
      durationSeconds: 42.5,
      finishedAt: "2026-07-18T12:00:42.500Z",
      id: "00000000-0000-4000-8000-0000000000a1",
      name: "baseline",
      startedAt: "2026-07-18T12:00:00.000Z",
      summary: {
        cards: 460,
        entries_clustered: 1000,
        entry_attach_mix: { content_hash: 40, new_cluster: 380 },
        episode_attach_mix: { new_storyline: 380 },
        episodes: 420,
        extra_future_key: "tolerated",
        multi_episode_storylines: 31,
        singleton_episode_rate: 0.62,
        storylines: 380,
        top_chains: [{ episodes: 4, headline: "Valsatrex recall widens" }],
      },
    });
    expect(run.summary?.entry_attach_mix.content_hash).toBe(40);
    expect(run.durationSeconds).toBe(42.5);
  });

  it("wraps payloads in the data envelope", () => {
    const parsed = labResponse(BorderlinePairSchema.array()).parse({
      data: [
        {
          attachMethod: "near_dup",
          entryId: "a",
          entryTitle: "t",
          matchedEntryId: "b",
          matchedTitle: "t2",
          similarity: 0.905,
          thresholdUsed: 0.9,
        },
      ],
    });
    expect(parsed.data).toHaveLength(1);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `pnpm --filter @dot-gov-news/operator-console test -- lab-contracts`
Expected: FAIL — cannot resolve `../src/lab/contracts`.

- [ ] **Step 3: Implement the contracts**

```ts
// apps/operator-console/src/lab/contracts.ts
import { z } from "zod";

export const LabCapabilitySchema = z.object({
  experimentsEnabled: z.boolean(),
  experimentsReason: z.string().optional(),
  reason: z.string().optional(),
  status: z.enum(["available", "not_enabled"]),
});

export const CorpusSummarySchema = z.object({
  agencies: z.array(z.object({ agency: z.string(), entries: z.number() })),
  clustered: z.number(),
  embedded: z.number(),
  enriched: z.number(),
  entries: z.number(),
  extracted: z.number(),
  firstPublishedAt: z.string().nullable(),
  lastPublishedAt: z.string().nullable(),
  needsPrepare: z.number(),
  sources: z.number(),
});

export const StorylineListItemSchema = z.object({
  agencies: z.array(z.string()),
  distinctFeeds: z.number(),
  entities: z.array(z.string()),
  entryCount: z.number(),
  episodeCount: z.number(),
  eventKeys: z.array(z.string()),
  firstEntryAt: z.string(),
  headline: z.string().nullable(),
  id: z.string(),
  newestEntryAt: z.string(),
});

export const EntryEvidenceSchema = z.object({
  agency: z.string(),
  attachMethod: z.string(),
  entitySet: z.array(z.string()),
  eventKeys: z.array(z.string()),
  id: z.string(),
  isSyndicated: z.boolean(),
  matchedEntryId: z.string().nullable(),
  publishedAt: z.string().nullable(),
  similarity: z.number().nullable(),
  thresholdUsed: z.number().nullable(),
  title: z.string().nullable(),
  url: z.string(),
});

export const EventCardSchema = z.object({
  generatedAt: z.string(),
  headline: z.string(),
  id: z.string(),
  interestReason: z.string().nullable(),
  judgeModel: z.string().nullable(),
  kind: z.enum(["overview", "episode"]),
  rankKey: z.number(),
  rubric: z.record(z.string(), z.unknown()).nullable(),
  summary: z.string(),
  supersededBy: z.string().nullable(),
  timeline: z
    .array(
      z.object({
        cited: z.boolean(),
        date: z.string(),
        episodeId: z.string().nullable(),
        text: z.string(),
      }),
    )
    .nullable(),
  version: z.number(),
});

export const EpisodeDetailSchema = z.object({
  adjudicatorModel: z.string().nullable(),
  attachMethod: z.string(),
  attachReason: z.string().nullable(),
  attachSimilarity: z.number().nullable(),
  card: EventCardSchema.nullable(),
  entitySet: z.array(z.string()),
  entries: z.array(EntryEvidenceSchema),
  entryCount: z.number(),
  eventKeys: z.array(z.string()),
  firstEntryAt: z.string(),
  id: z.string(),
  newestEntryAt: z.string(),
  status: z.enum(["open", "dormant"]),
});

export const StorylineDetailSchema = StorylineListItemSchema.extend({
  episodes: z.array(EpisodeDetailSchema),
  overviewCards: z.array(EventCardSchema),
});

export const BorderlinePairSchema = z.object({
  attachMethod: z.string(),
  entryId: z.string(),
  entryTitle: z.string().nullable(),
  matchedEntryId: z.string().nullable(),
  matchedTitle: z.string().nullable(),
  similarity: z.number(),
  thresholdUsed: z.number(),
});

// pipeline/experiment.py::summarize() output, snake_case verbatim; loose so
// future summarize() additions never break the dashboard.
export const ExperimentSummarySchema = z.looseObject({
  cards: z.number(),
  entries_clustered: z.number(),
  entry_attach_mix: z.record(z.string(), z.number()),
  episode_attach_mix: z.record(z.string(), z.number()),
  episodes: z.number(),
  multi_episode_storylines: z.number(),
  singleton_episode_rate: z.number().nullable(),
  storylines: z.number(),
  top_chains: z.array(
    z.object({ episodes: z.number(), headline: z.string() }),
  ),
});

export const ExperimentRunSchema = z.object({
  cacheHits: z.number(),
  cacheMisses: z.number(),
  clusterReport: z
    .looseObject({ episodes_closed: z.number(), processed: z.number() })
    .nullable(),
  config: z.record(z.string(), z.unknown()).nullable(),
  createdAt: z.string(),
  durationSeconds: z.number(),
  finishedAt: z.string(),
  id: z.string(),
  name: z.string(),
  startedAt: z.string(),
  summary: ExperimentSummarySchema.nullable(),
});

export function labResponse<T extends z.ZodType>(schema: T) {
  return z.object({ data: schema });
}

export type LabCapability = z.infer<typeof LabCapabilitySchema>;
export type CorpusSummary = z.infer<typeof CorpusSummarySchema>;
export type StorylineListItem = z.infer<typeof StorylineListItemSchema>;
export type EntryEvidence = z.infer<typeof EntryEvidenceSchema>;
export type EventCard = z.infer<typeof EventCardSchema>;
export type EpisodeDetail = z.infer<typeof EpisodeDetailSchema>;
export type StorylineDetail = z.infer<typeof StorylineDetailSchema>;
export type BorderlinePair = z.infer<typeof BorderlinePairSchema>;
export type ExperimentSummary = z.infer<typeof ExperimentSummarySchema>;
export type ExperimentRun = z.infer<typeof ExperimentRunSchema>;
```

Note: the `LabCapability` type moves here from `db.ts` conceptually — have `db.ts` import the type from `contracts.ts` (`import type { LabCapability } from "./contracts"`) instead of declaring its own, so there is exactly one definition. (Task 1 shipped a local interface; replace it in this task.)

Run `pnpm --filter @dot-gov-news/operator-console test -- lab-contracts` — PASS (4 tests).

- [ ] **Step 4: Write the DB fixture and the gated integration test**

The fixture is the revision-1 clustering fixture (sources, four entries — one with `embedding` null for `needsPrepare`, storylines, episodes, junction rows with audit columns, episode + overview cards with one uncited timeline bullet) **plus two experiment_runs rows**. Full file:

```sql
-- apps/operator-console/test/fixtures/lab-fixture.sql
-- Deterministic clustering + run-history state for LabQueries integration tests.
-- Applied inside a transaction by the test; never committed to the DB.
insert into public.news_sources (id, canonical_url, source_type, title) values
  ('00000000-0000-4000-8000-000000000001', 'https://fda.gov/press.xml', 'rss', 'FDA Press'),
  ('00000000-0000-4000-8000-000000000002', 'https://hhs.gov/news.xml', 'rss', 'HHS News');

-- fp16 embeddings: '\x003c003c' = [1,1]; '\x003c0000' = [1,0]
insert into public.news_entries
  (id, news_source_id, url, url_canonical, title, summary, published_at, content_hash,
   embedding, embedding_model, entity_set, event_keys, extractor_version) values
  ('00000000-0000-4000-8000-000000000011', '00000000-0000-4000-8000-000000000001',
   'https://fda.gov/a', 'https://fda.gov/a', 'FDA recalls Valsatrex', 'Sundexo recall.',
   '2026-05-14T14:00:00Z', repeat('ab', 32), '\x003c003c', 'stub', array['valsatrex'], array['z-2026-0143'], 1),
  ('00000000-0000-4000-8000-000000000012', '00000000-0000-4000-8000-000000000002',
   'https://hhs.gov/b', 'https://hhs.gov/b', 'HHS on Valsatrex', 'Sundexo recall.',
   '2026-05-14T16:00:00Z', repeat('ab', 32), '\x003c003c', 'stub', array['valsatrex'], '{}', 1),
  ('00000000-0000-4000-8000-000000000013', '00000000-0000-4000-8000-000000000001',
   'https://fda.gov/c', 'https://fda.gov/c', 'FDA expands Valsatrex recall', 'All lots.',
   '2026-05-17T15:00:00Z', repeat('cd', 32), '\x003c0000', 'stub', array['valsatrex'], array['z-2026-0143'], 1),
  ('00000000-0000-4000-8000-000000000014', '00000000-0000-4000-8000-000000000001',
   'https://fda.gov/d', 'https://fda.gov/d', 'SSA opens field office', 'Tulsa office.',
   '2026-05-18T09:00:00Z', repeat('ef', 32), null, null, array['tulsa'], '{}', 1);

insert into public.storylines
  (id, entity_set, event_keys, agency_ids, distinct_feeds, entry_count, episode_count,
   first_entry_at, newest_entry_at) values
  ('00000000-0000-4000-8000-000000000021', array['valsatrex'], array['z-2026-0143'],
   array['fda.gov', 'hhs.gov'], 2, 3, 2, '2026-05-14T14:00:00Z', '2026-05-17T15:00:00Z'),
  ('00000000-0000-4000-8000-000000000022', array['tulsa'], '{}', array['fda.gov'], 1, 1, 1,
   '2026-05-18T09:00:00Z', '2026-05-18T09:00:00Z');

insert into public.episodes
  (id, storyline_id, status, entity_set, event_keys, entry_count,
   first_entry_at, newest_entry_at, attach_method, attach_similarity, attach_reason) values
  ('00000000-0000-4000-8000-000000000031', '00000000-0000-4000-8000-000000000021', 'dormant',
   array['valsatrex'], array['z-2026-0143'], 2, '2026-05-14T14:00:00Z', '2026-05-14T16:00:00Z',
   'new_storyline', null, null),
  ('00000000-0000-4000-8000-000000000032', '00000000-0000-4000-8000-000000000021', 'dormant',
   array['valsatrex'], array['z-2026-0143'], 1, '2026-05-17T15:00:00Z', '2026-05-17T15:00:00Z',
   'event_key', 0.82, 'shared recall number'),
  ('00000000-0000-4000-8000-000000000033', '00000000-0000-4000-8000-000000000022', 'open',
   array['tulsa'], '{}', 1, '2026-05-18T09:00:00Z', '2026-05-18T09:00:00Z',
   'new_storyline', null, null);

insert into public.episode_entries
  (episode_id, entry_id, is_syndicated, attach_method, similarity, matched_entry_id,
   threshold_used, embedding_model) values
  ('00000000-0000-4000-8000-000000000031', '00000000-0000-4000-8000-000000000011',
   false, 'new_cluster', null, null, null, 'stub'),
  ('00000000-0000-4000-8000-000000000031', '00000000-0000-4000-8000-000000000012',
   true, 'content_hash', 0.91, '00000000-0000-4000-8000-000000000011', 0.90, 'stub'),
  ('00000000-0000-4000-8000-000000000032', '00000000-0000-4000-8000-000000000013',
   false, 'near_dup', 0.915, '00000000-0000-4000-8000-000000000011', 0.90, 'stub'),
  ('00000000-0000-4000-8000-000000000033', '00000000-0000-4000-8000-000000000014',
   false, 'new_cluster', null, null, null, 'stub');

update public.news_entries set episode_id = '00000000-0000-4000-8000-000000000031'
  where id in ('00000000-0000-4000-8000-000000000011', '00000000-0000-4000-8000-000000000012');
update public.news_entries set episode_id = '00000000-0000-4000-8000-000000000032'
  where id = '00000000-0000-4000-8000-000000000013';
update public.news_entries set episode_id = '00000000-0000-4000-8000-000000000033'
  where id = '00000000-0000-4000-8000-000000000014';

insert into public.event_cards
  (id, storyline_id, episode_id, kind, version, headline, summary, timeline,
   newest_entry_at, rank_key, superseded_by, judge_model) values
  ('00000000-0000-4000-8000-000000000041', '00000000-0000-4000-8000-000000000021',
   '00000000-0000-4000-8000-000000000031', 'episode', 1, 'FDA recalls Valsatrex',
   'Recall pulse.', null, '2026-05-14T16:00:00Z', 4.1, null, 'stub'),
  ('00000000-0000-4000-8000-000000000042', '00000000-0000-4000-8000-000000000021',
   '00000000-0000-4000-8000-000000000032', 'episode', 1, 'FDA expands Valsatrex recall',
   'Expansion pulse.', null, '2026-05-17T15:00:00Z', 4.3, null, 'stub'),
  ('00000000-0000-4000-8000-000000000043', '00000000-0000-4000-8000-000000000021',
   null, 'overview', 1, 'Valsatrex recall', 'First cut.',
   '[{"episode_id": "00000000-0000-4000-8000-000000000031", "date": "2026-05-14", "text": "Recall announced"}]',
   '2026-05-14T16:00:00Z', 4.5, '00000000-0000-4000-8000-000000000044', 'stub'),
  ('00000000-0000-4000-8000-000000000044', '00000000-0000-4000-8000-000000000021',
   null, 'overview', 2, 'Valsatrex recall chain', 'Recall then expansion.',
   '[{"episode_id": "00000000-0000-4000-8000-000000000031", "date": "2026-05-14", "text": "Recall announced"},
     {"episode_id": "00000000-0000-4000-8000-000000000032", "date": "2026-05-17", "text": "Recall expanded"},
     {"episode_id": "99999999-9999-4999-8999-999999999999", "date": "2026-05-18", "text": "Uncited claim"}]',
   '2026-05-17T15:00:00Z', 5.2, null, 'stub');

update public.storylines set latest_card_id = '00000000-0000-4000-8000-000000000044'
  where id = '00000000-0000-4000-8000-000000000021';

insert into public.experiment_runs
  (id, name, started_at, finished_at, config, cluster_report, summary,
   cache_hits, cache_misses, created_at) values
  ('00000000-0000-4000-8000-0000000000a1', 'baseline',
   '2026-07-18T10:00:00Z', '2026-07-18T10:00:42Z',
   '{"near_dup_threshold": 0.9, "enrichment_enabled": true}',
   '{"processed": 4, "episodes_closed": 3}',
   '{"entries_clustered": 4, "episodes": 3, "storylines": 2, "cards": 4,
     "entry_attach_mix": {"new_cluster": 2, "content_hash": 1, "near_dup": 1},
     "episode_attach_mix": {"new_storyline": 2, "event_key": 1},
     "singleton_episode_rate": 0.667, "multi_episode_storylines": 1,
     "top_chains": [{"episodes": 2, "headline": "Valsatrex recall chain"}]}',
   0, 2, '2026-07-18T10:00:43Z'),
  ('00000000-0000-4000-8000-0000000000a2', 'near-dup-0.87',
   '2026-07-18T11:00:00Z', '2026-07-18T11:00:21Z',
   '{"near_dup_threshold": 0.87, "enrichment_enabled": true}',
   '{"processed": 4, "episodes_closed": 3}',
   '{"entries_clustered": 4, "episodes": 3, "storylines": 2, "cards": 4,
     "entry_attach_mix": {"new_cluster": 2, "content_hash": 1, "near_dup": 1},
     "episode_attach_mix": {"new_storyline": 2, "event_key": 1},
     "singleton_episode_rate": 0.667, "multi_episode_storylines": 1,
     "top_chains": [{"episodes": 2, "headline": "Valsatrex recall chain"}]}',
   2, 0, '2026-07-18T11:00:22Z');
```

```ts
// apps/operator-console/test/lab-queries.integration.test.ts
/** DB-backed LabQueries tests.
 *
 * Gated: needs a running local Supabase with all migrations applied
 * (including 20260718100200_create_experiment_runs).
 *   pnpm supabase start && pnpm supabase db reset
 *   LAB_DB_TESTS=1 pnpm --filter @dot-gov-news/operator-console test -- lab-queries
 * The fixture is applied inside a transaction and rolled back after each test.
 */
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import postgres from "postgres";
import { afterAll, describe, expect, it } from "vitest";

import { LabQueries } from "../src/lab/queries";

const enabled = process.env.LAB_DB_TESTS === "1";
const dsn =
  process.env.DATABASE_URL ??
  "postgresql://postgres:postgres@127.0.0.1:54322/postgres";
const fixture = readFileSync(
  resolve(import.meta.dirname, "fixtures/lab-fixture.sql"),
  "utf8",
);

const sql = enabled ? postgres(dsn, { max: 1, prepare: false }) : null;

afterAll(async () => {
  await sql?.end({ timeout: 5 });
});

async function withFixture<T>(
  run: (queries: LabQueries) => Promise<T>,
): Promise<T> {
  if (sql === null) throw new Error("gated");
  return sql.begin(async (tx) => {
    await tx.unsafe(fixture);
    const result = await run(new LabQueries(tx as unknown as postgres.Sql));
    throw Object.assign(new Error("rollback"), { result });
  }).catch((error: Error & { result?: T }) => {
    if (error.message === "rollback" && "result" in error)
      return error.result as T;
    throw error;
  });
}

describe.skipIf(!enabled)("LabQueries against local Supabase", () => {
  it("summarizes the corpus with feature and prepare coverage", async () => {
    const summary = await withFixture((queries) => queries.corpusSummary());
    expect(summary.entries).toBe(4);
    expect(summary.embedded).toBe(3);
    expect(summary.needsPrepare).toBe(1);
    expect(summary.clustered).toBe(4);
    expect(summary.agencies[0].agency).toBe("fda.gov");
  });

  it("lists storylines newest-first with headline and filters", async () => {
    const all = await withFixture((queries) => queries.storylines({}));
    expect(all).toHaveLength(2);
    // newest_entry_at desc: the Tulsa storyline (2026-05-18, no card) sorts first
    expect(all.map((item) => item.headline)).toEqual([
      null,
      "Valsatrex recall chain",
    ]);
    const chains = await withFixture((queries) =>
      queries.storylines({ minEpisodes: 2 }),
    );
    expect(chains).toHaveLength(1);
    const byEntity = await withFixture((queries) =>
      queries.storylines({ entity: "tulsa" }),
    );
    expect(byEntity).toHaveLength(1);
  });

  it("returns the full chain with attach evidence and citation flags", async () => {
    const detail = await withFixture((queries) =>
      queries.storylineDetail("00000000-0000-4000-8000-000000000021"),
    );
    expect(detail).not.toBeNull();
    expect(detail?.episodes).toHaveLength(2);
    expect(detail?.episodes[0].entries).toHaveLength(2);
    expect(detail?.episodes[0].card?.headline).toBe("FDA recalls Valsatrex");
    expect(detail?.episodes[1].attachMethod).toBe("event_key");
    const latest = detail?.overviewCards[0];
    expect(latest?.version).toBe(2);
    expect(latest?.timeline?.map((item) => item.cited)).toEqual([
      true,
      true,
      false,
    ]);
    expect(
      await withFixture((queries) =>
        queries.storylineDetail("00000000-0000-4000-8000-00000000dead"),
      ),
    ).toBeNull();
  });

  it("computes attach mix, shapes, syndication, and calibration inputs", async () => {
    const mix = await withFixture((queries) => queries.attachMix());
    expect(mix.find((row) => row.method === "content_hash")?.count).toBe(1);
    const singleton = await withFixture((queries) =>
      queries.entriesPerEpisode(),
    );
    expect(singleton.sort()).toEqual([1, 1, 2]);
    const syndication = await withFixture((queries) =>
      queries.syndicationRate(),
    );
    expect(syndication).toBeCloseTo(0.25, 5);
    const cosines = await withFixture((queries) =>
      queries.contentHashPairCosines(),
    );
    expect(cosines).toHaveLength(1);
    expect(cosines[0]).toBeCloseTo(1, 5);
    const borderline = await withFixture((queries) =>
      queries.borderlinePairs(0.03, 10),
    );
    expect(borderline.map((pair) => pair.attachMethod).sort()).toEqual([
      "content_hash",
      "near_dup",
    ]);
  });

  it("reads experiment runs newest-first with parsed payloads", async () => {
    const runs = await withFixture((queries) => queries.experimentRuns());
    expect(runs.map((run) => run.name)).toEqual(["near-dup-0.87", "baseline"]);
    expect(runs[0].durationSeconds).toBeCloseTo(21, 1);
    expect(runs[0].cacheHits).toBe(2);
    expect(runs[0].config?.near_dup_threshold).toBe(0.87);
    expect(runs[1].summary?.multi_episode_storylines).toBe(1);
    const single = await withFixture((queries) =>
      queries.experimentRun("00000000-0000-4000-8000-0000000000a1"),
    );
    expect(single?.name).toBe("baseline");
    expect(
      await withFixture((queries) =>
        queries.experimentRun("00000000-0000-4000-8000-00000000dead"),
      ),
    ).toBeNull();
  });
});
```

- [ ] **Step 5: Run the gated test to verify it fails**

Run: `pnpm supabase start` (if not running), `pnpm supabase db reset`, then
`LAB_DB_TESTS=1 pnpm --filter @dot-gov-news/operator-console test -- lab-queries`
Expected: FAIL — cannot resolve `../src/lab/queries`. (Without `LAB_DB_TESTS=1` the suite reports skipped — verify that too.)

- [ ] **Step 6: Implement the queries**

The clustering reads are identical to revision 1; new pieces are `needsPrepare` in `corpusSummary` and the two `experiment_runs` readers. Full file:

```ts
// apps/operator-console/src/lab/queries.ts
import type postgres from "postgres";

import {
  ExperimentRunSchema,
  ExperimentSummarySchema,
  type BorderlinePair,
  type CorpusSummary,
  type EntryEvidence,
  type EventCard,
  type ExperimentRun,
  type StorylineDetail,
  type StorylineListItem,
} from "./contracts";
import { cosine, unpackFp16 } from "./vectors";

const iso = (value: unknown): string | null =>
  value instanceof Date ? value.toISOString() : null;

interface CardRow {
  episode_id: string | null;
  generated_at: Date;
  headline: string;
  id: string;
  interest_reason: string | null;
  judge_model: string | null;
  kind: "overview" | "episode";
  rank_key: number;
  rubric: Record<string, unknown> | null;
  summary: string;
  superseded_by: string | null;
  timeline: { date?: string; episode_id?: string; text?: string }[] | null;
  version: number;
}

function toCard(row: CardRow, memberEpisodeIds: Set<string>): EventCard {
  return {
    generatedAt: row.generated_at.toISOString(),
    headline: row.headline,
    id: row.id,
    interestReason: row.interest_reason,
    judgeModel: row.judge_model,
    kind: row.kind,
    rankKey: Number(row.rank_key),
    rubric: row.rubric,
    summary: row.summary,
    supersededBy: row.superseded_by,
    timeline:
      row.timeline === null
        ? null
        : row.timeline.map((item) => ({
            cited:
              typeof item.episode_id === "string" &&
              memberEpisodeIds.has(item.episode_id),
            date: item.date ?? "",
            episodeId: item.episode_id ?? null,
            text: item.text ?? "",
          })),
    version: row.version,
  };
}

export class LabQueries {
  constructor(private readonly sql: postgres.Sql) {}

  async corpusSummary(): Promise<CorpusSummary> {
    const [row] = await this.sql`
      select
        (select count(*)::integer from public.news_entries) as entries,
        (select count(*)::integer from public.news_sources) as sources,
        (select min(published_at) from public.news_entries) as first_published_at,
        (select max(published_at) from public.news_entries) as last_published_at,
        (select count(*)::integer from public.news_entries where embedding is not null) as embedded,
        (select count(*)::integer from public.news_entries where enriched_text is not null) as enriched,
        (select count(*)::integer from public.news_entries where extractor_version is not null) as extracted,
        (select count(*)::integer from public.news_entries where episode_id is not null) as clustered,
        (select count(*)::integer from public.news_entries
          where embedding is null and published_at is not null) as needs_prepare
    `;
    const agencies = await this.sql`
      select split_part(ns.canonical_url, '/', 3) as agency, count(*)::integer as entries
      from public.news_entries ne
      join public.news_sources ns on ns.id = ne.news_source_id
      group by 1 order by 2 desc, 1 limit 50
    `;
    return {
      agencies: agencies.map((item) => ({
        agency: String(item.agency),
        entries: Number(item.entries),
      })),
      clustered: Number(row.clustered),
      embedded: Number(row.embedded),
      enriched: Number(row.enriched),
      entries: Number(row.entries),
      extracted: Number(row.extracted),
      firstPublishedAt: iso(row.first_published_at),
      lastPublishedAt: iso(row.last_published_at),
      needsPrepare: Number(row.needs_prepare),
      sources: Number(row.sources),
    };
  }

  async storylines(filter: {
    agency?: string;
    entity?: string;
    limit?: number;
    minEpisodes?: number;
  }): Promise<StorylineListItem[]> {
    const { sql } = this;
    const rows = await sql`
      select s.id, s.entity_set, s.event_keys, s.agency_ids, s.distinct_feeds,
             s.entry_count, s.episode_count, s.first_entry_at, s.newest_entry_at,
             c.headline
      from public.storylines s
      left join public.event_cards c on c.id = s.latest_card_id
      where s.merged_into is null
        ${filter.entity === undefined ? sql`` : sql`and ${filter.entity} = any(s.entity_set)`}
        ${filter.agency === undefined ? sql`` : sql`and ${filter.agency} = any(s.agency_ids)`}
        ${filter.minEpisodes === undefined ? sql`` : sql`and s.episode_count >= ${filter.minEpisodes}`}
      order by s.newest_entry_at desc, s.entry_count desc
      limit ${Math.min(filter.limit ?? 50, 500)}
    `;
    return rows.map((row) => ({
      agencies: row.agency_ids as string[],
      distinctFeeds: Number(row.distinct_feeds),
      entities: row.entity_set as string[],
      entryCount: Number(row.entry_count),
      episodeCount: Number(row.episode_count),
      eventKeys: row.event_keys as string[],
      firstEntryAt: (row.first_entry_at as Date).toISOString(),
      headline: (row.headline as string | null) ?? null,
      id: String(row.id),
      newestEntryAt: (row.newest_entry_at as Date).toISOString(),
    }));
  }

  async storylineDetail(id: string): Promise<StorylineDetail | null> {
    const [storyline] = await this.sql`
      select s.id, s.entity_set, s.event_keys, s.agency_ids, s.distinct_feeds,
             s.entry_count, s.episode_count, s.first_entry_at, s.newest_entry_at,
             c.headline
      from public.storylines s
      left join public.event_cards c on c.id = s.latest_card_id
      where s.id = ${id}
    `;
    if (storyline === undefined) return null;

    const episodes = await this.sql`
      select id, status, entity_set, event_keys, entry_count, first_entry_at,
             newest_entry_at, attach_method, attach_similarity, attach_reason,
             adjudicator_model
      from public.episodes where storyline_id = ${id}
      order by first_entry_at, id
    `;
    const memberIds = new Set(episodes.map((episode) => String(episode.id)));

    const entries = await this.sql`
      select ee.episode_id, ee.entry_id, ee.is_syndicated, ee.attach_method,
             ee.similarity, ee.matched_entry_id, ee.threshold_used,
             ne.title, ne.url, ne.published_at, ne.entity_set, ne.event_keys,
             split_part(ns.canonical_url, '/', 3) as agency
      from public.episode_entries ee
      join public.episodes ep on ep.id = ee.episode_id
      join public.news_entries ne on ne.id = ee.entry_id
      join public.news_sources ns on ns.id = ne.news_source_id
      where ep.storyline_id = ${id}
      order by ne.published_at, ne.id
    `;

    const cards = (await this.sql`
      select id, episode_id, kind, version, headline, summary, timeline, rubric,
             interest_reason, rank_key, superseded_by, judge_model, generated_at
      from public.event_cards where storyline_id = ${id}
      order by kind, version desc
    `) as unknown as CardRow[];

    const entriesByEpisode = new Map<string, EntryEvidence[]>();
    for (const row of entries) {
      const list = entriesByEpisode.get(String(row.episode_id)) ?? [];
      list.push({
        agency: String(row.agency),
        attachMethod: String(row.attach_method),
        entitySet: row.entity_set as string[],
        eventKeys: row.event_keys as string[],
        id: String(row.entry_id),
        isSyndicated: Boolean(row.is_syndicated),
        matchedEntryId:
          row.matched_entry_id === null ? null : String(row.matched_entry_id),
        publishedAt: iso(row.published_at),
        similarity: row.similarity === null ? null : Number(row.similarity),
        thresholdUsed:
          row.threshold_used === null ? null : Number(row.threshold_used),
        title: (row.title as string | null) ?? null,
        url: String(row.url),
      });
      entriesByEpisode.set(String(row.episode_id), list);
    }

    const episodeCards = new Map<string, EventCard>();
    const overviewCards: EventCard[] = [];
    for (const card of cards) {
      const shaped = toCard(card, memberIds);
      if (card.kind === "episode" && card.episode_id !== null) {
        episodeCards.set(String(card.episode_id), shaped);
      } else if (card.kind === "overview") {
        overviewCards.push(shaped);
      }
    }

    return {
      agencies: storyline.agency_ids as string[],
      distinctFeeds: Number(storyline.distinct_feeds),
      entities: storyline.entity_set as string[],
      entryCount: Number(storyline.entry_count),
      episodeCount: Number(storyline.episode_count),
      episodes: episodes.map((episode) => ({
        adjudicatorModel:
          episode.adjudicator_model === null
            ? null
            : String(episode.adjudicator_model),
        attachMethod: String(episode.attach_method),
        attachReason:
          episode.attach_reason === null ? null : String(episode.attach_reason),
        attachSimilarity:
          episode.attach_similarity === null
            ? null
            : Number(episode.attach_similarity),
        card: episodeCards.get(String(episode.id)) ?? null,
        entitySet: episode.entity_set as string[],
        entries: entriesByEpisode.get(String(episode.id)) ?? [],
        entryCount: Number(episode.entry_count),
        eventKeys: episode.event_keys as string[],
        firstEntryAt: (episode.first_entry_at as Date).toISOString(),
        id: String(episode.id),
        newestEntryAt: (episode.newest_entry_at as Date).toISOString(),
        status: episode.status as "open" | "dormant",
      })),
      eventKeys: storyline.event_keys as string[],
      firstEntryAt: (storyline.first_entry_at as Date).toISOString(),
      headline: (storyline.headline as string | null) ?? null,
      id: String(storyline.id),
      newestEntryAt: (storyline.newest_entry_at as Date).toISOString(),
      overviewCards,
    };
  }

  async volume() {
    const [row] = await this.sql`
      select
        (select count(*)::integer from public.news_entries) as entries,
        (select count(*)::integer from public.episodes) as episodes,
        (select count(*)::integer from public.storylines where merged_into is null) as storylines,
        (select count(*)::integer from public.event_cards) as cards,
        (select count(*)::integer from public.storylines
          where merged_into is null and episode_count >= 2) as multi
    `;
    return {
      cards: Number(row.cards),
      entries: Number(row.entries),
      episodes: Number(row.episodes),
      multiEpisodeStorylines: Number(row.multi),
      storylines: Number(row.storylines),
    };
  }

  async attachMix() {
    const rows = await this.sql`
      select attach_method, count(*)::integer as n,
             round(avg(similarity)::numeric, 3) as avg_sim
      from public.episode_entries group by 1 order by n desc
    `;
    return rows.map((row) => ({
      avgSimilarity: row.avg_sim === null ? null : Number(row.avg_sim),
      count: Number(row.n),
      method: String(row.attach_method),
    }));
  }

  async storylineAttachMix() {
    const rows = await this.sql`
      select attach_method, count(*)::integer as n
      from public.episodes group by 1 order by n desc
    `;
    return rows.map((row) => ({
      count: Number(row.n),
      method: String(row.attach_method),
    }));
  }

  async similarityByMethod(): Promise<{ method: string; values: number[] }[]> {
    const rows = await this.sql`
      select attach_method, array_agg(similarity) as sims
      from public.episode_entries where similarity is not null group by 1
    `;
    return rows.map((row) => ({
      method: String(row.attach_method),
      values: (row.sims as (number | string)[]).map(Number),
    }));
  }

  async entriesPerEpisode(): Promise<number[]> {
    const rows = await this.sql`select entry_count from public.episodes`;
    return rows.map((row) => Number(row.entry_count));
  }

  async episodesPerStoryline(): Promise<number[]> {
    const rows = await this.sql`
      select episode_count from public.storylines where merged_into is null
    `;
    return rows.map((row) => Number(row.episode_count));
  }

  async syndicationRate(): Promise<number | null> {
    const [row] = await this.sql`
      select round(avg(is_syndicated::int)::numeric, 4) as rate
      from public.episode_entries
    `;
    return row.rate === null ? null : Number(row.rate);
  }

  async contentHashPairCosines(): Promise<number[]> {
    const rows = await this.sql`
      select a.embedding as ea, b.embedding as eb
      from public.episode_entries ee
      join public.news_entries a on a.id = ee.entry_id
      join public.news_entries b on b.id = ee.matched_entry_id
      where ee.attach_method = 'content_hash'
        and a.embedding is not null and b.embedding is not null
      limit 10000
    `;
    return rows.map((row) =>
      cosine(
        unpackFp16(row.ea as Uint8Array),
        unpackFp16(row.eb as Uint8Array),
      ),
    );
  }

  async topChains(limit = 10) {
    const rows = await this.sql`
      select s.id, s.episode_count, s.entry_count, c.headline
      from public.storylines s
      left join public.event_cards c on c.id = s.latest_card_id
      where s.merged_into is null
      order by s.episode_count desc, s.entry_count desc
      limit ${limit}
    `;
    return rows.map((row) => ({
      entryCount: Number(row.entry_count),
      episodeCount: Number(row.episode_count),
      headline: (row.headline as string | null) ?? null,
      storylineId: String(row.id),
    }));
  }

  async borderlinePairs(window = 0.03, limit = 100): Promise<BorderlinePair[]> {
    const rows = await this.sql`
      select ee.entry_id, ee.matched_entry_id, ee.attach_method, ee.similarity,
             ee.threshold_used, a.title as entry_title, b.title as matched_title
      from public.episode_entries ee
      join public.news_entries a on a.id = ee.entry_id
      left join public.news_entries b on b.id = ee.matched_entry_id
      where ee.similarity is not null and ee.threshold_used is not null
        and abs(ee.similarity - ee.threshold_used) < ${window}
      order by abs(ee.similarity - ee.threshold_used)
      limit ${Math.min(limit, 1000)}
    `;
    return rows.map((row) => ({
      attachMethod: String(row.attach_method),
      entryId: String(row.entry_id),
      entryTitle: (row.entry_title as string | null) ?? null,
      matchedEntryId:
        row.matched_entry_id === null ? null : String(row.matched_entry_id),
      matchedTitle: (row.matched_title as string | null) ?? null,
      similarity: Number(row.similarity),
      thresholdUsed: Number(row.threshold_used),
    }));
  }

  // -- experiment_runs (run history; survives reset --clusters) ------------

  private shapeRun(row: Record<string, unknown>): ExperimentRun {
    const started = row.started_at as Date;
    const finished = row.finished_at as Date;
    return ExperimentRunSchema.parse({
      cacheHits: Number(row.cache_hits),
      cacheMisses: Number(row.cache_misses),
      clusterReport: row.cluster_report ?? null,
      config: (row.config as Record<string, unknown> | null) ?? null,
      createdAt: (row.created_at as Date).toISOString(),
      durationSeconds: Number(
        ((finished.getTime() - started.getTime()) / 1000).toFixed(1),
      ),
      finishedAt: finished.toISOString(),
      id: String(row.id),
      name: String(row.name),
      startedAt: started.toISOString(),
      summary:
        row.summary === null
          ? null
          : ExperimentSummarySchema.parse(row.summary),
    });
  }

  async experimentRuns(limit = 50): Promise<ExperimentRun[]> {
    const rows = await this.sql`
      select id, name, started_at, finished_at, config, cluster_report, summary,
             cache_hits, cache_misses, created_at
      from public.experiment_runs
      order by created_at desc
      limit ${Math.min(limit, 500)}
    `;
    return rows.map((row) => this.shapeRun(row));
  }

  async experimentRun(id: string): Promise<ExperimentRun | null> {
    const [row] = await this.sql`
      select id, name, started_at, finished_at, config, cluster_report, summary,
             cache_hits, cache_misses, created_at
      from public.experiment_runs where id = ${id}
    `;
    return row === undefined ? null : this.shapeRun(row);
  }
}
```

- [ ] **Step 7: Run tests to verify they pass**

Run: `LAB_DB_TESTS=1 pnpm --filter @dot-gov-news/operator-console test -- lab-queries` and `pnpm --filter @dot-gov-news/operator-console test`
Expected: PASS (5 integration tests, all unit suites green, integration skipped without the env var).

- [ ] **Step 8: Commit**

```bash
git add apps/operator-console/src/lab/contracts.ts apps/operator-console/src/lab/queries.ts apps/operator-console/src/lab/db.ts apps/operator-console/test/lab-contracts.test.ts apps/operator-console/test/lab-queries.integration.test.ts apps/operator-console/test/fixtures/lab-fixture.sql
git commit -m "feat: add clustering lab contracts and read queries incl experiment runs

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 3: Live metrics snapshot

One function that turns the audit trail into the metric set the live "Quality" section uses — the deep numbers `experiment_runs.summary` doesn't carry (similarity percentiles, dedupe calibration, shape histograms). Always describes the clustering tables as they stand = the latest run.

**Files:**
- Create: `apps/operator-console/src/lab/metrics.ts`
- Test: `apps/operator-console/test/lab-metrics.test.ts`

**Interfaces:**
- Consumes: `LabQueries` (Task 2), `percentiles`/`bucketHistogram` (Task 1).
- Produces:
  - `LabMetricsSchema` / `type LabMetrics`:
    `{ capturedAt: string, volume: { entries, episodes, storylines, cards, multiEpisodeStorylines }, attachMix: { method, count, avgSimilarity: number|null }[], storylineAttachMix: { method, count }[], similarity: { method: string, percentiles: Record<string, number> }[], singletonEpisodeRate: number|null, entriesPerEpisode: { bucket, count }[], episodesPerStoryline: { bucket, count }[], syndicationRate: number|null, calibration: { pairCount: number, percentiles: Record<string, number>, suggestedNearDupThreshold: number|null }, topChains: { storylineId, episodeCount, entryCount, headline: string|null }[] }`
  - `snapshotLabMetrics(queries: MetricQueries, now?: () => Date): Promise<LabMetrics>` — `suggestedNearDupThreshold = round(p5(contentHashPairCosines) - 0.02, 3)` (pipeline design amendment 5), null when no pairs.
  - `MetricQueries = Pick<LabQueries, "attachMix" | "contentHashPairCosines" | "entriesPerEpisode" | "episodesPerStoryline" | "similarityByMethod" | "storylineAttachMix" | "syndicationRate" | "topChains" | "volume">` so tests inject a plain object fake.

- [ ] **Step 1: Write the failing test**

```ts
// apps/operator-console/test/lab-metrics.test.ts
import { describe, expect, it } from "vitest";

import { LabMetricsSchema, snapshotLabMetrics } from "../src/lab/metrics";

const fakeQueries = {
  attachMix: async () => [
    { avgSimilarity: 0.91, count: 3, method: "near_dup" },
    { avgSimilarity: null, count: 5, method: "new_cluster" },
  ],
  contentHashPairCosines: async () => [0.95, 0.94, 0.99, 0.97, 0.96],
  entriesPerEpisode: async () => [1, 1, 2, 4, 12],
  episodesPerStoryline: async () => [1, 1, 2],
  similarityByMethod: async () => [
    { method: "near_dup", values: [0.9, 0.92, 0.95] },
  ],
  storylineAttachMix: async () => [{ count: 3, method: "new_storyline" }],
  syndicationRate: async () => 0.25,
  topChains: async () => [
    {
      entryCount: 6,
      episodeCount: 2,
      headline: "Valsatrex recall chain",
      storylineId: "s1",
    },
  ],
  volume: async () => ({
    cards: 4,
    entries: 20,
    episodes: 5,
    multiEpisodeStorylines: 1,
    storylines: 3,
  }),
};

describe("snapshotLabMetrics", () => {
  it("assembles a schema-valid snapshot with calibration suggestion", async () => {
    const metrics = await snapshotLabMetrics(
      fakeQueries,
      () => new Date("2026-07-18T12:00:00Z"),
    );
    expect(LabMetricsSchema.parse(metrics)).toBeTruthy();
    expect(metrics.capturedAt).toBe("2026-07-18T12:00:00.000Z");
    expect(metrics.singletonEpisodeRate).toBeCloseTo(0.4, 5);
    expect(metrics.entriesPerEpisode).toContainEqual({ bucket: 10, count: 1 });
    // p5 of [0.94..0.99] sorted = 0.942 -> minus 0.02 -> 0.922
    expect(metrics.calibration.suggestedNearDupThreshold).toBeCloseTo(
      0.922,
      3,
    );
    expect(metrics.calibration.pairCount).toBe(5);
    expect(metrics.similarity[0].percentiles.p50).toBe(0.92);
  });

  it("handles an empty database without NaNs", async () => {
    const metrics = await snapshotLabMetrics({
      ...fakeQueries,
      attachMix: async () => [],
      contentHashPairCosines: async () => [],
      entriesPerEpisode: async () => [],
      episodesPerStoryline: async () => [],
      similarityByMethod: async () => [],
      storylineAttachMix: async () => [],
      syndicationRate: async () => null,
      topChains: async () => [],
      volume: async () => ({
        cards: 0,
        entries: 0,
        episodes: 0,
        multiEpisodeStorylines: 0,
        storylines: 0,
      }),
    });
    expect(metrics.singletonEpisodeRate).toBeNull();
    expect(metrics.calibration.suggestedNearDupThreshold).toBeNull();
    expect(LabMetricsSchema.parse(metrics)).toBeTruthy();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @dot-gov-news/operator-console test -- lab-metrics`
Expected: FAIL — cannot resolve `../src/lab/metrics`.

- [ ] **Step 3: Implement**

```ts
// apps/operator-console/src/lab/metrics.ts
import { z } from "zod";

import type { LabQueries } from "./queries";
import { bucketHistogram, percentiles } from "./vectors";

const BucketSchema = z.object({ bucket: z.number(), count: z.number() });

export const LabMetricsSchema = z.object({
  attachMix: z.array(
    z.object({
      avgSimilarity: z.number().nullable(),
      count: z.number(),
      method: z.string(),
    }),
  ),
  calibration: z.object({
    pairCount: z.number(),
    percentiles: z.record(z.string(), z.number()),
    suggestedNearDupThreshold: z.number().nullable(),
  }),
  capturedAt: z.string(),
  entriesPerEpisode: z.array(BucketSchema),
  episodesPerStoryline: z.array(BucketSchema),
  similarity: z.array(
    z.object({
      method: z.string(),
      percentiles: z.record(z.string(), z.number()),
    }),
  ),
  singletonEpisodeRate: z.number().nullable(),
  storylineAttachMix: z.array(
    z.object({ count: z.number(), method: z.string() }),
  ),
  syndicationRate: z.number().nullable(),
  topChains: z.array(
    z.object({
      entryCount: z.number(),
      episodeCount: z.number(),
      headline: z.string().nullable(),
      storylineId: z.string(),
    }),
  ),
  volume: z.object({
    cards: z.number(),
    entries: z.number(),
    episodes: z.number(),
    multiEpisodeStorylines: z.number(),
    storylines: z.number(),
  }),
});

export type LabMetrics = z.infer<typeof LabMetricsSchema>;

export type MetricQueries = Pick<
  LabQueries,
  | "attachMix"
  | "contentHashPairCosines"
  | "entriesPerEpisode"
  | "episodesPerStoryline"
  | "similarityByMethod"
  | "storylineAttachMix"
  | "syndicationRate"
  | "topChains"
  | "volume"
>;

export async function snapshotLabMetrics(
  queries: MetricQueries,
  now: () => Date = () => new Date(),
): Promise<LabMetrics> {
  const [
    volume,
    attachMix,
    storylineAttachMix,
    similarity,
    entryCounts,
    episodeCounts,
    syndicationRate,
    pairCosines,
    topChains,
  ] = await Promise.all([
    queries.volume(),
    queries.attachMix(),
    queries.storylineAttachMix(),
    queries.similarityByMethod(),
    queries.entriesPerEpisode(),
    queries.episodesPerStoryline(),
    queries.syndicationRate(),
    queries.contentHashPairCosines(),
    queries.topChains(),
  ]);

  const pairPercentiles = percentiles(pairCosines);
  return {
    attachMix,
    calibration: {
      pairCount: pairCosines.length,
      percentiles: pairPercentiles,
      suggestedNearDupThreshold:
        pairCosines.length === 0
          ? null
          : Number((pairPercentiles.p5 - 0.02).toFixed(3)),
    },
    capturedAt: now().toISOString(),
    entriesPerEpisode: bucketHistogram(entryCounts, 10),
    episodesPerStoryline: bucketHistogram(episodeCounts, 10),
    similarity: similarity.map((row) => ({
      method: row.method,
      percentiles: percentiles(row.values),
    })),
    singletonEpisodeRate:
      entryCounts.length === 0
        ? null
        : Number(
            (
              entryCounts.filter((count) => count === 1).length /
              entryCounts.length
            ).toFixed(4),
          ),
    storylineAttachMix,
    syndicationRate,
    topChains,
    volume,
  };
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `pnpm --filter @dot-gov-news/operator-console test -- lab-metrics`
Expected: PASS (2 tests).

- [ ] **Step 5: Commit**

```bash
git add apps/operator-console/src/lab/metrics.ts apps/operator-console/test/lab-metrics.test.ts
git commit -m "feat: add live clustering quality snapshot

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 4: Corpus label store

Ground-truth labels in `docs/eval/labels.csv` — the exact CSV contract the deferred eval harness (`eval --labels`) will consume. Collection-only for now (design decision 8).

**Files:**
- Create: `apps/operator-console/src/lab/labels.ts`
- Test: `apps/operator-console/test/lab-labels.test.ts`

**Interfaces:**
- Produces `class LabelStore { constructor(rootDir: string) }` with:
  - `labelsPath: string` (absolute, `<rootDir>/labels.csv`)
  - `appendLabel(row: { entryA: string; entryB: string; sameEvent: boolean }): Promise<void>` — creates the file with header `entry_a,entry_b,same_event` on first write, appends `y`/`n` rows
  - `readLabels(): Promise<{ entryA: string; entryB: string; sameEvent: boolean }[]>` (empty array when the file doesn't exist)

- [ ] **Step 1: Write the failing test**

```ts
// apps/operator-console/test/lab-labels.test.ts
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { LabelStore } from "../src/lab/labels";

let root: string | undefined;

afterEach(async () => {
  if (root !== undefined) await rm(root, { force: true, recursive: true });
  root = undefined;
});

describe("LabelStore", () => {
  it("appends labels in the eval CSV contract", async () => {
    root = await mkdtemp(join(tmpdir(), "lab-"));
    const store = new LabelStore(root);
    await store.appendLabel({ entryA: "a", entryB: "b", sameEvent: true });
    await store.appendLabel({ entryA: "c", entryB: "d", sameEvent: false });
    const csv = await readFile(store.labelsPath, "utf8");
    expect(csv).toBe("entry_a,entry_b,same_event\na,b,y\nc,d,n\n");
    expect(await store.readLabels()).toEqual([
      { entryA: "a", entryB: "b", sameEvent: true },
      { entryA: "c", entryB: "d", sameEvent: false },
    ]);
  });

  it("reads empty when no labels exist", async () => {
    root = await mkdtemp(join(tmpdir(), "lab-"));
    expect(await new LabelStore(root).readLabels()).toEqual([]);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @dot-gov-news/operator-console test -- lab-labels`
Expected: FAIL — cannot resolve `../src/lab/labels`.

- [ ] **Step 3: Implement**

```ts
// apps/operator-console/src/lab/labels.ts
import { appendFile, readFile } from "node:fs/promises";
import { join } from "node:path";

/** Corpus-level ground-truth labels (docs/eval/labels.csv).
 *
 * Same CSV contract the pipeline eval harness will consume via --labels:
 * header entry_a,entry_b,same_event with y/n verdicts. Labels describe entry
 * pairs, so they survive experiment resets and apply to every run.
 */
export class LabelStore {
  readonly labelsPath: string;

  constructor(rootDir: string) {
    this.labelsPath = join(rootDir, "labels.csv");
  }

  async appendLabel(row: {
    entryA: string;
    entryB: string;
    sameEvent: boolean;
  }): Promise<void> {
    let needsHeader = false;
    try {
      await readFile(this.labelsPath, "utf8");
    } catch {
      needsHeader = true;
    }
    const line = `${row.entryA},${row.entryB},${row.sameEvent ? "y" : "n"}\n`;
    await appendFile(
      this.labelsPath,
      needsHeader ? `entry_a,entry_b,same_event\n${line}` : line,
    );
  }

  async readLabels(): Promise<
    { entryA: string; entryB: string; sameEvent: boolean }[]
  > {
    try {
      const raw = await readFile(this.labelsPath, "utf8");
      return raw
        .trim()
        .split("\n")
        .slice(1)
        .filter((line) => line.length > 0)
        .map((line) => {
          const [entryA, entryB, sameEvent] = line.split(",");
          return { entryA, entryB, sameEvent: sameEvent === "y" };
        });
    } catch {
      return [];
    }
  }
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `pnpm --filter @dot-gov-news/operator-console test -- lab-labels`
Expected: PASS (2 tests).

- [ ] **Step 5: Commit**

```bash
git add apps/operator-console/src/lab/labels.ts apps/operator-console/test/lab-labels.test.ts
git commit -m "feat: add corpus label store for clustering qa

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 5: Experiment run harness

Stage sequencing over the **pipeline experiment CLI** with an injectable process spawner. At most three stages: `reset-features` (only for feature-level A/Bs) → `prepare` (auto-included when `needsPrepare > 0`, forced after a feature reset) → `experiment` (the pipeline command that resets clusters, replays, writes the report, and inserts the `experiment_runs` row). The harness parses the `experiment` stage's final stdout JSON line to learn the `run_id`/report path.

**Files:**
- Create: `apps/operator-console/src/lab/harness.ts`
- Test: `apps/operator-console/test/lab-harness.test.ts`

**Interfaces:**
- Consumes: `needsPrepare` count (injected as a function; server wires it to `queries.corpusSummary()`).
- Produces:
  - `LAB_ENV_WHITELIST: readonly string[]` — exactly the 15 pipeline Config env keys from design decision 7 (including `AMBIENT_EMA_CEILING`).
  - `type RunRequest = { clearFeatures?: boolean; env?: Record<string, string>; limit?: number | null; name: string; noCache?: boolean; prepare?: boolean; stub?: boolean; until?: string | null }` — `prepare` undefined = auto (include when `needsPrepare() > 0`); `clearFeatures` implies both `reset-features` and `prepare`.
  - `type StageName = "reset-features" | "prepare" | "experiment"`; `interface RunStage { detail?: string; name: StageName; status: "pending" | "running" | "succeeded" | "failed" | "skipped" }`
  - `interface ActiveRun { name: string; stages: RunStage[]; startedAt: string; stub: boolean }`
  - `type RunEvent = { line: string; type: "log" } | { stage: RunStage; type: "stage" } | { reportPath: string | null; runId: string | null; status: "failed" | "succeeded"; type: "done" }`
  - `type StageSpawner = (command: string, args: string[], env: Record<string, string>, onLine: (line: string) => void) => Promise<number>` (resolves with the exit code)
  - `class ExperimentHarness { constructor(deps: { needsPrepare: () => Promise<number>; spawnStage: StageSpawner }) }` with `active: ActiveRun | null`, `onEvent(listener: (event: RunEvent) => void): () => void`, and `start(request: RunRequest, now?: () => Date): Promise<ActiveRun>` — validates the name (`/^[a-z0-9][a-z0-9._-]{0,63}$/i` — it becomes the report directory) and env keys (throws `LabValidationError`), throws `LabRunActiveError` when a run is active, then executes stages **in the background** (start resolves with the ActiveRun immediately; callers stream events). Any stage failure marks it `failed`, remaining stages `skipped`, done event `failed`.
  - `class LabRunActiveError extends Error`, `class LabValidationError extends Error`.
  - `defaultSpawner(cwd: string): StageSpawner` — `node:child_process` spawn, merges `process.env` under the stage env, forwards stdout+stderr lines.
- Stage commands (exact — these are the experiment CLI's real subcommands):
  - reset-features: `uv run python -m pipeline.cli reset --features`
  - prepare: `uv run python -m pipeline.cli prepare [--stub]` (env overrides apply — `ENRICHMENT_ENABLED`/`ENRICHER_MODEL`/`EMBEDDING_MODEL` are prepare-time knobs)
  - experiment: `uv run python -m pipeline.cli experiment <name> [--stub] [--limit N] [--until ISO] [--no-cache]` (env overrides apply)
- Failed runs insert **no** `experiment_runs` row (the pipeline records only completed runs) — the done event's `runId: null` plus stage `failed` is the UI's failure record.

- [ ] **Step 1: Write the failing test**

```ts
// apps/operator-console/test/lab-harness.test.ts
import { describe, expect, it } from "vitest";

import {
  ExperimentHarness,
  LabRunActiveError,
  LabValidationError,
  type RunEvent,
} from "../src/lab/harness";

interface SpawnCall {
  args: string[];
  command: string;
  env: Record<string, string>;
}

function build(options: { exitCodes?: number[]; needsPrepare?: number } = {}) {
  const calls: SpawnCall[] = [];
  const harness = new ExperimentHarness({
    needsPrepare: async () => options.needsPrepare ?? 0,
    spawnStage: async (command, args, env, onLine) => {
      calls.push({ args, command, env });
      // small delay so "run already active" checks race deterministically
      await new Promise((resolve) => setTimeout(resolve, 5));
      if (args.includes("experiment")) {
        onLine("stage log line");
        onLine('{"report": "docs/eval/baseline/report.md", "run_id": "run-123"}');
      } else {
        onLine(`${args.join(" ")}`);
      }
      return options.exitCodes?.[calls.length - 1] ?? 0;
    },
  });
  return { calls, harness };
}

async function waitForDone(
  harness: ExperimentHarness,
): Promise<{ events: RunEvent[]; done: Extract<RunEvent, { type: "done" }> }> {
  return new Promise((resolve) => {
    const events: RunEvent[] = [];
    harness.onEvent((event) => {
      events.push(event);
      if (event.type === "done") resolve({ done: event, events });
    });
  });
}

describe("ExperimentHarness", () => {
  it("runs experiment-only when features are prepared, parsing the run id", async () => {
    const { calls, harness } = build({ needsPrepare: 0 });
    const finished = waitForDone(harness);
    const active = await harness.start({
      env: { NEAR_DUP_THRESHOLD: "0.87" },
      limit: 1000,
      name: "baseline",
      stub: true,
    });
    expect(active.stages.map((stage) => stage.name)).toEqual(["experiment"]);
    const { done } = await finished;
    expect(done.status).toBe("succeeded");
    expect(done.runId).toBe("run-123");
    expect(done.reportPath).toBe("docs/eval/baseline/report.md");
    expect(calls).toHaveLength(1);
    expect(calls[0].command).toBe("uv");
    expect(calls[0].args).toEqual([
      "run",
      "python",
      "-m",
      "pipeline.cli",
      "experiment",
      "baseline",
      "--stub",
      "--limit",
      "1000",
    ]);
    expect(calls[0].env.NEAR_DUP_THRESHOLD).toBe("0.87");
    expect(harness.active).toBeNull();
  });

  it("auto-includes prepare when features are missing, and reset-features when asked", async () => {
    const withPrepare = build({ needsPrepare: 5 });
    let finished = waitForDone(withPrepare.harness);
    const active = await withPrepare.harness.start({ name: "auto", stub: true });
    expect(active.stages.map((stage) => stage.name)).toEqual([
      "prepare",
      "experiment",
    ]);
    await finished;
    expect(withPrepare.calls[0].args).toEqual([
      "run",
      "python",
      "-m",
      "pipeline.cli",
      "prepare",
      "--stub",
    ]);

    const withReset = build({ needsPrepare: 0 });
    finished = waitForDone(withReset.harness);
    const cleared = await withReset.harness.start({
      clearFeatures: true,
      env: { ENRICHMENT_ENABLED: "false" },
      name: "no-enrich",
      stub: true,
    });
    expect(cleared.stages.map((stage) => stage.name)).toEqual([
      "reset-features",
      "prepare",
      "experiment",
    ]);
    await finished;
    expect(withReset.calls[0].args).toEqual([
      "run",
      "python",
      "-m",
      "pipeline.cli",
      "reset",
      "--features",
    ]);
    expect(withReset.calls[1].env.ENRICHMENT_ENABLED).toBe("false");
  });

  it("marks failure, skips downstream stages, and reports no run id", async () => {
    const { harness } = build({ exitCodes: [1], needsPrepare: 5 });
    const finished = waitForDone(harness);
    await harness.start({ name: "boom", stub: true });
    const { done, events } = await finished;
    expect(done.status).toBe("failed");
    expect(done.runId).toBeNull();
    const stageEvents = events
      .filter(
        (event): event is Extract<RunEvent, { type: "stage" }> =>
          event.type === "stage",
      )
      .map((event) => `${event.stage.name}:${event.stage.status}`);
    expect(stageEvents).toContain("prepare:failed");
    expect(stageEvents).toContain("experiment:skipped");
  });

  it("rejects bad names, unknown env keys, and concurrent runs", async () => {
    const { harness } = build();
    await expect(
      harness.start({ name: "../escape" }),
    ).rejects.toBeInstanceOf(LabValidationError);
    await expect(
      harness.start({ env: { NOT_A_KEY: "1" }, name: "bad" }),
    ).rejects.toBeInstanceOf(LabValidationError);
    const finished = waitForDone(harness);
    await harness.start({ name: "first", stub: true });
    await expect(harness.start({ name: "second" })).rejects.toBeInstanceOf(
      LabRunActiveError,
    );
    await finished;
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @dot-gov-news/operator-console test -- lab-harness`
Expected: FAIL — cannot resolve `../src/lab/harness`.

- [ ] **Step 3: Implement**

```ts
// apps/operator-console/src/lab/harness.ts
import { spawn } from "node:child_process";

export const LAB_ENV_WHITELIST = [
  "ADJUDICATOR_MODEL",
  "AMBIENT_EMA_CEILING",
  "CLUSTER_JOIN_THRESHOLD",
  "DEDUPE_WINDOW_HOURS",
  "EMBEDDING_MODEL",
  "ENRICHER_MODEL",
  "ENRICHER_VERSION",
  "ENRICHMENT_ENABLED",
  "EPISODE_DORMANCY_HOURS",
  "JUDGE_MODEL",
  "NEAR_DUP_THRESHOLD",
  "PROMPT_VERSION",
  "RUBRIC_VERSION",
  "STORYLINE_SIM_FLOOR",
  "TAU_SECONDS",
] as const;

const NAME_PATTERN = /^[a-z0-9][a-z0-9._-]{0,63}$/i;

export type StageName = "reset-features" | "prepare" | "experiment";

export interface RunStage {
  detail?: string;
  name: StageName;
  status: "pending" | "running" | "succeeded" | "failed" | "skipped";
}

export interface ActiveRun {
  name: string;
  stages: RunStage[];
  startedAt: string;
  stub: boolean;
}

export interface RunRequest {
  clearFeatures?: boolean;
  env?: Record<string, string>;
  limit?: number | null;
  name: string;
  noCache?: boolean;
  prepare?: boolean;
  stub?: boolean;
  until?: string | null;
}

export type RunEvent =
  | { line: string; type: "log" }
  | { stage: RunStage; type: "stage" }
  | {
      reportPath: string | null;
      runId: string | null;
      status: "failed" | "succeeded";
      type: "done";
    };

export type StageSpawner = (
  command: string,
  args: string[],
  env: Record<string, string>,
  onLine: (line: string) => void,
) => Promise<number>;

export class LabRunActiveError extends Error {
  constructor(readonly activeName: string) {
    super(`experiment "${activeName}" is already running`);
    this.name = "LabRunActiveError";
  }
}

export class LabValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "LabValidationError";
  }
}

export class ExperimentHarness {
  active: ActiveRun | null = null;
  private readonly listeners = new Set<(event: RunEvent) => void>();

  constructor(
    private readonly deps: {
      needsPrepare: () => Promise<number>;
      spawnStage: StageSpawner;
    },
  ) {}

  onEvent(listener: (event: RunEvent) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  private emit(event: RunEvent): void {
    for (const listener of this.listeners) listener(event);
  }

  async start(
    request: RunRequest,
    now: () => Date = () => new Date(),
  ): Promise<ActiveRun> {
    if (!NAME_PATTERN.test(request.name)) {
      throw new LabValidationError(
        "experiment name must be alphanumeric with . _ - (it becomes the report directory)",
      );
    }
    const env = request.env ?? {};
    const whitelist = new Set<string>(LAB_ENV_WHITELIST);
    for (const key of Object.keys(env)) {
      if (!whitelist.has(key)) {
        throw new LabValidationError(
          `unknown pipeline env override: ${key} (allowed: ${LAB_ENV_WHITELIST.join(", ")})`,
        );
      }
    }
    if (this.active !== null) throw new LabRunActiveError(this.active.name);

    const includePrepare =
      request.clearFeatures === true ||
      (request.prepare ?? (await this.deps.needsPrepare()) > 0);
    const stageNames: StageName[] = [
      ...(request.clearFeatures ? (["reset-features"] as const) : []),
      ...(includePrepare ? (["prepare"] as const) : []),
      "experiment",
    ];
    const active: ActiveRun = {
      name: request.name,
      stages: stageNames.map((name) => ({ name, status: "pending" })),
      startedAt: now().toISOString(),
      stub: request.stub ?? false,
    };
    this.active = active;
    void this.execute(active, request, env).finally(() => {
      this.active = null;
    });
    return active;
  }

  private stageArgs(
    stage: StageName,
    request: RunRequest,
  ): { args: string[]; env: boolean } {
    const base = ["run", "python", "-m", "pipeline.cli"];
    if (stage === "reset-features") {
      return { args: [...base, "reset", "--features"], env: false };
    }
    if (stage === "prepare") {
      return {
        args: [...base, "prepare", ...(request.stub ? ["--stub"] : [])],
        env: true,
      };
    }
    return {
      args: [
        ...base,
        "experiment",
        request.name,
        ...(request.stub ? ["--stub"] : []),
        ...(request.limit != null ? ["--limit", String(request.limit)] : []),
        ...(request.until != null ? ["--until", request.until] : []),
        ...(request.noCache ? ["--no-cache"] : []),
      ],
      env: true,
    };
  }

  private async execute(
    active: ActiveRun,
    request: RunRequest,
    env: Record<string, string>,
  ): Promise<void> {
    let failed = false;
    let runId: string | null = null;
    let reportPath: string | null = null;

    for (const stage of active.stages) {
      if (failed) {
        stage.status = "skipped";
        this.emit({ stage: { ...stage }, type: "stage" });
        continue;
      }
      stage.status = "running";
      this.emit({ stage: { ...stage }, type: "stage" });

      const { args, env: passEnv } = this.stageArgs(stage.name, request);
      let lastJson: { report?: string; run_id?: string } | null = null;
      try {
        const exitCode = await this.deps.spawnStage(
          "uv",
          args,
          passEnv ? env : {},
          (line) => {
            this.emit({ line, type: "log" });
            if (stage.name === "experiment") {
              try {
                const parsed = JSON.parse(line) as {
                  report?: string;
                  run_id?: string;
                };
                if (parsed.run_id !== undefined) lastJson = parsed;
              } catch {
                // not a JSON line; ignore
              }
            }
          },
        );
        if (exitCode !== 0) {
          throw new Error(`${stage.name} exited with code ${exitCode}`);
        }
        stage.status = "succeeded";
        if (stage.name === "experiment" && lastJson !== null) {
          runId = (lastJson as { run_id?: string }).run_id ?? null;
          reportPath = (lastJson as { report?: string }).report ?? null;
        }
      } catch (error) {
        failed = true;
        stage.status = "failed";
        stage.detail =
          error instanceof Error ? error.message : "stage failed";
      }
      this.emit({ stage: { ...stage }, type: "stage" });
    }

    this.emit({
      reportPath,
      runId,
      status: failed ? "failed" : "succeeded",
      type: "done",
    });
  }
}

export function defaultSpawner(cwd: string): StageSpawner {
  return (command, args, env, onLine) =>
    new Promise((resolve, reject) => {
      const child = spawn(command, args, {
        cwd,
        env: { ...process.env, ...env },
        stdio: ["ignore", "pipe", "pipe"],
      });
      const forward = (chunk: Buffer): void => {
        for (const line of chunk.toString().split("\n")) {
          if (line.trim().length > 0) onLine(line);
        }
      };
      child.stdout.on("data", forward);
      child.stderr.on("data", forward);
      child.once("error", reject);
      child.once("close", (code) => resolve(code ?? 1));
    });
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `pnpm --filter @dot-gov-news/operator-console test -- lab-harness`
Expected: PASS (4 tests).

- [ ] **Step 5: Commit**

```bash
git add apps/operator-console/src/lab/harness.ts apps/operator-console/test/lab-harness.test.ts
git commit -m "feat: add experiment harness over the pipeline cli

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 6: `/api/lab` routes + server wiring

**Files:**
- Create: `apps/operator-console/src/lab/routes.ts`
- Modify: `apps/operator-console/src/server.ts`
- Test: `apps/operator-console/test/lab-routes.test.ts`

**Interfaces:**
- Produces `createLabRouter(deps: LabRouteDeps): express.Router` where

  ```ts
  interface LabRouteDeps {
    capability: () => Promise<LabCapability>;
    harness: ExperimentHarness | null;
    labels: LabelStore;
    queries: LabQueries | null;
    repoRoot: string;
  }
  ```

  Routes (all JSON `{ data: … }` on success, `{ error: { code, message } }` on failure):
  - `GET /capability` → `LabCapability` (always 200)
  - `GET /corpus`, `GET /metrics`, `GET /storylines?entity&agency&minEpisodes&limit`, `GET /storylines/:id` (404 `not_found` on unknown id / non-uuid), `GET /borderline?window&limit` — all 503 `not_enabled` (message = capability reason) when reads are unavailable
  - `GET /labels` → `{ labels, count }`; `POST /labels` body `{ entryA: uuid, entryB: uuid, sameEvent: boolean }` (zod-validated, 400 `invalid_request` otherwise)
  - `GET /experiments` → `{ active: ActiveRun|null, items: ExperimentRun[] }` (read-gated; `active` from the harness, `items` from `experiment_runs`)
  - `GET /experiments/:id` → `{ run: ExperimentRun, reportAvailable: boolean }` (404 on unknown)
  - `GET /experiments/:id/report` → the run's `docs/eval/<name>/report.md` as `text/markdown` (404 when the file is missing; run name re-validated against the harness name pattern before any path join)
  - `POST /experiments` body `RunRequest`-shaped → 202 with the `ActiveRun`; 409 `run_active`; 400 `invalid_request` (bad name/env/body); 503 `not_enabled` with `experimentsReason` when `experimentsEnabled` is false or no harness
  - `GET /experiments/stream` — SSE for the (single) active run: emits `snapshot` (current `ActiveRun` or null) once, then forwards `stage`/`log`/`done` events; client disconnect unsubscribes
- Server wiring in `startDashboard`: build `labDb = config.databaseUrl ? createLabDb(config.databaseUrl) : null`, `labQueries = labDb ? new LabQueries(labDb.read) : null`, `labLabels = new LabelStore(resolve(repositoryRoot, "docs/eval"))`, and `labHarness = labQueries !== null && config.databaseUrl !== undefined && isLocalDsn(config.databaseUrl) ? new ExperimentHarness({ needsPrepare: () => labQueries.corpusSummary().then((s) => s.needsPrepare), spawnStage: defaultSpawner(repositoryRoot) }) : null`; mount `app.use("/api/lab", createLabRouter({ capability: () => labCapability(labDb, config.databaseUrl), harness: labHarness, labels: labLabels, queries: labQueries, repoRoot: repositoryRoot }))` **after** the session guard and before the vite/static middleware; `await labDb?.close()` inside `close()`. The lab endpoints inherit the loopback + host/origin + session-cookie boundary for free.

- [ ] **Step 1: Write the failing test**

```ts
// apps/operator-console/test/lab-routes.test.ts
import express from "express";
import { createServer, type Server } from "node:http";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import type { LabCapability } from "../src/lab/contracts";
import { ExperimentHarness } from "../src/lab/harness";
import { LabelStore } from "../src/lab/labels";
import { createLabRouter, type LabRouteDeps } from "../src/lab/routes";

let server: Server | undefined;
let root: string | undefined;

afterEach(async () => {
  await new Promise<void>((resolve) => server?.close(() => resolve()));
  server = undefined;
  if (root !== undefined) await rm(root, { force: true, recursive: true });
  root = undefined;
});

const NOT_ENABLED: LabCapability = {
  experimentsEnabled: false,
  reason: "Set DATABASE_URL",
  status: "not_enabled",
};

const RUN_ROW = {
  cacheHits: 2,
  cacheMisses: 0,
  clusterReport: { episodes_closed: 3, processed: 4 },
  config: { near_dup_threshold: 0.87 },
  createdAt: "2026-07-18T11:00:22.000Z",
  durationSeconds: 21,
  finishedAt: "2026-07-18T11:00:21.000Z",
  id: "00000000-0000-4000-8000-0000000000a2",
  name: "near-dup-0.87",
  startedAt: "2026-07-18T11:00:00.000Z",
  summary: null,
};

async function listen(deps: Partial<LabRouteDeps>): Promise<string> {
  root = await mkdtemp(join(tmpdir(), "lab-"));
  const app = express();
  app.use(
    "/api/lab",
    createLabRouter({
      capability: async () => NOT_ENABLED,
      harness: null,
      labels: new LabelStore(root),
      queries: null,
      repoRoot: root,
      ...deps,
    }),
  );
  server = createServer(app);
  await new Promise<void>((resolve) =>
    server?.listen(0, "127.0.0.1", resolve),
  );
  const address = server?.address();
  const port = typeof address === "object" && address ? address.port : 0;
  return `http://127.0.0.1:${port}/api/lab`;
}

describe("lab routes", () => {
  it("always answers capability and gates reads behind not_enabled", async () => {
    const base = await listen({});
    const capability = await fetch(`${base}/capability`);
    expect(capability.status).toBe(200);
    expect(await capability.json()).toEqual({ data: NOT_ENABLED });
    const corpus = await fetch(`${base}/corpus`);
    expect(corpus.status).toBe(503);
    const body = (await corpus.json()) as {
      error: { code: string; message: string };
    };
    expect(body.error.code).toBe("not_enabled");
  });

  it("serves reads and run history when queries are available", async () => {
    const summary = {
      agencies: [],
      clustered: 0,
      embedded: 0,
      enriched: 0,
      entries: 12,
      extracted: 12,
      firstPublishedAt: null,
      lastPublishedAt: null,
      needsPrepare: 12,
      sources: 3,
    };
    const base = await listen({
      capability: async () => ({
        experimentsEnabled: true,
        status: "available",
      }),
      queries: {
        borderlinePairs: async () => [],
        corpusSummary: async () => summary,
        experimentRun: async () => null,
        experimentRuns: async () => [RUN_ROW],
        storylineDetail: async () => null,
        storylines: async () => [],
      } as never,
    });
    const corpus = await fetch(`${base}/corpus`);
    expect(corpus.status).toBe(200);
    expect(((await corpus.json()) as { data: unknown }).data).toEqual(summary);

    const experiments = await fetch(`${base}/experiments`);
    const payload = (await experiments.json()) as {
      data: { active: unknown; items: { name: string }[] };
    };
    expect(payload.data.active).toBeNull();
    expect(payload.data.items[0].name).toBe("near-dup-0.87");

    const missingRun = await fetch(`${base}/experiments/nope`);
    expect(missingRun.status).toBe(404);
    const missingStoryline = await fetch(
      `${base}/storylines/00000000-0000-4000-8000-00000000dead`,
    );
    expect(missingStoryline.status).toBe(404);
  });

  it("validates and appends labels", async () => {
    const base = await listen({});
    const bad = await fetch(`${base}/labels`, {
      body: JSON.stringify({ entryA: "x" }),
      headers: { "content-type": "application/json" },
      method: "POST",
    });
    expect(bad.status).toBe(400);
    const good = await fetch(`${base}/labels`, {
      body: JSON.stringify({
        entryA: "00000000-0000-4000-8000-000000000011",
        entryB: "00000000-0000-4000-8000-000000000012",
        sameEvent: true,
      }),
      headers: { "content-type": "application/json" },
      method: "POST",
    });
    expect(good.status).toBe(201);
    const labels = await fetch(`${base}/labels`);
    expect(
      ((await labels.json()) as { data: { count: number } }).data.count,
    ).toBe(1);
  });

  it("starts runs only when experiments are enabled", async () => {
    const disabled = await listen({
      capability: async () => ({
        experimentsEnabled: false,
        experimentsReason: "remote DSN",
        status: "available",
      }),
      harness: null,
      queries: { experimentRuns: async () => [] } as never,
    });
    const refused = await fetch(`${disabled}/experiments`, {
      body: JSON.stringify({ name: "x" }),
      headers: { "content-type": "application/json" },
      method: "POST",
    });
    expect(refused.status).toBe(503);
    expect(
      ((await refused.json()) as { error: { message: string } }).error.message,
    ).toContain("remote DSN");

    const harness = new ExperimentHarness({
      needsPrepare: async () => 0,
      spawnStage: async (_c, _a, _e, onLine) => {
        onLine('{"report": "docs/eval/ok/report.md", "run_id": "run-1"}');
        return 0;
      },
    });
    const enabled = await listen({
      capability: async () => ({
        experimentsEnabled: true,
        status: "available",
      }),
      harness,
      queries: { experimentRuns: async () => [] } as never,
    });
    const accepted = await fetch(`${enabled}/experiments`, {
      body: JSON.stringify({ name: "ok", stub: true }),
      headers: { "content-type": "application/json" },
      method: "POST",
    });
    expect(accepted.status).toBe(202);
    const body = (await accepted.json()) as {
      data: { name: string; stages: { name: string }[] };
    };
    expect(body.data.name).toBe("ok");
    expect(body.data.stages.at(-1)?.name).toBe("experiment");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @dot-gov-news/operator-console test -- lab-routes`
Expected: FAIL — cannot resolve `../src/lab/routes`.

- [ ] **Step 3: Implement the router**

```ts
// apps/operator-console/src/lab/routes.ts
import express, { type Request, type Response, Router } from "express";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { z } from "zod";

import type { LabCapability } from "./contracts";
import {
  LabRunActiveError,
  LabValidationError,
  type ExperimentHarness,
} from "./harness";
import type { LabelStore } from "./labels";
import type { LabQueries } from "./queries";

export interface LabRouteDeps {
  capability: () => Promise<LabCapability>;
  harness: ExperimentHarness | null;
  labels: LabelStore;
  queries: LabQueries | null;
  repoRoot: string;
}

const UUID = z.uuid();
const REPORT_NAME = /^[a-z0-9][a-z0-9._-]{0,63}$/i;

const LabelBodySchema = z.object({
  entryA: z.uuid(),
  entryB: z.uuid(),
  sameEvent: z.boolean(),
});

const RunBodySchema = z.object({
  clearFeatures: z.boolean().optional(),
  env: z.record(z.string(), z.string()).optional(),
  limit: z.number().int().min(1).max(1_000_000).nullable().optional(),
  name: z.string().trim().min(1).max(64),
  noCache: z.boolean().optional(),
  prepare: z.boolean().optional(),
  stub: z.boolean().optional(),
  until: z.string().max(64).nullable().optional(),
});

function sendError(
  response: Response,
  status: number,
  code: string,
  message: string,
): void {
  response.status(status).json({ error: { code, message } });
}

export function createLabRouter(deps: LabRouteDeps): Router {
  const router = Router();
  router.use(express.json({ limit: "64kb" }));

  const requireQueries = async (
    response: Response,
  ): Promise<LabQueries | null> => {
    const capability = await deps.capability();
    if (deps.queries !== null && capability.status === "available") {
      return deps.queries;
    }
    sendError(
      response,
      503,
      "not_enabled",
      capability.reason ?? "Clustering lab is not enabled",
    );
    return null;
  };

  const handle =
    (run: (request: Request, response: Response) => Promise<void>) =>
    (request: Request, response: Response): void => {
      void run(request, response).catch((error: unknown) => {
        if (!response.headersSent) {
          sendError(
            response,
            500,
            "lab_error",
            error instanceof Error ? error.message : "Unexpected lab failure",
          );
        }
      });
    };

  router.get(
    "/capability",
    handle(async (_request, response) => {
      response.json({ data: await deps.capability() });
    }),
  );

  router.get(
    "/corpus",
    handle(async (_request, response) => {
      const queries = await requireQueries(response);
      if (queries === null) return;
      response.json({ data: await queries.corpusSummary() });
    }),
  );

  router.get(
    "/metrics",
    handle(async (_request, response) => {
      const queries = await requireQueries(response);
      if (queries === null) return;
      const { snapshotLabMetrics } = await import("./metrics");
      response.json({ data: await snapshotLabMetrics(queries) });
    }),
  );

  router.get(
    "/storylines",
    handle(async (request, response) => {
      const queries = await requireQueries(response);
      if (queries === null) return;
      const asString = (value: unknown): string | undefined =>
        typeof value === "string" && value.length > 0 ? value : undefined;
      const asNumber = (value: unknown): number | undefined => {
        const parsed = Number(asString(value));
        return Number.isFinite(parsed) ? parsed : undefined;
      };
      response.json({
        data: {
          items: await queries.storylines({
            agency: asString(request.query.agency),
            entity: asString(request.query.entity),
            limit: asNumber(request.query.limit),
            minEpisodes: asNumber(request.query.minEpisodes),
          }),
        },
      });
    }),
  );

  router.get(
    "/storylines/:id",
    handle(async (request, response) => {
      const queries = await requireQueries(response);
      if (queries === null) return;
      const id = UUID.safeParse(request.params.id);
      const detail = id.success
        ? await queries.storylineDetail(id.data)
        : null;
      if (detail === null) {
        sendError(response, 404, "not_found", "Unknown storyline");
        return;
      }
      response.json({ data: detail });
    }),
  );

  router.get(
    "/borderline",
    handle(async (request, response) => {
      const queries = await requireQueries(response);
      if (queries === null) return;
      const window = Number(request.query.window ?? 0.03);
      const limit = Number(request.query.limit ?? 100);
      response.json({
        data: {
          items: await queries.borderlinePairs(
            Number.isFinite(window) ? window : 0.03,
            Number.isFinite(limit) ? limit : 100,
          ),
        },
      });
    }),
  );

  router.get(
    "/labels",
    handle(async (_request, response) => {
      const labels = await deps.labels.readLabels();
      response.json({ data: { count: labels.length, labels } });
    }),
  );

  router.post(
    "/labels",
    handle(async (request, response) => {
      const body = LabelBodySchema.safeParse(request.body);
      if (!body.success) {
        sendError(
          response,
          400,
          "invalid_request",
          "entryA/entryB must be entry UUIDs and sameEvent a boolean",
        );
        return;
      }
      await deps.labels.appendLabel(body.data);
      response.status(201).json({ data: { saved: true } });
    }),
  );

  router.get(
    "/experiments",
    handle(async (_request, response) => {
      const queries = await requireQueries(response);
      if (queries === null) return;
      response.json({
        data: {
          active: deps.harness?.active ?? null,
          items: await queries.experimentRuns(),
        },
      });
    }),
  );

  router.post(
    "/experiments",
    handle(async (request, response) => {
      const capability = await deps.capability();
      if (deps.harness === null || !capability.experimentsEnabled) {
        sendError(
          response,
          503,
          "not_enabled",
          capability.experimentsReason ??
            capability.reason ??
            "Experiments are not enabled",
        );
        return;
      }
      const body = RunBodySchema.safeParse(request.body);
      if (!body.success) {
        sendError(response, 400, "invalid_request", z.prettifyError(body.error));
        return;
      }
      try {
        const active = await deps.harness.start(body.data);
        response.status(202).json({ data: active });
      } catch (error) {
        if (error instanceof LabRunActiveError) {
          sendError(response, 409, "run_active", error.message);
        } else if (error instanceof LabValidationError) {
          sendError(response, 400, "invalid_request", error.message);
        } else {
          throw error;
        }
      }
    }),
  );

  router.get(
    "/experiments/stream",
    handle(async (request, response) => {
      response.status(200);
      response.setHeader("content-type", "text/event-stream");
      response.setHeader("connection", "keep-alive");
      response.flushHeaders();
      response.write(
        `event: snapshot\ndata: ${JSON.stringify(deps.harness?.active ?? null)}\n\n`,
      );
      const unsubscribe =
        deps.harness?.onEvent((event) => {
          response.write(
            `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`,
          );
        }) ?? (() => undefined);
      request.on("close", unsubscribe);
    }),
  );

  router.get(
    "/experiments/:id",
    handle(async (request, response) => {
      const queries = await requireQueries(response);
      if (queries === null) return;
      const id = UUID.safeParse(request.params.id);
      const run = id.success ? await queries.experimentRun(id.data) : null;
      if (run === null) {
        sendError(response, 404, "not_found", "Unknown experiment run");
        return;
      }
      const reportAvailable =
        REPORT_NAME.test(run.name) &&
        existsSync(join(deps.repoRoot, "docs/eval", run.name, "report.md"));
      response.json({ data: { reportAvailable, run } });
    }),
  );

  router.get(
    "/experiments/:id/report",
    handle(async (request, response) => {
      const queries = await requireQueries(response);
      if (queries === null) return;
      const id = UUID.safeParse(request.params.id);
      const run = id.success ? await queries.experimentRun(id.data) : null;
      const path =
        run !== null && REPORT_NAME.test(run.name)
          ? join(deps.repoRoot, "docs/eval", run.name, "report.md")
          : null;
      if (path === null || !existsSync(path)) {
        sendError(response, 404, "not_found", "Report not found");
        return;
      }
      response.setHeader("content-type", "text/markdown; charset=utf-8");
      response.send(readFileSync(path, "utf8"));
    }),
  );

  return router;
}
```

- [ ] **Step 4: Wire into the server**

In `apps/operator-console/src/server.ts`:

```ts
// new imports
import { createLabDb, isLocalDsn, labCapability } from "./lab/db";
import { ExperimentHarness, defaultSpawner } from "./lab/harness";
import { LabelStore } from "./lab/labels";
import { LabQueries } from "./lab/queries";
import { createLabRouter } from "./lab/routes";
```

Inside `startDashboard`, immediately after the `/api/ops/v1/*path` route and before `attachTailEndpoint`:

```ts
  const labDb =
    config.databaseUrl === undefined ? null : createLabDb(config.databaseUrl);
  const labQueries = labDb === null ? null : new LabQueries(labDb.read);
  const labHarness =
    labQueries !== null &&
    config.databaseUrl !== undefined &&
    isLocalDsn(config.databaseUrl)
      ? new ExperimentHarness({
          needsPrepare: () =>
            labQueries.corpusSummary().then((summary) => summary.needsPrepare),
          spawnStage: defaultSpawner(repositoryRoot),
        })
      : null;
  app.use(
    "/api/lab",
    createLabRouter({
      capability: () => labCapability(labDb, config.databaseUrl),
      harness: labHarness,
      labels: new LabelStore(resolve(repositoryRoot, "docs/eval")),
      queries: labQueries,
      repoRoot: repositoryRoot,
    }),
  );
```

`RequiredOperatorConsoleConfig` already carries `databaseUrl?` via the Task 1 config change. In the returned `close()` add `await labDb?.close();` before the tail shutdown.

- [ ] **Step 5: Run tests to verify they pass**

Run: `pnpm --filter @dot-gov-news/operator-console test` and `pnpm --filter @dot-gov-news/operator-console typecheck`
Expected: PASS — 4 new route tests plus all existing suites (the server boundary test still passes; lab wiring is inert without DATABASE_URL).

- [ ] **Step 6: Commit**

```bash
git add apps/operator-console/src/lab/routes.ts apps/operator-console/src/server.ts apps/operator-console/test/lab-routes.test.ts
git commit -m "feat: expose clustering lab api on the local dashboard server

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 7: `ops lab` CLI command group + recipes + cheatsheet

CLI/dashboard parity (spec: every dashboard view has a copyable CLI twin). The CLI talks to the same lab modules directly (no HTTP hop).

**Files:**
- Modify: `apps/operator-console/src/cli.ts`, `apps/operator-console/src/recipes.ts`
- Test: `apps/operator-console/test/recipes.test.ts` (extend existing expectations)
- Regenerate: `docs/operations/cli-cheatsheet.md`

**Interfaces:**
- Produces commands (all read commands accept `--json`; exit code 3 when the lab is `not_enabled`; `lab run` exits 1 on a failed run, 2 on validation/active-run errors via the generic error path):
  - `pnpm ops lab corpus` — corpus receipt, feature coverage, needs-prepare count
  - `pnpm ops lab storylines [--entity <e>] [--agency <host>] [--min-episodes <n>] [--limit <n>]`
  - `pnpm ops lab storyline <id>` — chain walk: episodes with attach evidence, overview timeline with citation flags
  - `pnpm ops lab metrics` — live quality snapshot (attach mix, singleton rate, chains, suggested threshold)
  - `pnpm ops lab borderline [--window <w>] [--limit <n>]` — label queue
  - `pnpm ops lab experiments` — run history from `experiment_runs`
  - `pnpm ops lab run --name <name> [--stub] [--limit <n>] [--until <ISO>] [--no-cache] [--prepare] [--clear-features] [--set KEY=VALUE ...]` — streams stage/log lines; requires a local DSN
- Recipes added: `lab-corpus`, `lab-chains`, `lab-storyline-qa`, `lab-run-stub`, `lab-experiments`, `lab-label-queue`.

- [ ] **Step 1: Extend the failing recipes test**

Add to `apps/operator-console/test/recipes.test.ts`:

```ts
it("includes clustering lab recipes with dashboard views", () => {
  const ids = operatorRecipes.map((recipe) => recipe.id);
  for (const id of [
    "lab-corpus",
    "lab-chains",
    "lab-run-stub",
    "lab-experiments",
    "lab-label-queue",
  ]) {
    expect(ids).toContain(id);
  }
  const chains = operatorRecipes.find((recipe) => recipe.id === "lab-chains");
  expect(chains?.cli).toBe("pnpm ops lab storylines --min-episodes 2");
  expect(chains?.view).toBe("/storylines?minEpisodes=2");
});
```

Run: `pnpm --filter @dot-gov-news/operator-console test -- recipes`
Expected: FAIL — missing recipe ids.

- [ ] **Step 2: Add the recipes**

Append to `operatorRecipes` in `apps/operator-console/src/recipes.ts`:

```ts
  {
    cli: "pnpm ops lab corpus",
    description: "Inspect the synced news-entries corpus and feature coverage.",
    id: "lab-corpus",
    title: "Inspect the corpus",
    view: "/lab",
  },
  {
    cli: "pnpm ops lab storylines --min-episodes 2",
    description: "List multi-episode storyline chains for QA.",
    id: "lab-chains",
    title: "Browse storyline chains",
    view: "/storylines?minEpisodes=2",
  },
  {
    cli: "pnpm ops lab storyline <id>",
    description: "Walk one chain: episodes, attach evidence, event cards.",
    id: "lab-storyline-qa",
    title: "QA a storyline chain",
    view: "/storylines",
  },
  {
    cli: "pnpm ops lab run --name baseline --stub",
    description: "Run a clustering experiment via the pipeline CLI.",
    id: "lab-run-stub",
    title: "Run a stub experiment",
    view: "/lab#run",
  },
  {
    cli: "pnpm ops lab experiments",
    description: "List experiment runs and compare their summaries.",
    id: "lab-experiments",
    title: "List experiment runs",
    view: "/lab#experiments",
  },
  {
    cli: "pnpm ops lab borderline --limit 50",
    description: "Label borderline attach decisions for future eval scoring.",
    id: "lab-label-queue",
    title: "Open the label queue",
    view: "/lab#labels",
  },
```

- [ ] **Step 3: Add the command group to `cli.ts`**

Imports at top: `import { resolve } from "node:path"; import { createLabDb, isLocalDsn, labCapability, type LabDb } from "./lab/db"; import { ExperimentHarness, defaultSpawner } from "./lab/harness"; import { LabelStore } from "./lab/labels"; import { snapshotLabMetrics } from "./lab/metrics"; import { LabQueries } from "./lab/queries"; import { repositoryRoot } from "./config";` — then append before `program.parseAsync`:

```ts
interface LabContext {
  close(): Promise<void>;
  databaseUrl: string;
  db: LabDb;
  queries: LabQueries;
}

async function withLab(
  action: (context: LabContext) => Promise<void>,
): Promise<void> {
  const config = loadOperatorConfig();
  const db =
    config.databaseUrl === undefined ? null : createLabDb(config.databaseUrl);
  const capability = await labCapability(db, config.databaseUrl);
  if (db === null || capability.status !== "available") {
    await db?.close();
    process.stderr.write(
      `not_enabled: ${capability.reason ?? "clustering lab unavailable"}\n`,
    );
    process.exitCode = 3;
    return;
  }
  const context: LabContext = {
    close: () => db.close(),
    databaseUrl: config.databaseUrl ?? "",
    db,
    queries: new LabQueries(db.read),
  };
  try {
    await action(context);
  } finally {
    await context.close();
  }
}

const lab = program
  .command("lab")
  .description("Clustering lab: browse chains, run and compare experiments");

lab
  .command("corpus")
  .description("Corpus receipt, feature coverage, prepare backlog")
  .option("--json", "print JSON only")
  .action((options: JsonOption) =>
    runAction(() =>
      withLab(async ({ queries }) => {
        const summary = await queries.corpusSummary();
        if (options.json) {
          printJson(summary);
          return;
        }
        process.stdout.write(
          `Corpus ${summary.entries.toLocaleString()} entries · ${summary.sources} sources · ${summary.firstPublishedAt ?? "—"} → ${summary.lastPublishedAt ?? "—"}\n`,
        );
        printRows([
          {
            clustered: summary.clustered,
            embedded: summary.embedded,
            enriched: summary.enriched,
            extracted: summary.extracted,
            needsPrepare: summary.needsPrepare,
          },
        ]);
        printRows(summary.agencies.slice(0, 15));
      }),
    ),
  );

lab
  .command("storylines")
  .description("List storylines (newest first)")
  .option("--entity <entity>", "filter by extracted entity")
  .option("--agency <host>", "filter by agency host, e.g. fda.gov")
  .option("--min-episodes <n>", "only chains with at least n episodes")
  .option("--limit <n>", "maximum rows", "50")
  .option("--json", "print JSON only")
  .action(
    (
      options: JsonOption & {
        agency?: string;
        entity?: string;
        limit: string;
        minEpisodes?: string;
      },
    ) =>
      runAction(() =>
        withLab(async ({ queries }) => {
          const items = await queries.storylines({
            agency: options.agency,
            entity: options.entity,
            limit: Number(options.limit),
            minEpisodes:
              options.minEpisodes === undefined
                ? undefined
                : Number(options.minEpisodes),
          });
          if (options.json) {
            printJson(items);
            return;
          }
          printRows(
            items.map((item) => ({
              entries: item.entryCount,
              episodes: item.episodeCount,
              feeds: item.distinctFeeds,
              headline: item.headline ?? "(no card)",
              id: item.id,
              newest: item.newestEntryAt,
            })),
          );
        }),
      ),
  );

lab
  .command("storyline <id>")
  .description("Walk one chain: episodes, attach evidence, cards")
  .option("--json", "print JSON only")
  .action((id: string, options: JsonOption) =>
    runAction(() =>
      withLab(async ({ queries }) => {
        const detail = await queries.storylineDetail(id);
        if (detail === null) {
          process.stderr.write("not_found: unknown storyline\n");
          process.exitCode = 2;
          return;
        }
        if (options.json) {
          printJson(detail);
          return;
        }
        process.stdout.write(
          `${detail.headline ?? "(no overview card)"} · ${detail.episodeCount} episodes · ${detail.entryCount} entries\n`,
        );
        for (const episode of detail.episodes) {
          process.stdout.write(
            `\n[${episode.status}] ${episode.card?.headline ?? episode.id} — ${episode.attachMethod}${episode.attachSimilarity === null ? "" : ` (sim ${episode.attachSimilarity})`}${episode.attachReason === null ? "" : ` — ${episode.attachReason}`}\n`,
          );
          printRows(
            episode.entries.map((entry) => ({
              agency: entry.agency,
              method: entry.attachMethod,
              published: entry.publishedAt ?? "—",
              similarity:
                entry.similarity === null
                  ? "—"
                  : `${entry.similarity} / ${entry.thresholdUsed ?? "—"}`,
              syndicated: entry.isSyndicated,
              title: entry.title ?? entry.url,
            })),
          );
        }
        const overview = detail.overviewCards[0];
        if (overview?.timeline) {
          process.stdout.write(`\nOverview v${overview.version} timeline:\n`);
          for (const item of overview.timeline) {
            process.stdout.write(
              `  ${item.cited ? "·" : "✗ UNCITED"} ${item.date}  ${item.text}\n`,
            );
          }
        }
      }),
    ),
  );

lab
  .command("metrics")
  .description("Live clustering quality snapshot")
  .option("--json", "print JSON only")
  .action((options: JsonOption) =>
    runAction(() =>
      withLab(async ({ queries }) => {
        const metrics = await snapshotLabMetrics(queries);
        if (options.json) {
          printJson(metrics);
          return;
        }
        printRows([metrics.volume]);
        printRows(metrics.attachMix);
        process.stdout.write(
          `singleton rate ${metrics.singletonEpisodeRate ?? "—"} · syndication ${metrics.syndicationRate ?? "—"} · suggested NEAR_DUP_THRESHOLD ${metrics.calibration.suggestedNearDupThreshold ?? "—"}\n`,
        );
      }),
    ),
  );

lab
  .command("borderline")
  .description("Borderline attach decisions awaiting labels")
  .option("--window <w>", "similarity window around the threshold", "0.03")
  .option("--limit <n>", "maximum rows", "50")
  .option("--json", "print JSON only")
  .action((options: JsonOption & { limit: string; window: string }) =>
    runAction(() =>
      withLab(async ({ queries }) => {
        const items = await queries.borderlinePairs(
          Number(options.window),
          Number(options.limit),
        );
        if (options.json) printJson(items);
        else
          printRows(
            items.map((pair) => ({
              a: pair.entryTitle ?? pair.entryId,
              b: pair.matchedTitle ?? pair.matchedEntryId ?? "—",
              method: pair.attachMethod,
              similarity: `${pair.similarity} / ${pair.thresholdUsed}`,
            })),
          );
      }),
    ),
  );

lab
  .command("experiments")
  .description("List experiment runs (from experiment_runs)")
  .option("--json", "print JSON only")
  .action((options: JsonOption) =>
    runAction(() =>
      withLab(async ({ queries }) => {
        const items = await queries.experimentRuns();
        if (options.json) printJson(items);
        else
          printRows(
            items.map((run) => ({
              cache: `${run.cacheHits}/${run.cacheMisses}`,
              chains: run.summary?.multi_episode_storylines ?? "—",
              created: run.createdAt,
              duration: `${run.durationSeconds}s`,
              episodes: run.summary?.episodes ?? "—",
              name: run.name,
              storylines: run.summary?.storylines ?? "—",
            })),
          );
      }),
    ),
  );

lab
  .command("run")
  .description("Run a clustering experiment via the pipeline CLI")
  .requiredOption("--name <name>", "experiment name (report directory)")
  .option("--stub", "use deterministic stub models")
  .option("--limit <n>", "cluster at most n prepared entries")
  .option("--until <iso>", "cluster entries published up to this timestamp")
  .option("--no-cache", "bypass the adjudicator decision cache")
  .option("--prepare", "force the prepare phase before the experiment")
  .option("--clear-features", "reset features first (model/enrichment A/Bs)")
  .option(
    "--set <KEY=VALUE...>",
    "pipeline env override (repeatable)",
    (value: string, previous: string[] = []) => [...previous, value],
  )
  .action(
    (options: {
      cache: boolean;
      clearFeatures?: boolean;
      limit?: string;
      name: string;
      prepare?: boolean;
      set?: string[];
      stub?: boolean;
      until?: string;
    }) =>
      runAction(() =>
        withLab(async ({ databaseUrl, queries }) => {
          if (!isLocalDsn(databaseUrl)) {
            process.stderr.write(
              "not_enabled: experiments only run against a local database\n",
            );
            process.exitCode = 3;
            return;
          }
          const env: Record<string, string> = {};
          for (const pair of options.set ?? []) {
            const separator = pair.indexOf("=");
            if (separator < 1) {
              throw new Error(`--set expects KEY=VALUE, got "${pair}"`);
            }
            env[pair.slice(0, separator)] = pair.slice(separator + 1);
          }
          const harness = new ExperimentHarness({
            needsPrepare: () =>
              queries.corpusSummary().then((summary) => summary.needsPrepare),
            spawnStage: defaultSpawner(repositoryRoot),
          });
          const finished = new Promise<{
            reportPath: string | null;
            runId: string | null;
            status: "failed" | "succeeded";
          }>((resolveDone) => {
            harness.onEvent((event) => {
              if (event.type === "log") process.stdout.write(`${event.line}\n`);
              if (event.type === "stage")
                process.stderr.write(
                  `stage ${event.stage.name}: ${event.stage.status}\n`,
                );
              if (event.type === "done") resolveDone(event);
            });
          });
          await harness.start({
            clearFeatures: options.clearFeatures,
            env,
            limit: options.limit === undefined ? null : Number(options.limit),
            name: options.name,
            noCache: options.cache === false,
            prepare: options.prepare,
            stub: options.stub,
            until: options.until ?? null,
          });
          const done = await finished;
          process.stdout.write(
            `${done.status}: run ${done.runId ?? "—"} · ${done.reportPath ?? "no report"}\n`,
          );
          if (done.status === "failed") process.exitCode = 1;
        }),
      ),
  );
```

Note: commander maps `--no-cache` onto `options.cache === false` — hence `noCache: options.cache === false`. `LabValidationError`/`LabRunActiveError` surface through `runAction`'s generic error path (exit 2), matching the CLI's existing behavior for invalid input. `LabelStore` is not needed by the CLI (labels are a dashboard affordance); drop the import if unused.

- [ ] **Step 4: Run tests, regenerate the cheatsheet**

Run: `pnpm --filter @dot-gov-news/operator-console test -- recipes` → PASS.
Run: `pnpm --filter @dot-gov-news/operator-console typecheck` → clean.
Run: `pnpm ops docs:generate` → `docs/operations/cli-cheatsheet.md` now includes the six lab recipes.
Smoke (requires local Supabase + synced corpus): `pnpm ops lab corpus` prints the receipt; without `DATABASE_URL` resolving, prints `not_enabled: …` and exits 3.

- [ ] **Step 5: Commit**

```bash
git add apps/operator-console/src/cli.ts apps/operator-console/src/recipes.ts apps/operator-console/test/recipes.test.ts docs/operations/cli-cheatsheet.md
git commit -m "feat: add ops lab cli commands, recipes, and cheatsheet entries

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 8: Storylines UI — browse + chain detail

Two routes in the NDS grammar: `/storylines` (browse/filter, receipt hero = multi-episode chain count) and `/storylines/:id` (the chain view: episode rail with attach evidence, event-card stack with cited timeline, entry inspector). Unchanged from revision 1 except the capability payload now includes `experimentsEnabled` (the storylines pages only read `status`/`reason`).

**Files:**
- Create: `apps/operator-console/src/ui/lab-api.ts`, `apps/operator-console/src/ui/pages/StorylinesPage.tsx`, `apps/operator-console/src/ui/pages/StorylineDetailPage.tsx`
- Modify: `apps/operator-console/src/ui/App.tsx` (nav + routes), `apps/operator-console/src/ui/styles.css` (lab classes)
- Test: `apps/operator-console/test/storylines-page.test.tsx`

**Interfaces:**
- Produces `fetchLab<T>(path, schema)` / `postLab<T>(path, payload, schema)` (unwrap the `{ data }` envelope, throw `LabApiError` with the lab error code) — Task 9 reuses them.
- Nav order becomes: Overview, Inventory, Discovery, Feeds, **Storylines**, Events, System (the **Lab** entry lands in Task 9).
- Every similarity renders as mono `0.912 ≥ 0.90` (value vs threshold); attach methods render verbatim in an `.attach-tag`; uncited timeline bullets get `status-failed` treatment — the hallucination-guard QA surface.

- [ ] **Step 1: Write the failing component test**

```tsx
// apps/operator-console/test/storylines-page.test.tsx
// @vitest-environment jsdom
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { afterEach, describe, expect, it, vi } from "vitest";

import { StorylinesPage } from "../src/ui/pages/StorylinesPage";

function jsonResponse(payload: unknown): Response {
  return new Response(JSON.stringify(payload), {
    headers: { "content-type": "application/json" },
    status: 200,
  });
}

afterEach(() => {
  vi.restoreAllMocks();
});

function renderPage(): void {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  render(
    <QueryClientProvider client={client}>
      <MemoryRouter initialEntries={["/storylines"]}>
        <StorylinesPage />
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

describe("StorylinesPage", () => {
  it("renders chains from the lab api", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL) => {
        const url = String(input);
        if (url.includes("/api/lab/capability")) {
          return jsonResponse({
            data: { experimentsEnabled: true, status: "available" },
          });
        }
        if (url.includes("/api/lab/metrics")) {
          return jsonResponse({
            data: {
              attachMix: [],
              calibration: {
                pairCount: 0,
                percentiles: {},
                suggestedNearDupThreshold: null,
              },
              capturedAt: "2026-07-18T12:00:00.000Z",
              entriesPerEpisode: [],
              episodesPerStoryline: [],
              similarity: [],
              singletonEpisodeRate: null,
              storylineAttachMix: [],
              syndicationRate: null,
              topChains: [],
              volume: {
                cards: 4,
                entries: 12,
                episodes: 3,
                multiEpisodeStorylines: 1,
                storylines: 2,
              },
            },
          });
        }
        return jsonResponse({
          data: {
            items: [
              {
                agencies: ["fda.gov"],
                distinctFeeds: 2,
                entities: ["valsatrex"],
                entryCount: 5,
                episodeCount: 2,
                eventKeys: ["z-2026-0143"],
                firstEntryAt: "2026-05-14T14:00:00.000Z",
                headline: "Valsatrex recall chain",
                id: "00000000-0000-4000-8000-000000000021",
                newestEntryAt: "2026-05-17T15:00:00.000Z",
              },
            ],
          },
        });
      }),
    );
    renderPage();
    expect(
      await screen.findByText("Valsatrex recall chain"),
    ).toBeInTheDocument();
    expect(await screen.findByText("z-2026-0143")).toBeInTheDocument();
  });

  it("renders the not-enabled state honestly", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL) => {
        if (String(input).includes("/api/lab/capability")) {
          return jsonResponse({
            data: {
              experimentsEnabled: false,
              reason: "Set DATABASE_URL",
              status: "not_enabled",
            },
          });
        }
        return new Response(
          JSON.stringify({
            error: { code: "not_enabled", message: "Set DATABASE_URL" },
          }),
          { status: 503 },
        );
      }),
    );
    renderPage();
    expect(await screen.findByText(/Set DATABASE_URL/)).toBeInTheDocument();
  });
});
```

Run: `pnpm --filter @dot-gov-news/operator-console test -- storylines-page`
Expected: FAIL — cannot resolve `../src/ui/pages/StorylinesPage`.

- [ ] **Step 2: Implement the browser API helper**

```ts
// apps/operator-console/src/ui/lab-api.ts
import type { z } from "zod";

export class LabApiError extends Error {
  readonly code: string;
  readonly status: number;

  constructor(status: number, code: string, message: string) {
    super(message);
    this.name = "LabApiError";
    this.code = code;
    this.status = status;
  }
}

async function parse<T>(response: Response, schema: z.ZodType<T>): Promise<T> {
  const body: unknown = await response.json();
  if (!response.ok) {
    const parsed = body as { error?: { code?: string; message?: string } };
    throw new LabApiError(
      response.status,
      parsed.error?.code ?? "lab_error",
      parsed.error?.message ?? "Lab request failed",
    );
  }
  return schema.parse((body as { data: unknown }).data);
}

export async function fetchLab<T>(
  path: string,
  schema: z.ZodType<T>,
): Promise<T> {
  const response = await fetch(`/api/lab${path}`, {
    headers: { accept: "application/json" },
  });
  return parse(response, schema);
}

export async function postLab<T>(
  path: string,
  payload: unknown,
  schema: z.ZodType<T>,
): Promise<T> {
  const response = await fetch(`/api/lab${path}`, {
    body: JSON.stringify(payload),
    headers: { "content-type": "application/json" },
    method: "POST",
  });
  return parse(response, schema);
}
```

- [ ] **Step 3: Implement the browse page**

```tsx
// apps/operator-console/src/ui/pages/StorylinesPage.tsx
import { useQuery } from "@tanstack/react-query";
import { z } from "zod";
import { Link, useSearchParams } from "react-router-dom";

import {
  LabCapabilitySchema,
  StorylineListItemSchema,
} from "../../lab/contracts";
import { LabMetricsSchema } from "../../lab/metrics";
import { fetchLab } from "../lab-api";
import {
  CopyCommand,
  ErrorState,
  LoadingState,
  SectionHeading,
  relativeTime,
} from "../components";

export function StorylinesPage() {
  const [params, setParams] = useSearchParams();
  const entity = params.get("entity") ?? "";
  const agency = params.get("agency") ?? "";
  const minEpisodes = params.get("minEpisodes") ?? "";

  const capability = useQuery({
    queryFn: () => fetchLab("/capability", LabCapabilitySchema),
    queryKey: ["lab-capability"],
  });
  const metrics = useQuery({
    enabled: capability.data?.status === "available",
    queryFn: () => fetchLab("/metrics", LabMetricsSchema),
    queryKey: ["lab-metrics"],
    refetchInterval: 60_000,
  });
  const query = new URLSearchParams();
  if (entity !== "") query.set("entity", entity);
  if (agency !== "") query.set("agency", agency);
  if (minEpisodes !== "") query.set("minEpisodes", minEpisodes);
  const storylines = useQuery({
    enabled: capability.data?.status === "available",
    queryFn: () =>
      fetchLab(
        `/storylines?${query.toString()}`,
        z.object({ items: StorylineListItemSchema.array() }),
      ),
    queryKey: ["lab-storylines", entity, agency, minEpisodes],
  });

  if (capability.data?.status === "not_enabled") {
    return (
      <div className="not-enabled">
        <span className="eyebrow">Not enabled</span>
        <h2>Storylines</h2>
        <p>{capability.data.reason}</p>
      </div>
    );
  }

  const volume = metrics.data?.volume;
  const cliFilter = [
    entity === "" ? "" : ` --entity ${entity}`,
    agency === "" ? "" : ` --agency ${agency}`,
    minEpisodes === "" ? "" : ` --min-episodes ${minEpisodes}`,
  ].join("");

  return (
    <div className="page-stack">
      <section className="page-intro">
        <span className="section-index">S</span>
        <div>
          <p className="eyebrow">Cluster QA</p>
          <h1>Storylines</h1>
          <p>
            Chains reconstructed from the synced corpus: every attach decision
            carries its method, similarity, and threshold as evidence.
          </p>
        </div>
      </section>

      <section className="receipt-grid">
        {metrics.isLoading ? (
          <LoadingState label="Loading clustering state" />
        ) : metrics.error ? (
          <ErrorState error={metrics.error} />
        ) : volume === undefined ? null : volume.storylines === 0 ? (
          <div className="not-enabled compact">
            <span className="eyebrow">No clustered state</span>
            <p>
              The corpus has not been clustered yet. Run{" "}
              <code>pnpm ops lab run --name baseline --stub</code> or open the
              Lab.
            </p>
          </div>
        ) : (
          <>
            <div className="receipt-primary">
              <span className="eyebrow">Multi-episode chains</span>
              <strong>{volume.multiEpisodeStorylines.toLocaleString()}</strong>
              <span>the chain-reconstruction hypothesis, counted</span>
            </div>
            <dl className="metric-list">
              <div>
                <dt>Storylines</dt>
                <dd>{volume.storylines.toLocaleString()}</dd>
              </div>
              <div>
                <dt>Episodes</dt>
                <dd>{volume.episodes.toLocaleString()}</dd>
              </div>
              <div>
                <dt>Entries clustered</dt>
                <dd>{volume.entries.toLocaleString()}</dd>
              </div>
              <div>
                <dt>Event cards</dt>
                <dd>{volume.cards.toLocaleString()}</dd>
              </div>
            </dl>
          </>
        )}
      </section>

      <section className="ruled-section">
        <SectionHeading
          index="I"
          title="Chains"
          aside={
            <CopyCommand command={`pnpm ops lab storylines${cliFilter}`} />
          }
        />
        <form
          className="filter-bar"
          onSubmit={(event) => {
            event.preventDefault();
            const data = new FormData(event.currentTarget);
            const next: Record<string, string> = {};
            for (const key of ["entity", "agency", "minEpisodes"]) {
              const value = data.get(key);
              if (typeof value === "string" && value !== "") next[key] = value;
            }
            setParams(next);
          }}
        >
          <label htmlFor="entity">Entity</label>
          <input defaultValue={entity} id="entity" name="entity" placeholder="valsatrex" />
          <label htmlFor="agency">Agency</label>
          <input defaultValue={agency} id="agency" name="agency" placeholder="fda.gov" />
          <label htmlFor="minEpisodes">Min episodes</label>
          <input defaultValue={minEpisodes} id="minEpisodes" inputMode="numeric" name="minEpisodes" placeholder="2" />
          <button type="submit">Apply filter</button>
        </form>
        {storylines.isLoading ? (
          <LoadingState />
        ) : storylines.error ? (
          <ErrorState error={storylines.error} />
        ) : storylines.data?.items.length === 0 ? (
          <p className="empty-row">No storylines match this filter.</p>
        ) : (
          <div className="table-scroll">
            <table>
              <thead>
                <tr>
                  <th>Storyline</th>
                  <th>Episodes</th>
                  <th>Entries</th>
                  <th>Feeds</th>
                  <th>Agencies</th>
                  <th>Event keys</th>
                  <th>Newest</th>
                </tr>
              </thead>
              <tbody>
                {storylines.data?.items.map((item) => (
                  <tr key={item.id}>
                    <th scope="row">
                      <Link className="row-button" to={`/storylines/${item.id}`}>
                        {item.headline ?? "(no card yet)"}
                      </Link>
                    </th>
                    <td className="numeric">{item.episodeCount}</td>
                    <td className="numeric">{item.entryCount}</td>
                    <td className="numeric">{item.distinctFeeds}</td>
                    <td>{item.agencies.join(", ") || "—"}</td>
                    <td className="mono">{item.eventKeys.join(" ") || "—"}</td>
                    <td>{relativeTime(item.newestEntryAt)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>
    </div>
  );
}
```

- [ ] **Step 4: Implement the chain detail page**

```tsx
// apps/operator-console/src/ui/pages/StorylineDetailPage.tsx
import { useQuery } from "@tanstack/react-query";
import { useEffect, useRef, useState } from "react";
import { Link, useParams } from "react-router-dom";

import {
  StorylineDetailSchema,
  type EntryEvidence,
  type EventCard,
} from "../../lab/contracts";
import { fetchLab } from "../lab-api";
import {
  CopyCommand,
  ErrorState,
  LoadingState,
  SectionHeading,
  StatusMark,
} from "../components";

function Similarity({
  similarity,
  threshold,
}: {
  similarity: number | null;
  threshold: number | null;
}) {
  if (similarity === null) return <span className="mono">—</span>;
  return (
    <span className="mono">
      {similarity.toFixed(3)}
      {threshold === null ? "" : ` ≥ ${threshold.toFixed(2)}`}
    </span>
  );
}

function EntryInspector({
  close,
  entry,
}: {
  close: () => void;
  entry: EntryEvidence;
}) {
  const dialog = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    dialog.current?.showModal();
    return () => dialog.current?.close();
  }, []);
  return (
    <dialog
      aria-label="Entry evidence"
      className="inspector"
      onCancel={(event) => {
        event.preventDefault();
        close();
      }}
      ref={dialog}
    >
      <header>
        <div>
          <p className="eyebrow">Attach evidence</p>
          <h2>{entry.title ?? entry.url}</h2>
        </div>
        <button aria-label="Close inspector" onClick={close} type="button">
          ×
        </button>
      </header>
      <dl className="inspector-list">
        <div>
          <dt>Entry</dt>
          <dd>{entry.id}</dd>
        </div>
        <div>
          <dt>URL</dt>
          <dd>{entry.url}</dd>
        </div>
        <div>
          <dt>Agency</dt>
          <dd>{entry.agency}</dd>
        </div>
        <div>
          <dt>Published</dt>
          <dd>{entry.publishedAt ?? "—"}</dd>
        </div>
        <div>
          <dt>Method</dt>
          <dd>{entry.attachMethod}</dd>
        </div>
        <div>
          <dt>Similarity</dt>
          <dd>
            {entry.similarity ?? "—"} vs threshold {entry.thresholdUsed ?? "—"}
          </dd>
        </div>
        <div>
          <dt>Matched entry</dt>
          <dd>{entry.matchedEntryId ?? "—"}</dd>
        </div>
        <div>
          <dt>Syndicated</dt>
          <dd>{entry.isSyndicated ? "yes" : "no"}</dd>
        </div>
        <div>
          <dt>Entities</dt>
          <dd>{entry.entitySet.join(", ") || "—"}</dd>
        </div>
        <div>
          <dt>Event keys</dt>
          <dd>{entry.eventKeys.join(", ") || "—"}</dd>
        </div>
      </dl>
      <CopyCommand command="pnpm ops lab storyline <id> --json" />
    </dialog>
  );
}

function OverviewCardBlock({ card }: { card: EventCard }) {
  return (
    <article className="card-block">
      <header>
        <span className="attach-tag">
          overview v{card.version}
          {card.supersededBy === null ? "" : " · superseded"}
        </span>
        <span className="mono source-note">rank {card.rankKey.toFixed(3)}</span>
      </header>
      <h3>{card.headline}</h3>
      <p>{card.summary}</p>
      {card.timeline === null ? null : (
        <ol className="timeline-list">
          {card.timeline.map((item, index) => (
            <li key={index}>
              <span className="mono">{item.date}</span>
              <span>
                {item.text}{" "}
                {item.cited ? (
                  <a className="cite-link" href={`#episode-${item.episodeId}`}>
                    → episode
                  </a>
                ) : (
                  <StatusMark label="uncited" status="failed" />
                )}
              </span>
            </li>
          ))}
        </ol>
      )}
    </article>
  );
}

export function StorylineDetailPage() {
  const { id } = useParams();
  const [selected, setSelected] = useState<EntryEvidence | null>(null);
  const detail = useQuery({
    enabled: id !== undefined,
    queryFn: () => fetchLab(`/storylines/${id}`, StorylineDetailSchema),
    queryKey: ["lab-storyline", id],
  });

  if (detail.isLoading) return <LoadingState label="Loading chain" />;
  if (detail.error) return <ErrorState error={detail.error} />;
  const storyline = detail.data;
  if (storyline === undefined) return null;

  return (
    <div className="page-stack">
      <section className="page-intro">
        <span className="section-index">
          <Link className="row-button" to="/storylines">
            ← Storylines
          </Link>
        </span>
        <div>
          <p className="eyebrow">
            {storyline.episodeCount} episodes · {storyline.entryCount} entries ·{" "}
            {storyline.distinctFeeds} feeds
          </p>
          <h1>{storyline.headline ?? "Uncarded storyline"}</h1>
          <p>
            {storyline.agencies.join(", ")}
            {storyline.eventKeys.length > 0
              ? ` · keys: ${storyline.eventKeys.join(" ")}`
              : ""}
          </p>
        </div>
      </section>

      <div className="two-column-grid">
        <section className="ruled-section">
          <SectionHeading
            index="I"
            title="Episode chain"
            aside={
              <CopyCommand command={`pnpm ops lab storyline ${storyline.id}`} />
            }
          />
          <ol className="chain-rail">
            {storyline.episodes.map((episode, index) => (
              <li id={`episode-${episode.id}`} key={episode.id}>
                <header>
                  <span className="section-index">
                    {String(index + 1).padStart(2, "0")}
                  </span>
                  <StatusMark
                    label={episode.status}
                    status={episode.status === "open" ? "live" : "muted"}
                  />
                  <span className="attach-tag">{episode.attachMethod}</span>
                  {episode.attachSimilarity === null ? null : (
                    <span className="mono source-note">
                      sim {episode.attachSimilarity.toFixed(3)}
                    </span>
                  )}
                </header>
                <h3>{episode.card?.headline ?? "(no episode card yet)"}</h3>
                {episode.attachReason === null ? null : (
                  <p className="source-note">
                    {episode.adjudicatorModel === null
                      ? ""
                      : `${episode.adjudicatorModel}: `}
                    {episode.attachReason}
                  </p>
                )}
                <div className="table-scroll">
                  <table>
                    <thead>
                      <tr>
                        <th>Entry</th>
                        <th>Agency</th>
                        <th>Method</th>
                        <th>Similarity</th>
                        <th>Synd.</th>
                      </tr>
                    </thead>
                    <tbody>
                      {episode.entries.map((entry) => (
                        <tr key={entry.id}>
                          <th scope="row">
                            <button
                              className="row-button"
                              onClick={() => setSelected(entry)}
                              type="button"
                            >
                              {entry.title ?? entry.url}
                            </button>
                          </th>
                          <td>{entry.agency}</td>
                          <td className="mono">{entry.attachMethod}</td>
                          <td>
                            <Similarity
                              similarity={entry.similarity}
                              threshold={entry.thresholdUsed}
                            />
                          </td>
                          <td>{entry.isSyndicated ? "yes" : "—"}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </li>
            ))}
          </ol>
        </section>

        <section className="ruled-section">
          <SectionHeading index="II" title="Event cards" />
          {storyline.overviewCards.length === 0 ? (
            <p className="empty-row">
              No overview card yet — single-episode storylines collapse onto
              their episode card.
            </p>
          ) : (
            <div className="card-stack">
              {storyline.overviewCards.map((card) => (
                <OverviewCardBlock card={card} key={card.id} />
              ))}
            </div>
          )}
        </section>
      </div>

      {selected === null ? null : (
        <EntryInspector close={() => setSelected(null)} entry={selected} />
      )}
    </div>
  );
}
```

- [ ] **Step 5: Wire navigation, routes, and styles**

In `App.tsx`: add `["/storylines", "Storylines"]` after Feeds in `navigation` and the two routes

```tsx
<Route element={<StorylinesPage />} path="/storylines" />
<Route element={<StorylineDetailPage />} path="/storylines/:id" />
```

Append to `styles.css` (tokens only — no new colors):

```css
/* Clustering lab */
.chain-rail {
  list-style: none;
  margin: 0;
  padding: 0;
}
.chain-rail > li {
  padding: 1.25rem 0 1.5rem 1.25rem;
  border-top: 1px solid var(--rule);
  border-left: 2px solid var(--rule);
}
.chain-rail > li:target {
  border-left-color: var(--live);
}
.chain-rail header {
  display: flex;
  align-items: center;
  flex-wrap: wrap;
  gap: 0.8rem;
  margin-bottom: 0.5rem;
}
.chain-rail h3 {
  margin: 0 0 0.5rem;
  font-size: 1rem;
  letter-spacing: -0.01em;
}
.attach-tag {
  padding: 0.15rem 0.45rem;
  border: 1px solid var(--rule);
  color: var(--muted);
  font:
    500 0.68rem/1.4 ui-monospace,
    SFMono-Regular,
    Menlo,
    monospace;
  text-transform: uppercase;
  letter-spacing: 0.07em;
  white-space: nowrap;
}
.card-stack {
  display: grid;
  gap: 0;
}
.card-block {
  padding: 1.25rem 0;
  border-top: 1px solid var(--rule);
}
.card-block header {
  display: flex;
  justify-content: space-between;
  gap: 1rem;
  margin-bottom: 0.6rem;
}
.card-block h3 {
  margin: 0 0 0.4rem;
  font-size: 1.05rem;
}
.card-block p {
  color: var(--muted);
  font-size: 0.85rem;
  line-height: 1.55;
}
.timeline-list {
  list-style: none;
  margin: 0.8rem 0 0;
  padding: 0;
  font-size: 0.8rem;
}
.timeline-list li {
  display: grid;
  grid-template-columns: 95px 1fr;
  gap: 1rem;
  padding: 0.55rem 0;
  border-top: 1px solid var(--rule);
}
.timeline-list .mono {
  color: var(--muted);
}
.cite-link {
  color: var(--live);
  text-decoration: underline;
  text-underline-offset: 0.25rem;
}
.meter {
  display: inline-block;
  height: 8px;
  background: color-mix(in srgb, var(--live) 55%, transparent);
  vertical-align: middle;
}
.meter-track {
  display: inline-block;
  width: 120px;
  background: var(--raised);
  border: 1px solid var(--rule);
  line-height: 0;
}
.lab-form {
  display: grid;
  grid-template-columns: repeat(3, minmax(160px, 1fr));
  gap: 1rem 1.5rem;
  padding-bottom: 1.25rem;
}
.lab-form label {
  display: block;
  margin-bottom: 0.35rem;
  color: var(--muted);
  font-size: 0.7rem;
  text-transform: uppercase;
  letter-spacing: 0.08em;
}
.lab-form input {
  width: 100%;
  padding: 0.55rem 0.7rem;
  border: 1px solid var(--rule);
  border-radius: 0;
  background: var(--canvas);
  color: var(--text);
}
.lab-form .lab-form-actions {
  display: flex;
  align-items: end;
  flex-wrap: wrap;
  gap: 1rem;
}
.lab-form button[type="submit"] {
  padding: 0.58rem 0.95rem;
  border: 0;
  background: var(--text);
  color: var(--canvas);
  cursor: pointer;
}
.checkbox-row {
  display: flex;
  align-items: center;
  gap: 0.5rem;
  min-height: 2.4rem;
  color: var(--text);
  font-size: 0.82rem;
}
.checkbox-row label {
  display: inline;
  margin: 0;
  color: var(--text);
  font-size: 0.82rem;
  text-transform: none;
  letter-spacing: normal;
}
.stage-list {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 1rem;
  padding: 0.8rem 0;
}
.delta-up {
  color: var(--healthy);
}
.delta-down {
  color: var(--failure);
}
.label-actions {
  display: flex;
  gap: 0.5rem;
}
.label-actions button {
  padding: 0.35rem 0.75rem;
  border: 1px solid var(--rule);
  background: none;
  color: var(--text);
  cursor: pointer;
}
.label-actions button:hover {
  background: var(--raised);
}
@media (max-width: 900px) {
  .lab-form {
    grid-template-columns: 1fr;
  }
}
```

- [ ] **Step 6: Run tests to verify they pass**

Run: `pnpm --filter @dot-gov-news/operator-console test -- storylines-page`, then the full suite and typecheck.
Expected: PASS (2 tests); no regressions.

- [ ] **Step 7: Commit**

```bash
git add apps/operator-console/src/ui/lab-api.ts apps/operator-console/src/ui/pages/StorylinesPage.tsx apps/operator-console/src/ui/pages/StorylineDetailPage.tsx apps/operator-console/src/ui/App.tsx apps/operator-console/src/ui/styles.css apps/operator-console/test/storylines-page.test.tsx
git commit -m "feat: add storylines browse and chain-detail views to the dashboard

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 9: Lab UI — corpus, run console, run history, quality, label queue

One `/lab` page, five ruled sections in the NDS grammar: **I Corpus** (receipt + prepare backlog), **II Run experiment** (form + SSE console), **III Experiment runs** (history from `experiment_runs` + comparison with config diff), **IV Quality** (live metrics with inline meters), **V Label queue** (borderline pairs → labels.csv).

**Files:**
- Create: `apps/operator-console/src/ui/pages/LabPage.tsx`
- Modify: `apps/operator-console/src/ui/App.tsx` (add the `["/lab", "Lab"]` nav entry after System + the `/lab` route)
- Test: `apps/operator-console/test/lab-page.test.tsx`

**Interfaces:**
- Consumes: `fetchLab`/`postLab` (Task 8), contracts (Task 2), `LabMetricsSchema` (Task 3), `ActiveRun`/`RunStage` types (Task 5 — imported `import type` from `../../lab/harness`; define a matching `ActiveRunSchema` zod object locally in `LabPage.tsx` for the POST response).
- Run form → `POST /api/lab/experiments` `{ name, stub, prepare, clearFeatures, noCache, limit, env }`; on 202 opens `EventSource("/api/lab/experiments/stream")` and renders stage marks (`status-live` running, `status-healthy` succeeded, `status-failed` failed, `status-muted` pending/skipped) plus an `activity-ledger` log tail; on `done` invalidates the metrics/experiments/storylines/corpus queries and shows the returned `run_id`/report link. Form disabled with an honest reason when `experimentsEnabled` is false or a run is active. Override inputs: `NEAR_DUP_THRESHOLD`, `CLUSTER_JOIN_THRESHOLD`, `STORYLINE_SIM_FLOOR`, `AMBIENT_EMA_CEILING`, `EPISODE_DORMANCY_HOURS`, `ENRICHMENT_ENABLED` (the six iteration knobs; the full 15 remain available via CLI `--set`).
- Run history table (from `GET /experiments`): name (mono), created, duration `Ns`, processed (`clusterReport.processed`), episodes/storylines/chains (from `summary`), cache `hits/misses`, "report" link → opens `/api/lab/experiments/<id>/report` in a new tab (only when `reportAvailable`), "compare" `row-button`.
- Comparison: pick run A ("baseline") and run B (defaults to the newest run). Two ruled tables: **summary deltas** (entries clustered, episodes, storylines, cards, singleton rate, multi-episode chains — `delta-up`/`delta-down` on signed differences) and **config diff** (only keys whose values differ between the two runs' `config` jsonb, rendered mono: `near_dup_threshold · 0.9 → 0.87`). Numbers only, computed client-side.
- Label queue: `y`/`n` buttons per borderline pair → `POST /api/lab/labels`; row disappears (react-query invalidation); labeled-count receipt shown with the note that labels feed the future eval harness.
- Data honesty: capability gate identical to Task 8; empty run history says "No experiment runs recorded yet — failed runs are not recorded"; a `run_active` 409 renders as an attention note, not an error state; corpus panel marks `needsPrepare > 0` with `status-attention` and explains the run form will auto-prepare.

- [ ] **Step 1: Write the failing component test**

```tsx
// apps/operator-console/test/lab-page.test.tsx
// @vitest-environment jsdom
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { afterEach, describe, expect, it, vi } from "vitest";

import { LabPage } from "../src/ui/pages/LabPage";

function jsonResponse(payload: unknown): Response {
  return new Response(JSON.stringify(payload), {
    headers: { "content-type": "application/json" },
    status: 200,
  });
}

const RUNS = [
  {
    cacheHits: 2,
    cacheMisses: 0,
    clusterReport: { episodes_closed: 3, processed: 4 },
    config: { enrichment_enabled: true, near_dup_threshold: 0.87 },
    createdAt: "2026-07-18T11:00:22.000Z",
    durationSeconds: 21,
    finishedAt: "2026-07-18T11:00:21.000Z",
    id: "00000000-0000-4000-8000-0000000000a2",
    name: "near-dup-0.87",
    startedAt: "2026-07-18T11:00:00.000Z",
    summary: {
      cards: 4,
      entries_clustered: 4,
      entry_attach_mix: { near_dup: 1, new_cluster: 3 },
      episode_attach_mix: { new_storyline: 2 },
      episodes: 3,
      multi_episode_storylines: 1,
      singleton_episode_rate: 0.667,
      storylines: 2,
      top_chains: [{ episodes: 2, headline: "Valsatrex recall chain" }],
    },
  },
  {
    cacheHits: 0,
    cacheMisses: 2,
    clusterReport: { episodes_closed: 3, processed: 4 },
    config: { enrichment_enabled: true, near_dup_threshold: 0.9 },
    createdAt: "2026-07-18T10:00:43.000Z",
    durationSeconds: 42,
    finishedAt: "2026-07-18T10:00:42.000Z",
    id: "00000000-0000-4000-8000-0000000000a1",
    name: "baseline",
    startedAt: "2026-07-18T10:00:00.000Z",
    summary: {
      cards: 4,
      entries_clustered: 4,
      entry_attach_mix: { near_dup: 1, new_cluster: 3 },
      episode_attach_mix: { new_storyline: 2 },
      episodes: 4,
      multi_episode_storylines: 1,
      singleton_episode_rate: 0.75,
      storylines: 2,
      top_chains: [{ episodes: 2, headline: "Valsatrex recall chain" }],
    },
  },
];

afterEach(() => {
  vi.restoreAllMocks();
});

describe("LabPage", () => {
  it("renders corpus receipt, run history, and label queue", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL) => {
        const url = String(input);
        if (url.includes("/capability"))
          return jsonResponse({
            data: { experimentsEnabled: true, status: "available" },
          });
        if (url.includes("/corpus"))
          return jsonResponse({
            data: {
              agencies: [{ agency: "fda.gov", entries: 8 }],
              clustered: 10,
              embedded: 11,
              enriched: 11,
              entries: 13,
              extracted: 13,
              firstPublishedAt: "2026-05-14T14:00:00.000Z",
              lastPublishedAt: "2026-06-20T14:00:00.000Z",
              needsPrepare: 2,
              sources: 3,
            },
          });
        if (url.includes("/experiments"))
          return jsonResponse({ data: { active: null, items: RUNS } });
        if (url.includes("/borderline"))
          return jsonResponse({
            data: {
              items: [
                {
                  attachMethod: "near_dup",
                  entryId: "00000000-0000-4000-8000-000000000013",
                  entryTitle: "FDA expands Valsatrex recall",
                  matchedEntryId: "00000000-0000-4000-8000-000000000011",
                  matchedTitle: "FDA recalls Valsatrex",
                  similarity: 0.915,
                  thresholdUsed: 0.9,
                },
              ],
            },
          });
        if (url.includes("/labels"))
          return jsonResponse({ data: { count: 2, labels: [] } });
        if (url.includes("/metrics"))
          return jsonResponse({
            data: {
              attachMix: [
                { avgSimilarity: 0.91, count: 3, method: "near_dup" },
              ],
              calibration: {
                pairCount: 5,
                percentiles: { p5: 0.942 },
                suggestedNearDupThreshold: 0.922,
              },
              capturedAt: "2026-07-18T12:00:00.000Z",
              entriesPerEpisode: [{ bucket: 1, count: 2 }],
              episodesPerStoryline: [{ bucket: 2, count: 1 }],
              similarity: [],
              singletonEpisodeRate: 0.4,
              storylineAttachMix: [],
              syndicationRate: 0.25,
              topChains: [],
              volume: {
                cards: 4,
                entries: 13,
                episodes: 3,
                multiEpisodeStorylines: 1,
                storylines: 2,
              },
            },
          });
        return jsonResponse({ data: {} });
      }),
    );
    const client = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    });
    render(
      <QueryClientProvider client={client}>
        <MemoryRouter>
          <LabPage />
        </MemoryRouter>
      </QueryClientProvider>,
    );
    expect((await screen.findAllByText("13")).length).toBeGreaterThan(0);
    expect((await screen.findAllByText(/needs prepare/i)).length).toBeGreaterThan(0);
    expect(await screen.findByText("near-dup-0.87")).toBeInTheDocument();
    expect(await screen.findByText("baseline")).toBeInTheDocument();
    expect(
      await screen.findByText("FDA expands Valsatrex recall"),
    ).toBeInTheDocument();
    expect(await screen.findByText(/0\.922/)).toBeInTheDocument();
  });
});
```

Run: `pnpm --filter @dot-gov-news/operator-console test -- lab-page`
Expected: FAIL — cannot resolve `../src/ui/pages/LabPage`.

- [ ] **Step 2: Implement the page**

Structure (complete sections; helpers shown where behavior is non-obvious):

```tsx
// apps/operator-console/src/ui/pages/LabPage.tsx
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useRef, useState } from "react";
import { z } from "zod";

import {
  BorderlinePairSchema,
  CorpusSummarySchema,
  ExperimentRunSchema,
  LabCapabilitySchema,
  type ExperimentRun,
} from "../../lab/contracts";
import type { RunStage } from "../../lab/harness";
import { LabMetricsSchema } from "../../lab/metrics";
import { fetchLab, postLab, LabApiError } from "../lab-api";
import {
  CopyCommand,
  ErrorState,
  LoadingState,
  SectionHeading,
  StatusMark,
} from "../components";

const RunStageSchema = z.object({
  detail: z.string().optional(),
  name: z.enum(["reset-features", "prepare", "experiment"]),
  status: z.enum(["pending", "running", "succeeded", "failed", "skipped"]),
});
const ActiveRunSchema = z.object({
  name: z.string(),
  stages: RunStageSchema.array(),
  startedAt: z.string(),
  stub: z.boolean(),
});
const ExperimentListSchema = z.object({
  active: ActiveRunSchema.nullable(),
  items: ExperimentRunSchema.array(),
});

const OVERRIDE_FIELDS = [
  "NEAR_DUP_THRESHOLD",
  "CLUSTER_JOIN_THRESHOLD",
  "STORYLINE_SIM_FLOOR",
  "AMBIENT_EMA_CEILING",
  "EPISODE_DORMANCY_HOURS",
  "ENRICHMENT_ENABLED",
] as const;

function stageStatus(stage: RunStage) {
  return stage.status === "running"
    ? ("live" as const)
    : stage.status === "succeeded"
      ? ("healthy" as const)
      : stage.status === "failed"
        ? ("failed" as const)
        : ("muted" as const);
}

function summaryRows(run: ExperimentRun): [string, number | null][] {
  return [
    ["entries clustered", run.summary?.entries_clustered ?? null],
    ["episodes", run.summary?.episodes ?? null],
    ["storylines", run.summary?.storylines ?? null],
    ["cards", run.summary?.cards ?? null],
    ["singleton episode rate", run.summary?.singleton_episode_rate ?? null],
    ["multi-episode chains", run.summary?.multi_episode_storylines ?? null],
  ];
}

function configDiff(
  left: Record<string, unknown> | null,
  right: Record<string, unknown> | null,
): { key: string; left: string; right: string }[] {
  const keys = new Set([
    ...Object.keys(left ?? {}),
    ...Object.keys(right ?? {}),
  ]);
  return [...keys]
    .sort()
    .filter(
      (key) => JSON.stringify(left?.[key]) !== JSON.stringify(right?.[key]),
    )
    .map((key) => ({
      key,
      left: JSON.stringify(left?.[key]) ?? "—",
      right: JSON.stringify(right?.[key]) ?? "—",
    }));
}
```

Then the components (same file, continuing):

```tsx
function Meter({ count, max }: { count: number; max: number }) {
  const width = max === 0 ? 0 : Math.max(4, Math.round((count / max) * 120));
  return (
    <span className="meter-track">
      <span className="meter" style={{ width: `${width}px` }} />
    </span>
  );
}

function RunSection({ disabledReason }: { disabledReason: string | null }) {
  const queryClient = useQueryClient();
  const [stages, setStages] = useState<RunStage[]>([]);
  const [log, setLog] = useState<string[]>([]);
  const [runName, setRunName] = useState<string | null>(null);
  const [result, setResult] = useState<{
    reportPath: string | null;
    runId: string | null;
    status: "failed" | "succeeded";
  } | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const sourceRef = useRef<EventSource | null>(null);

  useEffect(() => () => sourceRef.current?.close(), []);

  const follow = (): void => {
    sourceRef.current?.close();
    const source = new EventSource("/api/lab/experiments/stream");
    sourceRef.current = source;
    source.addEventListener("stage", (event) => {
      const payload = JSON.parse((event as MessageEvent<string>).data) as {
        stage: RunStage;
      };
      setStages((current) =>
        current.map((stage) =>
          stage.name === payload.stage.name ? payload.stage : stage,
        ),
      );
    });
    source.addEventListener("log", (event) => {
      const payload = JSON.parse((event as MessageEvent<string>).data) as {
        line: string;
      };
      setLog((current) => [...current.slice(-400), payload.line]);
    });
    source.addEventListener("done", (event) => {
      const payload = JSON.parse((event as MessageEvent<string>).data) as {
        reportPath: string | null;
        runId: string | null;
        status: "failed" | "succeeded";
      };
      setResult(payload);
      source.close();
      for (const key of [
        "lab-metrics",
        "lab-experiments",
        "lab-storylines",
        "lab-corpus",
      ]) {
        void queryClient.invalidateQueries({ queryKey: [key] });
      }
    });
  };

  return (
    <section className="ruled-section" id="run">
      <SectionHeading
        index="II"
        title="Run experiment"
        aside={
          <CopyCommand command="pnpm ops lab run --name baseline --stub" />
        }
      />
      {disabledReason !== null ? (
        <p className="empty-row">{disabledReason}</p>
      ) : (
        <form
          className="lab-form"
          onSubmit={(event) => {
            event.preventDefault();
            setNotice(null);
            const data = new FormData(event.currentTarget);
            const env: Record<string, string> = {};
            for (const key of OVERRIDE_FIELDS) {
              const value = data.get(key);
              if (typeof value === "string" && value.trim() !== "")
                env[key] = value.trim();
            }
            const limitRaw = String(data.get("limit") ?? "");
            void postLab(
              "/experiments",
              {
                clearFeatures: data.get("clearFeatures") === "on",
                env,
                limit: limitRaw === "" ? null : Number(limitRaw),
                name: String(data.get("name") ?? ""),
                noCache: data.get("noCache") === "on",
                prepare: data.get("prepare") === "on" ? true : undefined,
                stub: data.get("stub") === "on",
              },
              ActiveRunSchema,
            )
              .then((active) => {
                setRunName(active.name);
                setStages(active.stages);
                setLog([]);
                setResult(null);
                follow();
              })
              .catch((error: unknown) => {
                setNotice(
                  error instanceof LabApiError
                    ? error.message
                    : "Failed to start the experiment",
                );
              });
          }}
        >
          <div>
            <label htmlFor="exp-name">Name</label>
            <input id="exp-name" name="name" placeholder="baseline" required />
          </div>
          {OVERRIDE_FIELDS.map((key) => (
            <div key={key}>
              <label htmlFor={`exp-${key}`}>{key.toLowerCase()}</label>
              <input
                className="mono"
                id={`exp-${key}`}
                name={key}
                placeholder="default"
              />
            </div>
          ))}
          <div>
            <label htmlFor="exp-limit">Limit</label>
            <input
              id="exp-limit"
              inputMode="numeric"
              name="limit"
              placeholder="all prepared entries"
            />
          </div>
          <div className="lab-form-actions">
            <span className="checkbox-row">
              <input id="exp-stub" name="stub" type="checkbox" />
              <label htmlFor="exp-stub">Stub models</label>
            </span>
            <span className="checkbox-row">
              <input id="exp-prepare" name="prepare" type="checkbox" />
              <label htmlFor="exp-prepare">Prepare features</label>
            </span>
            <span className="checkbox-row">
              <input id="exp-clear" name="clearFeatures" type="checkbox" />
              <label htmlFor="exp-clear">Re-embed (feature A/B)</label>
            </span>
            <span className="checkbox-row">
              <input id="exp-nocache" name="noCache" type="checkbox" />
              <label htmlFor="exp-nocache">Bypass decision cache</label>
            </span>
            <button type="submit">Start run</button>
          </div>
        </form>
      )}
      {notice === null ? null : (
        <p>
          <StatusMark label={notice} status="attention" />
        </p>
      )}
      {runName === null ? null : (
        <>
          <div aria-live="polite" className="stage-list">
            <span className="mono source-note">{runName}</span>
            {stages.map((stage) => (
              <StatusMark
                key={stage.name}
                label={`${stage.name} ${stage.status}`}
                status={stageStatus(stage)}
              />
            ))}
            {result === null ? null : (
              <>
                <StatusMark
                  label={result.status}
                  status={result.status === "succeeded" ? "healthy" : "failed"}
                />
                {result.runId === null ? null : (
                  <a
                    className="text-button"
                    href={`/api/lab/experiments/${result.runId}/report`}
                    rel="noreferrer"
                    target="_blank"
                  >
                    Open report
                  </a>
                )}
              </>
            )}
          </div>
          <ul className="activity-ledger">
            {log.map((line, index) => (
              <li key={index}>
                <time>·</time>
                <span>{line}</span>
              </li>
            ))}
          </ul>
        </>
      )}
    </section>
  );
}

export function LabPage() {
  const queryClient = useQueryClient();
  const [baselineId, setBaselineId] = useState<string>("");

  const capability = useQuery({
    queryFn: () => fetchLab("/capability", LabCapabilitySchema),
    queryKey: ["lab-capability"],
  });
  const enabled = capability.data?.status === "available";
  const corpus = useQuery({
    enabled,
    queryFn: () => fetchLab("/corpus", CorpusSummarySchema),
    queryKey: ["lab-corpus"],
  });
  const metrics = useQuery({
    enabled,
    queryFn: () => fetchLab("/metrics", LabMetricsSchema),
    queryKey: ["lab-metrics"],
  });
  const experiments = useQuery({
    enabled,
    queryFn: () => fetchLab("/experiments", ExperimentListSchema),
    queryKey: ["lab-experiments"],
    refetchInterval: 30_000,
  });
  const borderline = useQuery({
    enabled,
    queryFn: () =>
      fetchLab(
        "/borderline?limit=25",
        z.object({ items: BorderlinePairSchema.array() }),
      ),
    queryKey: ["lab-borderline"],
  });
  const labels = useQuery({
    enabled,
    queryFn: () =>
      fetchLab(
        "/labels",
        z.object({ count: z.number(), labels: z.unknown().array() }),
      ),
    queryKey: ["lab-labels"],
  });

  if (capability.data?.status === "not_enabled") {
    return (
      <div className="not-enabled">
        <span className="eyebrow">Not enabled</span>
        <h2>Clustering lab</h2>
        <p>{capability.data.reason}</p>
      </div>
    );
  }

  const summary = corpus.data;
  const runs = experiments.data?.items ?? [];
  const newest = runs[0];
  const baseline = runs.find((run) => run.id === baselineId);
  const attachMax = Math.max(
    1,
    ...(metrics.data?.attachMix.map((row) => row.count) ?? [1]),
  );

  return (
    <div className="page-stack">
      <section className="page-intro">
        <span className="section-index">L</span>
        <div>
          <p className="eyebrow">Experiment bench</p>
          <h1>Lab</h1>
          <p>
            Replay the synced corpus through the clustering pipeline, measure
            the chains it builds, and label its borderline decisions.
          </p>
        </div>
      </section>

      <section className="receipt-grid" id="corpus">
        {corpus.isLoading ? (
          <LoadingState label="Loading corpus receipt" />
        ) : corpus.error ? (
          <ErrorState error={corpus.error} />
        ) : summary === undefined ? null : (
          <>
            <div className="receipt-primary">
              <span className="eyebrow">Corpus entries</span>
              <strong>{summary.entries.toLocaleString()}</strong>
              <span>
                {summary.firstPublishedAt ?? "—"} →{" "}
                {summary.lastPublishedAt ?? "—"} · {summary.sources} sources
              </span>
            </div>
            <dl className="metric-list">
              <div>
                <dt>Embedded</dt>
                <dd>{summary.embedded.toLocaleString()}</dd>
              </div>
              <div>
                <dt>Enriched</dt>
                <dd>{summary.enriched.toLocaleString()}</dd>
              </div>
              <div>
                <dt>Clustered</dt>
                <dd>{summary.clustered.toLocaleString()}</dd>
              </div>
              <div>
                <dt>Needs prepare</dt>
                <dd>
                  {summary.needsPrepare > 0 ? (
                    <StatusMark
                      label={`${summary.needsPrepare.toLocaleString()} — run form auto-prepares`}
                      status="attention"
                    />
                  ) : (
                    "0"
                  )}
                </dd>
              </div>
            </dl>
          </>
        )}
      </section>

      <RunSection
        disabledReason={
          capability.data === undefined
            ? "Loading capability"
            : !capability.data.experimentsEnabled
              ? (capability.data.experimentsReason ??
                "Experiments are not enabled")
              : experiments.data?.active
                ? `Experiment "${experiments.data.active.name}" is running`
                : null
        }
      />

      <section className="ruled-section" id="experiments">
        <SectionHeading
          index="III"
          title="Experiment runs"
          aside={<CopyCommand command="pnpm ops lab experiments" />}
        />
        {runs.length === 0 ? (
          <p className="empty-row">
            No experiment runs recorded yet — failed runs are not recorded.
          </p>
        ) : (
          <div className="table-scroll">
            <table>
              <thead>
                <tr>
                  <th>Run</th>
                  <th>Created</th>
                  <th>Duration</th>
                  <th>Processed</th>
                  <th>Episodes</th>
                  <th>Chains</th>
                  <th>Cache h/m</th>
                  <th>Report</th>
                  <th>Baseline</th>
                </tr>
              </thead>
              <tbody>
                {runs.map((run) => (
                  <tr key={run.id}>
                    <th className="mono" scope="row">
                      {run.name}
                    </th>
                    <td>{new Date(run.createdAt).toLocaleString()}</td>
                    <td className="numeric">{run.durationSeconds}s</td>
                    <td className="numeric">
                      {run.clusterReport?.processed ?? "—"}
                    </td>
                    <td className="numeric">{run.summary?.episodes ?? "—"}</td>
                    <td className="numeric">
                      {run.summary?.multi_episode_storylines ?? "—"}
                    </td>
                    <td className="numeric">
                      {run.cacheHits}/{run.cacheMisses}
                    </td>
                    <td>
                      <a
                        className="text-button"
                        href={`/api/lab/experiments/${run.id}/report`}
                        rel="noreferrer"
                        target="_blank"
                      >
                        report
                      </a>
                    </td>
                    <td>
                      <button
                        className="row-button"
                        onClick={() => setBaselineId(run.id)}
                        type="button"
                      >
                        {baselineId === run.id ? "selected" : "compare"}
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
        {baseline !== undefined && newest !== undefined ? (
          <>
            <div className="table-scroll">
              <table>
                <thead>
                  <tr>
                    <th>Metric</th>
                    <th>{baseline.name}</th>
                    <th>{newest.name} (newest)</th>
                    <th>Delta</th>
                  </tr>
                </thead>
                <tbody>
                  {summaryRows(baseline).map(([label, left], index) => {
                    const right = summaryRows(newest)[index][1];
                    const delta =
                      left === null || right === null ? null : right - left;
                    return (
                      <tr key={label}>
                        <th scope="row">{label}</th>
                        <td className="numeric">{left ?? "—"}</td>
                        <td className="numeric">{right ?? "—"}</td>
                        <td
                          className={`numeric ${
                            delta === null || delta === 0
                              ? ""
                              : delta > 0
                                ? "delta-up"
                                : "delta-down"
                          }`}
                        >
                          {delta === null
                            ? "—"
                            : `${delta > 0 ? "+" : ""}${Number(delta.toFixed(4))}`}
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
            {configDiff(baseline.config, newest.config).length === 0 ? (
              <p className="empty-row">Identical configs.</p>
            ) : (
              <ul className="component-list">
                {configDiff(baseline.config, newest.config).map((row) => (
                  <li key={row.key}>
                    <span className="mono">{row.key}</span>
                    <strong className="mono">
                      {row.left} → {row.right}
                    </strong>
                    <span>config diff</span>
                  </li>
                ))}
              </ul>
            )}
          </>
        ) : null}
      </section>

      <section className="ruled-section" id="quality">
        <SectionHeading
          index="IV"
          title="Quality"
          aside={<CopyCommand command="pnpm ops lab metrics" />}
        />
        {metrics.isLoading ? (
          <LoadingState />
        ) : metrics.error ? (
          <ErrorState error={metrics.error} />
        ) : metrics.data === undefined ? null : metrics.data.volume
            .episodes === 0 ? (
          <p className="empty-row">
            No clustered state to measure — run an experiment first.
          </p>
        ) : (
          <>
            <div className="table-scroll">
              <table>
                <thead>
                  <tr>
                    <th>Attach method</th>
                    <th>Count</th>
                    <th />
                    <th>Avg similarity</th>
                  </tr>
                </thead>
                <tbody>
                  {metrics.data.attachMix.map((row) => (
                    <tr key={row.method}>
                      <th className="mono" scope="row">
                        {row.method}
                      </th>
                      <td className="numeric">{row.count}</td>
                      <td>
                        <Meter count={row.count} max={attachMax} />
                      </td>
                      <td className="numeric">{row.avgSimilarity ?? "—"}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            <p className="source-note">
              singleton episode rate {metrics.data.singletonEpisodeRate ?? "—"}{" "}
              · syndication {metrics.data.syndicationRate ?? "—"} · calibration
              pairs {metrics.data.calibration.pairCount} · suggested
              NEAR_DUP_THRESHOLD{" "}
              {metrics.data.calibration.suggestedNearDupThreshold ?? "—"}
            </p>
          </>
        )}
      </section>

      <section className="ruled-section" id="labels">
        <SectionHeading
          index="V"
          title="Label queue"
          aside={<CopyCommand command="pnpm ops lab borderline --limit 25" />}
        />
        <p className="source-note">
          {labels.data === undefined
            ? ""
            : `${labels.data.count} labeled pairs in docs/eval/labels.csv — the future eval harness's --labels input.`}
        </p>
        {borderline.data?.items.length === 0 ? (
          <p className="empty-row">
            No borderline attach decisions within 0.03 of a threshold.
          </p>
        ) : (
          <div className="table-scroll">
            <table>
              <thead>
                <tr>
                  <th>Entry</th>
                  <th>Matched</th>
                  <th>Method</th>
                  <th>Similarity</th>
                  <th>Same event?</th>
                </tr>
              </thead>
              <tbody>
                {borderline.data?.items.map((pair) => (
                  <tr key={`${pair.entryId}-${pair.matchedEntryId}`}>
                    <th scope="row">{pair.entryTitle ?? pair.entryId}</th>
                    <td>{pair.matchedTitle ?? pair.matchedEntryId ?? "—"}</td>
                    <td className="mono">{pair.attachMethod}</td>
                    <td className="mono">
                      {pair.similarity.toFixed(3)} /{" "}
                      {pair.thresholdUsed.toFixed(2)}
                    </td>
                    <td>
                      {pair.matchedEntryId === null ? (
                        "—"
                      ) : (
                        <span className="label-actions">
                          {(["y", "n"] as const).map((verdict) => (
                            <button
                              key={verdict}
                              onClick={() => {
                                void postLab(
                                  "/labels",
                                  {
                                    entryA: pair.entryId,
                                    entryB: pair.matchedEntryId,
                                    sameEvent: verdict === "y",
                                  },
                                  z.object({ saved: z.boolean() }),
                                ).then(() => {
                                  void queryClient.invalidateQueries({
                                    queryKey: ["lab-borderline"],
                                  });
                                  void queryClient.invalidateQueries({
                                    queryKey: ["lab-labels"],
                                  });
                                });
                              }}
                              type="button"
                            >
                              {verdict}
                            </button>
                          ))}
                        </span>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>
    </div>
  );
}
```

- [ ] **Step 3: Add the nav entry and route**

In `App.tsx`: `import { LabPage } from "./pages/LabPage";`, add `["/lab", "Lab"]` after System in `navigation`, and add `<Route element={<LabPage />} path="/lab" />`.

- [ ] **Step 4: Run tests to verify they pass**

Run: `pnpm --filter @dot-gov-news/operator-console test -- lab-page`, then the full suite and typecheck.
Expected: PASS; no regressions.

- [ ] **Step 5: Commit**

```bash
git add apps/operator-console/src/ui/pages/LabPage.tsx apps/operator-console/src/ui/App.tsx apps/operator-console/test/lab-page.test.tsx
git commit -m "feat: add clustering lab page (runs, comparisons, label queue)

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 10: End-to-end verification + runbook

**Files:**
- Create: `docs/operations/clustering-lab.md`

- [ ] **Step 1: Full static + unit verification**

```bash
pnpm lint && pnpm typecheck && pnpm test
LAB_DB_TESTS=1 pnpm --filter @dot-gov-news/operator-console test
```

Expected: everything green (local Supabase running with all migrations for the gated suite).

- [ ] **Step 2: End-to-end smoke against the synced corpus**

```bash
uv run python -m pipeline.cli sync            # if not already synced (6,553 entries)
uv run python -m pipeline.cli prepare --stub --limit 200
pnpm ops lab corpus                           # entries + needsPrepare visible
pnpm ops lab run --name lab-smoke --stub --limit 200
pnpm ops lab experiments                      # lab-smoke row with duration + cache stats
pnpm ops lab storylines --min-episodes 2
pnpm ops lab run --name lab-smoke-2 --stub --limit 200 --set NEAR_DUP_THRESHOLD=0.87
```

Then `pnpm ops dashboard`:
- Storylines: chain count hero, a multi-episode chain row → detail: episode rail with attach tags, syndicated `content_hash` entries, overview timeline citations, entry inspector opens/closes with Escape.
- Lab: corpus receipt with needs-prepare state, start a stub run from the form and watch stages stream, run appears in the history table when done, select `lab-smoke` as baseline → summary deltas + config diff shows `near_dup_threshold · 0.9 → 0.87`, open a run's report in a new tab, label one borderline pair (row disappears, `docs/eval/labels.csv` gains a row), quality meters render in both themes (toggle ○/●) and at 375 px width.
- Without `DATABASE_URL` resolving: both pages show the Not enabled block; `/api/lab/corpus` returns 503. With a **remote** `DATABASE_URL`: Storylines works read-only, the Lab run form is disabled with the local-DSN reason.

- [ ] **Step 3: Write the runbook**

```markdown
<!-- docs/operations/clustering-lab.md -->
# Clustering Lab

The operator console's QA and experiment surface for the clustering pipeline.
Reads the database at `DATABASE_URL` directly (read-only); experiments shell
out to the pipeline experiment CLI (`uv run python -m pipeline.cli …`), which
records every completed run in the `experiment_runs` table and writes
`docs/eval/<name>/report.md`.

## Setup

1. `DATABASE_URL` in the root `.env` (local default
   `postgresql://postgres:postgres@127.0.0.1:54322/postgres`). Reads work
   against any DSN; experiments require a local one (the pipeline bench tools
   structurally refuse remote hosts).
2. Local stack + migrations: `pnpm supabase start` (schema through
   `20260718100200_create_experiment_runs`).
3. Corpus synced: `uv run python -m pipeline.cli sync` (hosted → local,
   id-preserving). Features prepared once: `uv run python -m pipeline.cli
   prepare` — the lab's run form auto-includes this when entries still need it.
4. The `uv` toolchain (experiment stages spawn the pipeline CLI).

## The loop

| Step | Dashboard | CLI |
| --- | --- | --- |
| Inspect the corpus | Lab § Corpus | `pnpm ops lab corpus` |
| Run an experiment | Lab § Run experiment | `pnpm ops lab run --name baseline --stub` |
| Sweep a threshold | Lab § Run (override fields) | `pnpm ops lab run --name sweep --set NEAR_DUP_THRESHOLD=0.87` |
| Feature-level A/B | Lab § Run ("Re-embed") | `pnpm ops lab run --name no-enrich --clear-features --set ENRICHMENT_ENABLED=false` |
| QA the chains | Storylines → chain detail | `pnpm ops lab storyline <id>` |
| Read quality metrics | Lab § Quality | `pnpm ops lab metrics` |
| Compare runs | Lab § Experiment runs (baseline + config diff) | `pnpm ops lab experiments` + `diff docs/eval/<a>/report.md docs/eval/<b>/report.md` |
| Label borderline pairs | Lab § Label queue | `pnpm ops lab borderline` (labels land in `docs/eval/labels.csv`) |

Notes:
- Each experiment resets **derived** clustering state only; the synced corpus
  and its features survive. "Re-embed" (`--clear-features`) is for runs that
  change `EMBEDDING_MODEL`, `ENRICHER_MODEL`, or `ENRICHMENT_ENABLED` — it
  re-runs the expensive prepare phase.
- One experiment at a time. Repeat runs are fast: features are cached in the
  DB and adjudicator decisions in `.cache/decisions.sqlite` (hits/misses are
  shown per run).
- The clustering tables always hold the **latest** run's state (Storylines and
  Quality describe it); run history and comparisons come from
  `experiment_runs`, which survives resets. Failed runs are not recorded.
- Labels are corpus-level ground truth collected for the future eval harness
  (`eval --labels`); they survive resets.
```

- [ ] **Step 4: Regenerate the cheatsheet if recipes changed, final commit**

```bash
pnpm ops docs:generate
git add docs/operations/clustering-lab.md docs/operations/cli-cheatsheet.md
git commit -m "docs: add clustering lab runbook

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

## The QA loop this enables

```bash
pnpm supabase start && uv run python -m pipeline.cli sync
uv run python -m pipeline.cli prepare                     # once (~10-15 min real models)
pnpm ops lab run --name baseline --limit 1000             # or from Lab § Run experiment
pnpm ops dashboard                                        # Storylines: eyeball the chains
pnpm ops lab run --name near-dup-0.87 --limit 1000 --set NEAR_DUP_THRESHOLD=0.87
pnpm ops lab run --name ema-5 --limit 1000 --set AMBIENT_EMA_CEILING=5
# Lab § Experiment runs: baseline vs each sweep — summary deltas + config diff
# Lab § Label queue: label borderline pairs while QAing chains
```

## Landing the stack (merge order)

The branch topology after this plan executes: `main` → `clustering-processing-pipeline` (pipeline + experiment CLI, unmerged) → `clustering-lab` (this plan). Landing sequence:

1. **Evaluate with the lab.** That is the pipeline branch's merge gate: chain quality on Storylines, attach mix / singleton rate / calibration on Quality, threshold sweeps compared in Experiment runs.
2. **Pipeline validates → merge `clustering-processing-pipeline` into main**, then merge `clustering-lab` (near-fast-forward; the only files both stacks plausibly touch are `.env.example` and `pnpm-lock.yaml`). Merging the lab into the pipeline branch first and landing both as one unit is equally fine.
3. **Pipeline needs rework instead →** keep the lab branch; it re-stacks onto the reworked branch cheaply. Only the harness (CLI subcommands), `ExperimentRunSchema` (jsonb payloads), and the `experiment_runs` reads are coupled — everything else reads the data-model tables already on main.
4. **Don't let the stack age.** The lab adds the `postgres` dependency to `apps/operator-console/package.json` + `pnpm-lock.yaml`; if main's console keeps evolving, lockfile conflicts grow. Weeks fine, months not.

## Deliberately out of scope (follow-up plans)

- **Label scoring** — pairwise P/R/F1 and B-Cubed belong to the deferred pipeline eval harness; the lab collects `docs/eval/labels.csv` in exactly the contract it will consume.
- **Per-run cluster snapshots** — the clustering tables hold only the latest run's assignments; comparing *cluster contents* (not just summary stats) across runs needs the run-id-stamped junction copy the experiment CLI plan explicitly deferred until the dashboard design demands it. Revisit if summary + report diffs prove insufficient.
- **Triggering `sync` from the dashboard** — one-time setup with hosted credentials; keep it in the terminal.
- **Embedding-space projection** (UMAP/t-SNE) — the similarity distributions + borderline queue cover the same questions numerically.
- **Editing clusters from the UI** (manual merge/split) — consolidation belongs to the pipeline's nightly pass; the lab observes and labels.
- **Operator-api / hosted exposure of lab endpoints** — loopback-only by design.
- **Experiment queueing / parallel runs** — one bench DB, one clustering state, one run at a time.
- **Auto-applying suggested thresholds** — the Quality section suggests, the operator decides.
