# Local Dev Onboarding Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** An invited collaborator clones the repo and reaches a working local experiment loop (hosted corpus synced, entries re-embedded with their own Cloudflare Workers AI account) with `mise install && pnpm install` then `pnpm ops onboard`.

**Architecture:** Zero-handoff hosted read access via the Supabase publishable key (committed in `config/hosted.json`) plus anon RLS SELECT policies on exactly three corpus tables. New operator-console commands (`ops doctor`, `ops env init`, `ops onboard`) wrap the existing `pipeline sync` / `prepare` / `experiment` loop. An optional `corpus_reader` Postgres role serves direct hosted reads.

**Tech Stack:** TypeScript (commander, tsx, vitest, `postgres` package) in `apps/operator-console`; Python 3.12 (argparse, httpx, pytest) in `pipeline/`; Supabase migrations + pgTAP.

**Spec:** `docs/archive/design-specs/2026-07-19-local-dev-onboarding-design.md`

## Global Constraints

- `DATABASE_URL` never goes in `.env` or `.env.example` as an active line (comment-only). Local default DSN is `postgresql://postgres:postgres@127.0.0.1:57422/postgres`.
- Anon/`corpus_reader` read access covers exactly three tables: `news_entries`, `news_sources`, `news_source_publishers`. Nothing else.
- `.env` is written atomically at mode 0600 (reuse `writePrivateFileAtomically` from `apps/operator-console/src/setup-helpers.ts`).
- Match existing code style: 4-space Python, existing operator-console TS conventions, prettier-formatted.
- Python invocations from TS use `uv run python -m pipeline.cli …` (pattern from `apps/operator-console/src/lab/harness.ts:156`).
- Run TS tests with `pnpm --filter @dot-gov-news/operator-console test`, Python tests with `uv run pytest`, db tests with `pnpm supabase test db`.
- Commit messages end with `Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>`.
- One spec deviation, approved during planning: no read-only pipeline CLI command exists today, so there is no `--hosted` read flag. The local-DSN guard covers ALL pipeline CLI commands; direct-read mode is documented as `psql "$HOSTED_READONLY_DATABASE_URL"`.

---

### Task 1: Toolchain and hosted-identifier config

**Files:**
- Modify: `mise.toml`
- Create: `config/hosted.json`
- Modify: `.env.example`

**Interfaces:**
- Produces: `config/hosted.json` with keys `supabaseUrl` (string) and `publishableKey` (string). A `publishableKey` starting with `REPLACE_` means "not yet configured" — Tasks 3 and 5 rely on this sentinel.

- [ ] **Step 1: Extend mise.toml**

Replace the full contents of `mise.toml` with:

```toml
[tools]
node = "24"
pnpm = "11.9.0"
uv = "latest"
```

(pnpm version must match the `packageManager` field in `package.json`.)

- [ ] **Step 2: Verify mise config parses**

Run: `mise ls`
Expected: lists node, pnpm, uv without error (they may show as not-installed; that is fine).

- [ ] **Step 3: Create config/hosted.json**

```json
{
  "supabaseUrl": "https://qdqmahimrnwhzdjlcont.supabase.co",
  "publishableKey": "REPLACE_WITH_SB_PUBLISHABLE_KEY"
}
```

These identifiers are not secrets (see `docs/infrastructure/access.md`). The real publishable key is pasted in during Task 9 (hosted rollout).

- [ ] **Step 4: Verify JSON parses**

Run: `node -e "console.log(JSON.parse(require('fs').readFileSync('config/hosted.json','utf8')).supabaseUrl)"`
Expected: `https://qdqmahimrnwhzdjlcont.supabase.co`

- [ ] **Step 5: Update .env.example**

Append to `.env.example`:

```
# Optional: read-only Postgres DSN for live queries against hosted data.
# Handed out individually — ask the repo owner. `pnpm ops env init` fills it.
# HOSTED_READONLY_DATABASE_URL=
```

Also change the header comment block: after the first line `# Copy this file to .env and fill in the values locally.`, add:

```
# Contributors: run `pnpm ops env init` instead of editing by hand.
# Only CLOUDFLARE_ACCOUNT_ID and CLOUDFLARE_API_TOKEN are required for
# local experiments; the rest is operator/deploy tooling.
```

- [ ] **Step 6: Commit**

```bash
git add mise.toml config/hosted.json .env.example
git commit -m "feat: add toolchain pins and hosted identifier config for onboarding"
```

---

### Task 2: Anon corpus-read migration + pgTAP test

**Files:**
- Create: `supabase/migrations/20260719120000_grant_corpus_read.sql`
- Test: `supabase/tests/database/corpus_read_grants.test.sql`

**Interfaces:**
- Produces: `anon` role can SELECT the three corpus tables via PostgREST (publishable key). `corpus_reader` role (nologin locally; login enabled manually on hosted in Task 9) can SELECT the same three tables over a direct connection.

- [ ] **Step 1: Write the failing pgTAP test**

Create `supabase/tests/database/corpus_read_grants.test.sql`:

```sql
begin;

select plan(9);

set local role anon;

select lives_ok(
    'select id from public.news_sources limit 1',
    'anon can select news_sources');
select lives_ok(
    'select news_source_id from public.news_source_publishers limit 1',
    'anon can select news_source_publishers');
select lives_ok(
    'select id from public.news_entries limit 1',
    'anon can select news_entries');

select throws_ok(
    'select id from public.pipeline_events limit 1',
    '42501', null, 'anon cannot select pipeline_events');
select throws_ok(
    'select id from public.experiment_runs limit 1',
    '42501', null, 'anon cannot select experiment_runs');
select throws_ok(
    'select id from public.storylines limit 1',
    '42501', null, 'anon cannot select storylines');
select throws_ok(
    'insert into public.news_entries (id) values (null)',
    '42501', null, 'anon cannot insert news_entries');

reset role;
set local role corpus_reader;

select lives_ok(
    'select id from public.news_entries limit 1',
    'corpus_reader can select news_entries');
select throws_ok(
    'select id from public.pipeline_events limit 1',
    '42501', null, 'corpus_reader cannot select pipeline_events');

reset role;
select * from finish();
rollback;
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm supabase test db`
Expected: FAIL — anon selects raise 42501 (no grants yet) and `set local role corpus_reader` errors (role does not exist).

(Requires local stack: `pnpm supabase start` first if not running.)

- [ ] **Step 3: Write the migration**

Create `supabase/migrations/20260719120000_grant_corpus_read.sql`:

```sql
-- Invited contributors read the corpus two ways: the repo's committed
-- publishable key (anon role, PostgREST) and an optional direct read-only
-- role. Both are limited to exactly the three corpus tables that
-- pipeline sync copies. corpus_reader is created nologin; hosted rollout
-- enables login with a password manually (never in a migration).

begin;

do $$
begin
    if not exists (select 1 from pg_roles where rolname = 'corpus_reader') then
        create role corpus_reader nologin noinherit;
    end if;
end $$;

grant usage on schema public to corpus_reader;

grant select on table public.news_sources to anon, corpus_reader;
grant select on table public.news_source_publishers to anon, corpus_reader;
grant select on table public.news_entries to anon, corpus_reader;

alter table public.news_sources enable row level security;
alter table public.news_source_publishers enable row level security;
alter table public.news_entries enable row level security;

create policy corpus_read on public.news_sources
    for select to anon, corpus_reader using (true);
create policy corpus_read on public.news_source_publishers
    for select to anon, corpus_reader using (true);
create policy corpus_read on public.news_entries
    for select to anon, corpus_reader using (true);

commit;
```

- [ ] **Step 4: Apply and run test to verify it passes**

Run: `pnpm supabase db reset && pnpm supabase test db`
Expected: all pgTAP files PASS, including `corpus_read_grants` 9/9.

- [ ] **Step 5: Run the pipeline test suite to catch grant regressions**

Run: `uv run pytest`
Expected: PASS (no pipeline behavior changed; guard against accidental grant fallout in fixtures).

- [ ] **Step 6: Commit**

```bash
git add supabase/migrations/20260719120000_grant_corpus_read.sql supabase/tests/database/corpus_read_grants.test.sql
git commit -m "feat: grant anon and corpus_reader read access to the three corpus tables"
```

---

### Task 3: Publishable-key sync (`pipeline/hosted.py`)

**Files:**
- Create: `pipeline/hosted.py`
- Modify: `pipeline/cli.py:152-154` (the `sync` branch)
- Test: `tests/test_hosted.py`

**Interfaces:**
- Consumes: `config/hosted.json` from Task 1 (sentinel prefix `REPLACE_`).
- Produces: `load_hosted(path: Path | None = None) -> tuple[str, str]` returning `(supabase_url, publishable_key)`. Raises `RuntimeError` when the key is unconfigured. Env overrides: `SUPABASE_URL`, `SUPABASE_PUBLISHABLE_KEY`.

- [ ] **Step 1: Write the failing tests**

Create `tests/test_hosted.py`:

```python
# tests/test_hosted.py
import json

import pytest

from pipeline.hosted import load_hosted


def _write(tmp_path, url="https://x.supabase.co", key="sb_publishable_abc"):
    path = tmp_path / "hosted.json"
    path.write_text(json.dumps({"supabaseUrl": url, "publishableKey": key}))
    return path


def test_load_hosted_reads_checked_in_config(tmp_path, monkeypatch):
    monkeypatch.delenv("SUPABASE_URL", raising=False)
    monkeypatch.delenv("SUPABASE_PUBLISHABLE_KEY", raising=False)
    url, key = load_hosted(_write(tmp_path))
    assert url == "https://x.supabase.co"
    assert key == "sb_publishable_abc"


def test_env_overrides_win(tmp_path, monkeypatch):
    monkeypatch.setenv("SUPABASE_URL", "https://other.supabase.co")
    monkeypatch.setenv("SUPABASE_PUBLISHABLE_KEY", "sb_publishable_env")
    url, key = load_hosted(_write(tmp_path))
    assert url == "https://other.supabase.co"
    assert key == "sb_publishable_env"


def test_placeholder_key_rejected(tmp_path, monkeypatch):
    monkeypatch.delenv("SUPABASE_URL", raising=False)
    monkeypatch.delenv("SUPABASE_PUBLISHABLE_KEY", raising=False)
    with pytest.raises(RuntimeError, match="publishable key not configured"):
        load_hosted(_write(tmp_path, key="REPLACE_WITH_SB_PUBLISHABLE_KEY"))


def test_default_path_points_at_repo_config():
    from pipeline.hosted import _DEFAULT_PATH
    assert _DEFAULT_PATH.name == "hosted.json"
    assert _DEFAULT_PATH.parent.name == "config"
    assert _DEFAULT_PATH.exists()
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `uv run pytest tests/test_hosted.py -v`
Expected: FAIL with `ModuleNotFoundError: No module named 'pipeline.hosted'`

- [ ] **Step 3: Implement pipeline/hosted.py**

```python
# pipeline/hosted.py
"""Hosted Supabase identifiers for read-only corpus access.

config/hosted.json is committed (publishable key + project URL are safe to
expose); env vars override it for forks or key rotation.
"""

from __future__ import annotations

import json
import os
from pathlib import Path

_PLACEHOLDER_PREFIX = "REPLACE_"
_DEFAULT_PATH = Path(__file__).resolve().parent.parent / "config" / "hosted.json"


def load_hosted(path: Path | None = None) -> tuple[str, str]:
    data = json.loads((path or _DEFAULT_PATH).read_text())
    url = os.environ.get("SUPABASE_URL") or data["supabaseUrl"]
    key = os.environ.get("SUPABASE_PUBLISHABLE_KEY") or data["publishableKey"]
    if key.startswith(_PLACEHOLDER_PREFIX):
        raise RuntimeError(
            "publishable key not configured: set SUPABASE_PUBLISHABLE_KEY or "
            "fill config/hosted.json (see docs/infrastructure/access.md)")
    return url, key
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `uv run pytest tests/test_hosted.py -v`
Expected: 4 PASS

- [ ] **Step 5: Switch the sync branch to the publishable key**

In `pipeline/cli.py`, replace:

```python
    if args.command == "sync":
        from pipeline.bench import sync_corpus
        out = sync_corpus(db, os.environ["SUPABASE_URL"], os.environ["SUPABASE_SECRET_KEY"])
```

with:

```python
    if args.command == "sync":
        from pipeline.bench import sync_corpus
        from pipeline.hosted import load_hosted
        url, key = load_hosted()
        out = sync_corpus(db, url, key)
```

`sync_corpus` itself is unchanged — it already just sends whatever key it is given as `apikey`/Bearer headers.

- [ ] **Step 6: Run full pipeline tests**

Run: `uv run pytest`
Expected: PASS (existing `tests/test_bench.py` sync tests still pass — they call `sync_corpus` directly with a fake key).

- [ ] **Step 7: Commit**

```bash
git add pipeline/hosted.py pipeline/cli.py tests/test_hosted.py
git commit -m "feat: sync hosted corpus with the committed publishable key"
```

---

### Task 4: Local-DSN guard for all pipeline CLI commands

**Files:**
- Modify: `pipeline/cli.py` (in `main()`, between `cfg = load_config()` and `db = Db(cfg.database_url)`)
- Test: `tests/test_cli_guard.py`

**Interfaces:**
- Consumes: `assert_local_dsn(dsn: str)` from `pipeline/bench.py` (raises `RuntimeError` for non-local host/hostaddr).
- Produces: every `python -m pipeline.cli …` invocation refuses a remote `DATABASE_URL` before opening a connection.

- [ ] **Step 1: Write the failing test**

Create `tests/test_cli_guard.py`:

```python
# tests/test_cli_guard.py
import sys

import pytest

from pipeline import cli


def _base_env(monkeypatch):
    monkeypatch.setenv("CLOUDFLARE_ACCOUNT_ID", "acct")
    monkeypatch.setenv("CLOUDFLARE_API_TOKEN", "token")


def test_cli_refuses_remote_database_url(monkeypatch):
    _base_env(monkeypatch)
    monkeypatch.setenv(
        "DATABASE_URL",
        "postgresql://corpus_reader:pw@aws-1-us-east-2.pooler.supabase.com:5432/postgres")
    monkeypatch.setattr(sys, "argv", ["pipeline", "reset", "--clusters"])
    with pytest.raises(RuntimeError, match="non-local database"):
        cli.main()


def test_cli_guard_runs_before_any_connection(monkeypatch):
    # The guard must fire before Db() attempts a connection: with a remote
    # DSN and no reachable database anywhere, the error is the guard's
    # RuntimeError, not a psycopg connection failure.
    _base_env(monkeypatch)
    monkeypatch.setenv(
        "DATABASE_URL", "postgresql://u:p@db.example.supabase.co:5432/postgres")
    monkeypatch.setattr(sys, "argv", ["pipeline", "sync"])
    with pytest.raises(RuntimeError, match="non-local database"):
        cli.main()
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `uv run pytest tests/test_cli_guard.py -v`
Expected: FAIL — psycopg `OperationalError` (connection attempt to a remote host) instead of the guard's `RuntimeError`, or a hang-then-timeout. Either way, not the expected RuntimeError.

- [ ] **Step 3: Add the guard**

In `pipeline/cli.py` `main()`, change:

```python
    cfg = load_config()
    db = Db(cfg.database_url)
```

to:

```python
    cfg = load_config()
    # Experiments are local-only; hosted writes go through the worker RPCs.
    # Direct hosted reads use psql with HOSTED_READONLY_DATABASE_URL instead.
    from pipeline.bench import assert_local_dsn
    assert_local_dsn(cfg.database_url)
    db = Db(cfg.database_url)
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `uv run pytest tests/test_cli_guard.py -v`
Expected: 2 PASS

- [ ] **Step 5: Run full pipeline tests**

Run: `uv run pytest`
Expected: PASS

- [ ] **Step 6: Commit**

```bash
git add pipeline/cli.py tests/test_cli_guard.py
git commit -m "feat: refuse remote DATABASE_URL in every pipeline CLI command"
```

---

### Task 5: `ops doctor`

**Files:**
- Create: `apps/operator-console/src/onboarding/checks.ts`
- Modify: `apps/operator-console/src/cli.ts` (register `doctor` command; add near the existing top-level commands, e.g. after the `queues` block around line 124)
- Test: `apps/operator-console/src/onboarding/checks.test.ts`

**Interfaces:**
- Consumes: `repositoryRoot` from `../config`; `config/hosted.json` sentinel from Task 1.
- Produces (used by Tasks 6 and 7):
  - `interface CheckResult { name: string; ok: boolean; detail: string; fix?: string }`
  - `interface DoctorDeps { execVersion(cmd: string, args: string[]): Promise<string | null>; fetchImpl: typeof fetch; probeSql(dsn: string): Promise<string | null>; env: Record<string, string | undefined>; hosted: { supabaseUrl: string; publishableKey: string } }`
  - `runDoctor(deps: DoctorDeps, opts?: { toolingOnly?: boolean }): Promise<CheckResult[]>`
  - `defaultDoctorDeps(): DoctorDeps`
  - `LOCAL_DSN = "postgresql://postgres:postgres@127.0.0.1:57422/postgres"`
  - `validateCloudflare(deps, accountId, token): Promise<string | null>` (null = valid, string = error detail)

- [ ] **Step 1: Write the failing tests**

Create `apps/operator-console/src/onboarding/checks.test.ts`:

```ts
import { describe, expect, it } from "vitest";

import { runDoctor, type DoctorDeps } from "./checks";

function fakeDeps(overrides: Partial<DoctorDeps> = {}): DoctorDeps {
  return {
    execVersion: async (cmd) =>
      ({
        mise: "2026.7.1",
        node: "v24.4.0",
        pnpm: "11.9.0",
        uv: "uv 0.9.2",
        docker: "28.1.0",
      })[cmd] ?? null,
    fetchImpl: (async () =>
      new Response(JSON.stringify({ success: true, result: [] }), {
        status: 200,
      })) as typeof fetch,
    probeSql: async () => null,
    env: {
      CLOUDFLARE_ACCOUNT_ID: "acct",
      CLOUDFLARE_API_TOKEN: "token",
    },
    hosted: {
      supabaseUrl: "https://x.supabase.co",
      publishableKey: "sb_publishable_abc",
    },
    ...overrides,
  };
}

describe("runDoctor", () => {
  it("passes every check with a healthy environment", async () => {
    const results = await runDoctor(fakeDeps());
    expect(results.every((r) => r.ok)).toBe(true);
    expect(results.map((r) => r.name)).toContain("cloudflare token");
  });

  it("fails the node check on a wrong major version", async () => {
    const deps = fakeDeps({
      execVersion: async (cmd) => (cmd === "node" ? "v22.1.0" : "1.0.0"),
    });
    const results = await runDoctor(deps, { toolingOnly: true });
    const node = results.find((r) => r.name === "node");
    expect(node?.ok).toBe(false);
    expect(node?.fix).toContain("mise install");
  });

  it("reports a missing tool with its fix command", async () => {
    const deps = fakeDeps({ execVersion: async () => null });
    const results = await runDoctor(deps, { toolingOnly: true });
    expect(results.every((r) => !r.ok)).toBe(true);
    const docker = results.find((r) => r.name === "docker");
    expect(docker?.fix).toContain("Docker");
  });

  it("toolingOnly skips credential and database checks", async () => {
    const results = await runDoctor(fakeDeps(), { toolingOnly: true });
    const names = results.map((r) => r.name);
    expect(names).not.toContain("cloudflare token");
    expect(names).not.toContain("local database");
  });

  it("flags an unconfigured publishable key", async () => {
    const deps = fakeDeps({
      hosted: {
        supabaseUrl: "https://x.supabase.co",
        publishableKey: "REPLACE_WITH_SB_PUBLISHABLE_KEY",
      },
    });
    const results = await runDoctor(deps);
    const hosted = results.find((r) => r.name === "hosted corpus read");
    expect(hosted?.ok).toBe(false);
    expect(hosted?.fix).toContain("config/hosted.json");
  });

  it("fails the cloudflare check when credentials are absent", async () => {
    const results = await runDoctor(fakeDeps({ env: {} }));
    const cf = results.find((r) => r.name === "cloudflare token");
    expect(cf?.ok).toBe(false);
    expect(cf?.fix).toContain("pnpm ops env init");
  });

  it("treats the optional hosted DSN as ok when unset and failing when broken", async () => {
    const unset = await runDoctor(fakeDeps());
    expect(unset.find((r) => r.name === "hosted direct read")?.ok).toBe(true);

    const broken = await runDoctor(
      fakeDeps({
        env: {
          CLOUDFLARE_ACCOUNT_ID: "acct",
          CLOUDFLARE_API_TOKEN: "token",
          HOSTED_READONLY_DATABASE_URL: "postgresql://bad",
        },
        probeSql: async () => "connection refused",
      }),
    );
    expect(broken.find((r) => r.name === "hosted direct read")?.ok).toBe(false);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `pnpm --filter @dot-gov-news/operator-console test src/onboarding/checks.test.ts`
Expected: FAIL — `./checks` module not found.

- [ ] **Step 3: Implement checks.ts**

Create `apps/operator-console/src/onboarding/checks.ts`:

```ts
import { spawn } from "node:child_process";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import postgres from "postgres";

import { repositoryRoot } from "../config";

export const LOCAL_DSN =
  "postgresql://postgres:postgres@127.0.0.1:57422/postgres";

export interface CheckResult {
  name: string;
  ok: boolean;
  detail: string;
  fix?: string;
}

export interface HostedConfig {
  supabaseUrl: string;
  publishableKey: string;
}

export interface DoctorDeps {
  execVersion: (cmd: string, args: string[]) => Promise<string | null>;
  fetchImpl: typeof fetch;
  /** Returns null when `select 1` succeeds, else a short error detail. */
  probeSql: (dsn: string) => Promise<string | null>;
  env: Record<string, string | undefined>;
  hosted: HostedConfig;
}

const PLACEHOLDER_PREFIX = "REPLACE_";

export function loadHostedConfig(): HostedConfig {
  return JSON.parse(
    readFileSync(resolve(repositoryRoot, "config/hosted.json"), "utf8"),
  ) as HostedConfig;
}

export async function validateCloudflare(
  deps: Pick<DoctorDeps, "fetchImpl">,
  accountId: string,
  token: string,
): Promise<string | null> {
  try {
    const response = await deps.fetchImpl(
      `https://api.cloudflare.com/client/v4/accounts/${accountId}/ai/run/@cf/baai/bge-m3`,
      {
        method: "POST",
        headers: {
          Authorization: `Bearer ${token}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ text: ["doctor probe"] }),
      },
    );
    if (!response.ok) {
      return `Workers AI probe returned HTTP ${String(response.status)}`;
    }
    const body = (await response.json()) as { success?: boolean };
    return body.success ? null : "Workers AI probe returned success=false";
  } catch (error) {
    return `Workers AI probe failed: ${String(error)}`;
  }
}

async function toolChecks(deps: DoctorDeps): Promise<CheckResult[]> {
  const tools: Array<{
    name: string;
    cmd: string;
    args: string[];
    fix: string;
    validate?: (version: string) => string | null;
  }> = [
    {
      name: "mise",
      cmd: "mise",
      args: ["--version"],
      fix: "Install mise: https://mise.jdx.dev/getting-started.html",
    },
    {
      name: "node",
      cmd: "node",
      args: ["--version"],
      fix: "Run: mise install",
      validate: (v) =>
        v.startsWith("v24") ? null : `need node 24, found ${v}`,
    },
    { name: "pnpm", cmd: "pnpm", args: ["--version"], fix: "Run: mise install" },
    { name: "uv", cmd: "uv", args: ["--version"], fix: "Run: mise install" },
    {
      name: "docker",
      cmd: "docker",
      args: ["info", "--format", "{{.ServerVersion}}"],
      fix: "Install and start Docker Desktop: https://docs.docker.com/desktop/",
    },
    {
      name: "supabase",
      cmd: "pnpm",
      args: ["supabase", "--version"],
      fix: "Run: pnpm install",
    },
  ];
  return Promise.all(
    tools.map(async (tool) => {
      const version = await deps.execVersion(tool.cmd, tool.args);
      if (version === null) {
        return {
          name: tool.name,
          ok: false,
          detail: "not found or not running",
          fix: tool.fix,
        };
      }
      const invalid = tool.validate?.(version.trim()) ?? null;
      return invalid === null
        ? { name: tool.name, ok: true, detail: version.trim() }
        : { name: tool.name, ok: false, detail: invalid, fix: tool.fix };
    }),
  );
}

async function credentialChecks(deps: DoctorDeps): Promise<CheckResult[]> {
  const results: CheckResult[] = [];

  const localError = await deps.probeSql(LOCAL_DSN);
  results.push(
    localError === null
      ? { name: "local database", ok: true, detail: "reachable on 57422" }
      : {
          name: "local database",
          ok: false,
          detail: localError,
          fix: "Run: pnpm supabase start",
        },
  );

  const accountId = deps.env.CLOUDFLARE_ACCOUNT_ID;
  const token = deps.env.CLOUDFLARE_API_TOKEN;
  if (!accountId || !token) {
    results.push({
      name: "cloudflare token",
      ok: false,
      detail: "CLOUDFLARE_ACCOUNT_ID / CLOUDFLARE_API_TOKEN not set",
      fix: "Run: pnpm ops env init",
    });
  } else {
    const cfError = await validateCloudflare(deps, accountId, token);
    results.push(
      cfError === null
        ? { name: "cloudflare token", ok: true, detail: "Workers AI reachable" }
        : {
            name: "cloudflare token",
            ok: false,
            detail: cfError,
            fix: "Run: pnpm ops env init",
          },
    );
  }

  if (deps.hosted.publishableKey.startsWith(PLACEHOLDER_PREFIX)) {
    results.push({
      name: "hosted corpus read",
      ok: false,
      detail: "publishable key placeholder in config/hosted.json",
      fix: "Fill config/hosted.json (docs/infrastructure/access.md#hosted-rollout)",
    });
  } else {
    try {
      const response = await deps.fetchImpl(
        `${deps.hosted.supabaseUrl}/rest/v1/news_sources?select=id&limit=1`,
        {
          headers: {
            apikey: deps.hosted.publishableKey,
            Authorization: `Bearer ${deps.hosted.publishableKey}`,
          },
        },
      );
      results.push(
        response.ok
          ? { name: "hosted corpus read", ok: true, detail: "REST probe ok" }
          : {
              name: "hosted corpus read",
              ok: false,
              detail: `REST probe returned HTTP ${String(response.status)}`,
              fix: "Check config/hosted.json and hosted RLS grants",
            },
      );
    } catch (error) {
      results.push({
        name: "hosted corpus read",
        ok: false,
        detail: `REST probe failed: ${String(error)}`,
        fix: "Check network access to Supabase",
      });
    }
  }

  const hostedDsn = deps.env.HOSTED_READONLY_DATABASE_URL;
  if (!hostedDsn) {
    results.push({
      name: "hosted direct read",
      ok: true,
      detail: "not configured (optional)",
    });
  } else {
    const dsnError = await deps.probeSql(hostedDsn);
    results.push(
      dsnError === null
        ? { name: "hosted direct read", ok: true, detail: "select 1 ok" }
        : {
            name: "hosted direct read",
            ok: false,
            detail: dsnError,
            fix: "Ask the repo owner for a fresh corpus_reader DSN",
          },
    );
  }

  return results;
}

export async function runDoctor(
  deps: DoctorDeps,
  opts: { toolingOnly?: boolean } = {},
): Promise<CheckResult[]> {
  const tooling = await toolChecks(deps);
  if (opts.toolingOnly) return tooling;
  return [...tooling, ...(await credentialChecks(deps))];
}

export function defaultDoctorDeps(): DoctorDeps {
  return {
    execVersion: (cmd, args) =>
      new Promise((resolveVersion) => {
        const child = spawn(cmd, args, { stdio: ["ignore", "pipe", "ignore"] });
        let output = "";
        child.stdout.setEncoding("utf8");
        child.stdout.on("data", (chunk: string) => (output += chunk));
        child.once("error", () => resolveVersion(null));
        child.once("close", (code) =>
          resolveVersion(code === 0 ? output : null),
        );
      }),
    fetchImpl: fetch,
    probeSql: async (dsn) => {
      const sql = postgres(dsn, {
        max: 1,
        connect_timeout: 5,
        onnotice: () => undefined,
      });
      try {
        await sql`select 1`;
        return null;
      } catch (error) {
        return String(error);
      } finally {
        await sql.end({ timeout: 1 });
      }
    },
    env: process.env,
    hosted: loadHostedConfig(),
  };
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `pnpm --filter @dot-gov-news/operator-console test src/onboarding/checks.test.ts`
Expected: 7 PASS

- [ ] **Step 5: Register the doctor command in cli.ts**

Add to `apps/operator-console/src/cli.ts` after the `queues` command block:

```ts
program
  .command("doctor")
  .description("Check local toolchain, credentials, and hosted access")
  .option("--json", "machine-readable output")
  .action(async (options: { json?: boolean }) => {
    const { defaultDoctorDeps, runDoctor } = await import(
      "./onboarding/checks"
    );
    const results = await runDoctor(defaultDoctorDeps());
    if (options.json) {
      console.log(JSON.stringify(results, null, 2));
    } else {
      for (const result of results) {
        console.log(
          `${result.ok ? "✓" : "✗"} ${result.name} — ${result.detail}`,
        );
        if (!result.ok && result.fix) console.log(`    fix: ${result.fix}`);
      }
    }
    if (results.some((r) => !r.ok)) process.exitCode = 1;
  });
```

(Match surrounding cli.ts import style — if other commands import statically, use a static import instead of the dynamic one.)

- [ ] **Step 6: Manual smoke + typecheck**

Run: `pnpm --filter @dot-gov-news/operator-console typecheck && pnpm ops doctor`
Expected: typecheck clean; doctor prints check lines. On this machine mise/node/pnpm pass; failures (e.g. publishable-key placeholder) print a fix line and exit 1 — that is correct behavior right now.

- [ ] **Step 7: Commit**

```bash
git add apps/operator-console/src/onboarding/checks.ts apps/operator-console/src/onboarding/checks.test.ts apps/operator-console/src/cli.ts
git commit -m "feat: add ops doctor environment and credential checks"
```

---

### Task 6: `ops env init`

**Files:**
- Create: `apps/operator-console/src/onboarding/env-init.ts`
- Modify: `apps/operator-console/src/cli.ts` (register `env init`)
- Test: `apps/operator-console/src/onboarding/env-init.test.ts`

**Interfaces:**
- Consumes: `validateCloudflare` and `DoctorDeps["probeSql"]` from Task 5; `writePrivateFileAtomically(path: string, content: string)` from `../setup-helpers`.
- Produces:
  - `upsertEnvLines(content: string, updates: Record<string, string>): string` — pure merge preserving unrelated lines and comments.
  - `envInit(deps: EnvInitDeps): Promise<void>` with `interface EnvInitDeps { ask(question: string): Promise<string>; validateCf(accountId: string, token: string): Promise<string | null>; probeSql(dsn: string): Promise<string | null>; readEnv(): Promise<string>; writeEnv(content: string): Promise<void>; log(message: string): void }`
  - Writes keys `CLOUDFLARE_ACCOUNT_ID`, `CLOUDFLARE_API_TOKEN`, and (only when provided) `HOSTED_READONLY_DATABASE_URL`.

- [ ] **Step 1: Write the failing tests**

Create `apps/operator-console/src/onboarding/env-init.test.ts`:

```ts
import { describe, expect, it } from "vitest";

import { envInit, upsertEnvLines, type EnvInitDeps } from "./env-init";

describe("upsertEnvLines", () => {
  it("replaces existing keys and appends missing ones, preserving comments", () => {
    const before = "# comment\nCLOUDFLARE_ACCOUNT_ID=old\nOPS_API_TOKEN=keep\n";
    const after = upsertEnvLines(before, {
      CLOUDFLARE_ACCOUNT_ID: "new",
      CLOUDFLARE_API_TOKEN: "tok",
    });
    expect(after).toContain("# comment");
    expect(after).toContain("CLOUDFLARE_ACCOUNT_ID=new");
    expect(after).toContain("OPS_API_TOKEN=keep");
    expect(after).toContain("CLOUDFLARE_API_TOKEN=tok");
    expect(after).not.toContain("old");
  });

  it("starts from empty content", () => {
    expect(upsertEnvLines("", { A_KEY: "v" })).toBe("A_KEY=v\n");
  });
});

function fakeDeps(answers: string[], overrides: Partial<EnvInitDeps> = {}) {
  const writes: string[] = [];
  const queue = [...answers];
  const deps: EnvInitDeps = {
    ask: async () => queue.shift() ?? "",
    validateCf: async () => null,
    probeSql: async () => null,
    readEnv: async () => "",
    writeEnv: async (content) => {
      writes.push(content);
    },
    log: () => undefined,
    ...overrides,
  };
  return { deps, writes };
}

describe("envInit", () => {
  it("validates and writes cloudflare credentials", async () => {
    const { deps, writes } = fakeDeps(["acct-id", "api-token", ""]);
    await envInit(deps);
    expect(writes).toHaveLength(1);
    expect(writes[0]).toContain("CLOUDFLARE_ACCOUNT_ID=acct-id");
    expect(writes[0]).toContain("CLOUDFLARE_API_TOKEN=api-token");
    expect(writes[0]).not.toContain("HOSTED_READONLY_DATABASE_URL");
  });

  it("writes the optional DSN when provided and probe passes", async () => {
    const { deps, writes } = fakeDeps([
      "acct-id",
      "api-token",
      "postgresql://corpus_reader:pw@pooler.example:5432/postgres",
    ]);
    await envInit(deps);
    expect(writes[0]).toContain("HOSTED_READONLY_DATABASE_URL=postgresql://");
  });

  it("throws with the validation detail when the cloudflare probe fails", async () => {
    const { deps, writes } = fakeDeps(["acct-id", "bad-token", ""], {
      validateCf: async () => "Workers AI probe returned HTTP 403",
    });
    await expect(envInit(deps)).rejects.toThrow("HTTP 403");
    expect(writes).toHaveLength(0);
  });

  it("throws when the optional DSN probe fails", async () => {
    const { deps, writes } = fakeDeps(
      ["acct-id", "api-token", "postgresql://bad"],
      { probeSql: async () => "connection refused" },
    );
    await expect(envInit(deps)).rejects.toThrow("connection refused");
    expect(writes).toHaveLength(0);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `pnpm --filter @dot-gov-news/operator-console test src/onboarding/env-init.test.ts`
Expected: FAIL — `./env-init` module not found.

- [ ] **Step 3: Implement env-init.ts**

Create `apps/operator-console/src/onboarding/env-init.ts`:

```ts
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { createInterface } from "node:readline/promises";
import { stdin, stdout } from "node:process";

import { repositoryRoot } from "../config";
import { writePrivateFileAtomically } from "../setup-helpers";
import { defaultDoctorDeps, validateCloudflare } from "./checks";

export interface EnvInitDeps {
  ask: (question: string) => Promise<string>;
  validateCf: (accountId: string, token: string) => Promise<string | null>;
  probeSql: (dsn: string) => Promise<string | null>;
  readEnv: () => Promise<string>;
  writeEnv: (content: string) => Promise<void>;
  log: (message: string) => void;
}

export function upsertEnvLines(
  content: string,
  updates: Record<string, string>,
): string {
  const lines = content.length > 0 ? content.split("\n") : [];
  const seen = new Set<string>();
  const next = lines.map((line) => {
    const match = /^([A-Z0-9_]+)=/.exec(line);
    if (match && updates[match[1]] !== undefined) {
      seen.add(match[1]);
      return `${match[1]}=${updates[match[1]]}`;
    }
    return line;
  });
  while (next.length > 0 && next[next.length - 1] === "") next.pop();
  for (const [key, value] of Object.entries(updates)) {
    if (!seen.has(key)) next.push(`${key}=${value}`);
  }
  return `${next.join("\n")}\n`;
}

export async function envInit(deps: EnvInitDeps): Promise<void> {
  deps.log("Cloudflare credentials (dashboard → Workers & Pages for the");
  deps.log("account ID; My Profile → API Tokens → 'Workers AI' template).");
  const accountId = (await deps.ask("Cloudflare account ID: ")).trim();
  const token = (await deps.ask("Cloudflare API token: ")).trim();
  const cfError = await deps.validateCf(accountId, token);
  if (cfError !== null) {
    throw new Error(`Cloudflare validation failed: ${cfError}`);
  }
  deps.log("✓ Cloudflare Workers AI reachable");

  const updates: Record<string, string> = {
    CLOUDFLARE_ACCOUNT_ID: accountId,
    CLOUDFLARE_API_TOKEN: token,
  };

  const dsn = (
    await deps.ask(
      "Optional corpus_reader DSN for live hosted reads (enter to skip): ",
    )
  ).trim();
  if (dsn.length > 0) {
    const dsnError = await deps.probeSql(dsn);
    if (dsnError !== null) {
      throw new Error(`Hosted DSN validation failed: ${dsnError}`);
    }
    deps.log("✓ hosted read-only connection ok");
    updates.HOSTED_READONLY_DATABASE_URL = dsn;
  }

  await deps.writeEnv(upsertEnvLines(await deps.readEnv(), updates));
  deps.log("✓ .env written (mode 0600)");
}

export function defaultEnvInitDeps(): EnvInitDeps {
  const environmentPath = resolve(repositoryRoot, ".env");
  const readline = createInterface({ input: stdin, output: stdout });
  const doctor = defaultDoctorDeps();
  return {
    ask: (question) => readline.question(question),
    validateCf: (accountId, token) =>
      validateCloudflare(doctor, accountId, token),
    probeSql: doctor.probeSql,
    readEnv: async () => {
      try {
        return await readFile(environmentPath, "utf8");
      } catch {
        return "";
      }
    },
    writeEnv: (content) =>
      writePrivateFileAtomically(environmentPath, content),
    log: (message) => console.log(message),
  };
}
```

Note: check the exact signature of `writePrivateFileAtomically` in `apps/operator-console/src/setup-helpers.ts` before wiring — if it takes options or a different argument order, adapt the `writeEnv` closure (and only that closure).

- [ ] **Step 4: Run tests to verify they pass**

Run: `pnpm --filter @dot-gov-news/operator-console test src/onboarding/env-init.test.ts`
Expected: 6 PASS

- [ ] **Step 5: Register the command in cli.ts**

Add to `apps/operator-console/src/cli.ts` after the doctor command:

```ts
const env = program.command("env").description("Manage the local .env file");
env
  .command("init")
  .description("Prompt for contributor credentials, validate, write .env")
  .action(async () => {
    const { defaultEnvInitDeps, envInit } = await import(
      "./onboarding/env-init"
    );
    await envInit(defaultEnvInitDeps());
    process.exit(0);
  });
```

(`process.exit(0)` because the readline interface otherwise holds the event loop open — mirror how `setup.ts` handles it if it differs.)

- [ ] **Step 6: Typecheck and full console test run**

Run: `pnpm --filter @dot-gov-news/operator-console typecheck && pnpm --filter @dot-gov-news/operator-console test`
Expected: PASS

- [ ] **Step 7: Commit**

```bash
git add apps/operator-console/src/onboarding/env-init.ts apps/operator-console/src/onboarding/env-init.test.ts apps/operator-console/src/cli.ts
git commit -m "feat: add ops env init credential wizard"
```

---

### Task 7: `ops onboard` wizard

**Files:**
- Create: `apps/operator-console/src/onboarding/onboard.ts`
- Modify: `apps/operator-console/src/cli.ts` (register `onboard`)
- Test: `apps/operator-console/src/onboarding/onboard.test.ts`

**Interfaces:**
- Consumes: `runDoctor`, `defaultDoctorDeps`, `CheckResult`, `LOCAL_DSN` (Task 5); `envInit`, `defaultEnvInitDeps` (Task 6).
- Produces: `onboard(deps: OnboardDeps, opts: { dryRun?: boolean; fresh?: boolean }): Promise<void>` with

```ts
interface OnboardDeps {
  doctorTooling(): Promise<CheckResult[]>;
  envReady(): Promise<boolean>;      // CLOUDFLARE_* present in env/.env
  envInit(): Promise<void>;
  dbUp(): Promise<boolean>;          // select 1 against LOCAL_DSN succeeds
  corpusCount(): Promise<number>;    // count(*) from news_entries, local
  embeddedCount(): Promise<number>;  // count(*) where embedding is not null
  run(command: string, args: string[]): Promise<void>; // streams output, throws on nonzero exit
  log(message: string): void;
}
```

- [ ] **Step 1: Write the failing tests**

Create `apps/operator-console/src/onboarding/onboard.test.ts`:

```ts
import { describe, expect, it } from "vitest";

import { onboard, type OnboardDeps } from "./onboard";

function fakeDeps(overrides: Partial<OnboardDeps> = {}) {
  const commands: string[] = [];
  const deps: OnboardDeps = {
    doctorTooling: async () => [
      { name: "mise", ok: true, detail: "2026.7.1" },
    ],
    envReady: async () => true,
    envInit: async () => {
      commands.push("envInit");
    },
    dbUp: async () => true,
    corpusCount: async () => 1000,
    embeddedCount: async () => 50,
    run: async (command, args) => {
      commands.push([command, ...args].join(" "));
    },
    log: () => undefined,
    ...overrides,
  };
  return { deps, commands };
}

describe("onboard", () => {
  it("skips env init, db start, reset, and prepare when state is already good", async () => {
    const { deps, commands } = fakeDeps();
    await onboard(deps, {});
    expect(commands).not.toContain("envInit");
    expect(commands.join("\n")).not.toContain("supabase start");
    expect(commands.join("\n")).not.toContain("db reset");
    expect(commands.join("\n")).not.toContain("prepare");
    // Always refreshes corpus and runs the smoke experiment.
    expect(commands.join("\n")).toContain("pipeline.cli sync");
    expect(commands.join("\n")).toContain("experiment onboarding-smoke");
  });

  it("runs every step on a fresh machine", async () => {
    const { deps, commands } = fakeDeps({
      envReady: async () => false,
      dbUp: async () => false,
      corpusCount: async () => 0,
      embeddedCount: async () => 0,
    });
    await onboard(deps, {});
    const joined = commands.join("\n");
    expect(commands[0]).toBe("envInit");
    expect(joined).toContain("supabase start");
    expect(joined).toContain("supabase db reset");
    expect(joined).toContain("uv sync");
    expect(joined).toContain("pipeline.cli sync");
    expect(joined).toContain("pipeline.cli prepare --limit 25");
    expect(joined).toContain("pipeline.cli experiment onboarding-smoke");
  });

  it("stops with fix guidance when tooling checks fail", async () => {
    const { deps, commands } = fakeDeps({
      doctorTooling: async () => [
        { name: "docker", ok: false, detail: "not found", fix: "Install Docker" },
      ],
    });
    await expect(onboard(deps, {})).rejects.toThrow("Install Docker");
    expect(commands).toHaveLength(0);
  });

  it("dry run performs checks but executes nothing", async () => {
    const { deps, commands } = fakeDeps({ corpusCount: async () => 0 });
    await onboard(deps, { dryRun: true });
    expect(commands).toHaveLength(0);
  });

  it("fresh forces a db reset even with an existing corpus", async () => {
    const { deps, commands } = fakeDeps();
    await onboard(deps, { fresh: true });
    expect(commands.join("\n")).toContain("supabase db reset");
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `pnpm --filter @dot-gov-news/operator-console test src/onboarding/onboard.test.ts`
Expected: FAIL — `./onboard` module not found.

- [ ] **Step 3: Implement onboard.ts**

Create `apps/operator-console/src/onboarding/onboard.ts`:

```ts
import { config as loadDotEnv } from "dotenv";
import { spawn } from "node:child_process";
import { resolve } from "node:path";

import postgres from "postgres";

import { repositoryRoot } from "../config";
import {
  defaultDoctorDeps,
  LOCAL_DSN,
  runDoctor,
  type CheckResult,
} from "./checks";
import { defaultEnvInitDeps, envInit } from "./env-init";

export interface OnboardDeps {
  doctorTooling: () => Promise<CheckResult[]>;
  envReady: () => Promise<boolean>;
  envInit: () => Promise<void>;
  dbUp: () => Promise<boolean>;
  corpusCount: () => Promise<number>;
  embeddedCount: () => Promise<number>;
  run: (command: string, args: string[]) => Promise<void>;
  log: (message: string) => void;
}

export async function onboard(
  deps: OnboardDeps,
  opts: { dryRun?: boolean; fresh?: boolean },
): Promise<void> {
  const act = async (label: string, fn: () => Promise<void>) => {
    if (opts.dryRun) {
      deps.log(`[dry-run] would ${label}`);
      return;
    }
    deps.log(`→ ${label}`);
    await fn();
  };

  const tooling = await deps.doctorTooling();
  const broken = tooling.filter((r) => !r.ok);
  if (broken.length > 0) {
    const details = broken
      .map((r) => `${r.name}: ${r.detail}${r.fix ? ` — ${r.fix}` : ""}`)
      .join("\n");
    throw new Error(`Toolchain not ready:\n${details}`);
  }
  deps.log(`✓ toolchain ok (${String(tooling.length)} checks)`);

  if (!(await deps.envReady())) {
    await act("collect credentials (ops env init)", () => deps.envInit());
  } else {
    deps.log("✓ credentials present");
  }

  if (!(await deps.dbUp())) {
    await act("start local supabase", () =>
      deps.run("pnpm", ["supabase", "start"]),
    );
  } else {
    deps.log("✓ local database running");
  }

  const corpus = opts.dryRun ? 1 : await deps.corpusCount();
  if (opts.fresh || corpus === 0) {
    await act("apply migrations (supabase db reset)", () =>
      deps.run("pnpm", ["supabase", "db", "reset"]),
    );
  } else {
    deps.log(`✓ schema present (${String(corpus)} corpus entries)`);
  }

  await act("install python environment (uv sync)", () =>
    deps.run("uv", ["sync"]),
  );
  await act("sync hosted corpus", () =>
    deps.run("uv", ["run", "python", "-m", "pipeline.cli", "sync"]),
  );

  const embedded = opts.dryRun ? 1 : await deps.embeddedCount();
  if (embedded === 0) {
    await act("embed a 25-entry sample with your Cloudflare models", () =>
      deps.run("uv", [
        "run",
        "python",
        "-m",
        "pipeline.cli",
        "prepare",
        "--limit",
        "25",
      ]),
    );
  } else {
    deps.log(`✓ embeddings present (${String(embedded)} entries)`);
  }

  await act("run smoke experiment", () =>
    deps.run("uv", [
      "run",
      "python",
      "-m",
      "pipeline.cli",
      "experiment",
      "onboarding-smoke",
      "--limit",
      "25",
    ]),
  );

  deps.log("");
  deps.log("Done. Next steps:");
  deps.log("  pnpm ops doctor                                   # re-verify anytime");
  deps.log("  uv run python -m pipeline.cli prepare --limit 500 # embed more corpus");
  deps.log("  docs/operations/cli-cheatsheet.md                 # everyday commands");
}

export function defaultOnboardDeps(): OnboardDeps {
  loadDotEnv({ path: resolve(repositoryRoot, ".env"), quiet: true });
  const doctor = defaultDoctorDeps();
  const childEnv = {
    ...process.env,
    DATABASE_URL: process.env.DATABASE_URL ?? LOCAL_DSN,
  };
  const count = async (where: string): Promise<number> => {
    const sql = postgres(childEnv.DATABASE_URL, { max: 1, connect_timeout: 5 });
    try {
      const rows = await sql.unsafe(
        `select count(*)::int as n from public.news_entries ${where}`,
      );
      return (rows[0] as { n: number }).n;
    } finally {
      await sql.end({ timeout: 1 });
    }
  };
  return {
    doctorTooling: () => runDoctor(doctor, { toolingOnly: true }),
    envReady: async () =>
      Boolean(
        process.env.CLOUDFLARE_ACCOUNT_ID && process.env.CLOUDFLARE_API_TOKEN,
      ),
    envInit: () => envInit(defaultEnvInitDeps()),
    dbUp: async () => (await doctor.probeSql(LOCAL_DSN)) === null,
    corpusCount: () => count(""),
    embeddedCount: () => count("where embedding is not null"),
    run: (command, args) =>
      new Promise((resolveRun, rejectRun) => {
        const child = spawn(command, args, {
          cwd: repositoryRoot,
          env: childEnv,
          stdio: "inherit",
        });
        child.once("error", rejectRun);
        child.once("close", (code) => {
          if (code === 0) resolveRun();
          else
            rejectRun(
              new Error(
                `${command} ${args.join(" ")} exited with code ${String(code)}`,
              ),
            );
        });
      }),
    log: (message) => console.log(message),
  };
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `pnpm --filter @dot-gov-news/operator-console test src/onboarding/onboard.test.ts`
Expected: 5 PASS

- [ ] **Step 5: Register the command in cli.ts**

Add after the `env` command block:

```ts
program
  .command("onboard")
  .description("Guided setup: toolchain, credentials, local db, corpus, smoke run")
  .option("--dry-run", "show the plan and run checks without changing anything")
  .option("--fresh", "force supabase db reset even if a corpus exists")
  .action(async (options: { dryRun?: boolean; fresh?: boolean }) => {
    const { defaultOnboardDeps, onboard } = await import(
      "./onboarding/onboard"
    );
    await onboard(defaultOnboardDeps(), {
      dryRun: options.dryRun,
      fresh: options.fresh,
    });
    process.exit(0);
  });
```

- [ ] **Step 6: Typecheck, full console tests, dry-run smoke**

Run: `pnpm --filter @dot-gov-news/operator-console typecheck && pnpm --filter @dot-gov-news/operator-console test && pnpm ops onboard --dry-run`
Expected: typecheck + tests PASS; dry run prints toolchain checks and `[dry-run] would …` lines, changes nothing.

- [ ] **Step 7: Commit**

```bash
git add apps/operator-console/src/onboarding/onboard.ts apps/operator-console/src/onboarding/onboard.test.ts apps/operator-console/src/cli.ts
git commit -m "feat: add ops onboard guided setup wizard"
```

---

### Task 8: Documentation

**Files:**
- Create: `ONBOARDING.md`
- Modify: `README.md` (add pointer near the top)
- Modify: `docs/infrastructure/access.md` (contributor section + hosted rollout section)

**Interfaces:**
- Consumes: command names and doctor check names exactly as implemented in Tasks 5–7.

- [ ] **Step 1: Write ONBOARDING.md**

Create `ONBOARDING.md` at the repo root:

````markdown
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

| Command | Purpose |
| --- | --- |
| `pnpm ops doctor` | verify toolchain, credentials, hosted access |
| `uv run python -m pipeline.cli sync` | refresh the local corpus |
| `uv run python -m pipeline.cli prepare --limit 500` | embed more entries |
| `uv run python -m pipeline.cli experiment <name> --limit 500` | run an experiment |
| `pnpm ops:start` | open the operator dashboard |

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

| Doctor check | Usual cause | Fix |
| --- | --- | --- |
| `docker` | Docker Desktop not running | start Docker Desktop |
| `node` / `pnpm` / `uv` | shell not using mise | `mise install`, check shell activation |
| `local database` | Supabase stack down | `pnpm supabase start` |
| `cloudflare token` | token lacks Workers AI scope | recreate token from the Workers AI template, `pnpm ops env init` |
| `hosted corpus read` | publishable key missing/rotated | ask the repo owner; see `docs/infrastructure/access.md` |
| `hosted direct read` | stale optional DSN | remove it from `.env` or request a fresh one |
````

- [ ] **Step 2: Add the README pointer**

In `README.md`, immediately after the opening paragraph ("Independent infrastructure and source inventory…"), add:

```markdown
**New contributor?** See [ONBOARDING.md](ONBOARDING.md) — two commands to a
working local experiment environment.
```

- [ ] **Step 3: Extend access.md**

In `docs/infrastructure/access.md`, append two sections:

````markdown
## Contributor corpus access

Invited contributors read the hosted corpus without any credential handoff:
the publishable key in `config/hosted.json` maps to the `anon` role, which
has RLS `SELECT` policies on exactly `news_entries`, `news_sources`, and
`news_source_publishers` (migration `20260719120000_grant_corpus_read.sql`).
The publishable key is safe to commit; rotating it in the Supabase dashboard
plus updating `config/hosted.json` revokes old clones' access.

For live SQL, hand out the `corpus_reader` DSN individually (see below).
Rotate its password when someone leaves:

```sql
alter role corpus_reader password '<new-password>';
```

## Hosted rollout

One-time steps to activate contributor access (repo owner, requires the
linked Supabase project):

1. Push the migration: `mise exec -- pnpm supabase db push`
2. Copy the publishable key (`sb_publishable_...`) from
   **Supabase Dashboard → Project Settings → API Keys** into
   `config/hosted.json`, replacing the `REPLACE_WITH_...` placeholder, and
   commit.
3. Enable login for the direct-read role (SQL editor, hosted):

   ```sql
   alter role corpus_reader login password '<generated-password>';
   ```

   Connection string to hand out (Supavisor session pooler):

   ```
   postgresql://corpus_reader.qdqmahimrnwhzdjlcont:<password>@aws-1-us-east-2.pooler.supabase.com:5432/postgres
   ```

4. Verify from a clean shell: `pnpm ops doctor` — the `hosted corpus read`
   check must pass.
````

- [ ] **Step 4: Verify formatting and links**

Run: `pnpm format && pnpm format:check`
Expected: clean. Also confirm `ONBOARDING.md` links resolve (cheatsheet path, access.md path exist).

- [ ] **Step 5: Commit**

```bash
git add ONBOARDING.md README.md docs/infrastructure/access.md
git commit -m "docs: add contributor onboarding guide and hosted access sections"
```

---

### Task 9: Hosted rollout + end-to-end verification (human-in-the-loop)

**Files:**
- Modify: `config/hosted.json` (paste real publishable key)

This task requires the repo owner's Supabase dashboard access. The executing agent prepares and verifies; the human performs dashboard steps.

- [ ] **Step 1 (human): Push the migration to hosted**

Run: `mise exec -- pnpm supabase db push`
Expected: `20260719120000_grant_corpus_read.sql` applied. (Requires `supabase link` per `docs/infrastructure/access.md`.)

- [ ] **Step 2 (human): Paste the publishable key**

Copy `sb_publishable_...` from Supabase Dashboard → Project Settings → API Keys into `config/hosted.json`.

- [ ] **Step 3: Verify anon read against hosted**

Run:

```bash
KEY=$(node -e "console.log(JSON.parse(require('fs').readFileSync('config/hosted.json','utf8')).publishableKey)")
curl -s -H "apikey: $KEY" -H "Authorization: Bearer $KEY" \
  "https://qdqmahimrnwhzdjlcont.supabase.co/rest/v1/news_sources?select=id&limit=1"
```

Expected: JSON array with one id. Also verify lockout:

```bash
curl -s -o /dev/null -w "%{http_code}" -H "apikey: $KEY" -H "Authorization: Bearer $KEY" \
  "https://qdqmahimrnwhzdjlcont.supabase.co/rest/v1/pipeline_events?select=id&limit=1"
```

Expected: `401` or `403` (not 200).

- [ ] **Step 4: End-to-end wizard run**

Run: `pnpm ops doctor` then `pnpm ops onboard`
Expected: doctor all-green (hosted DSN check may report "not configured (optional)"); onboard completes through the smoke experiment, printing a report path under `docs/eval/`.

- [ ] **Step 5 (human, optional): Enable corpus_reader login**

Only when someone actually requests direct-read access — SQL from the "Hosted rollout" section of `docs/infrastructure/access.md`.

- [ ] **Step 6: Commit**

```bash
git add config/hosted.json
git commit -m "chore: activate hosted publishable key for contributor corpus sync"
```

---

## Post-plan follow-ups (explicitly out of scope)

- Published export snapshots for a future public repo (sync source is isolated in `pipeline/hosted.py` + `sync_corpus`).
- Sharing experiment results between contributors (report files are exchangeable artifacts).
- Automated key/DSN rotation.
