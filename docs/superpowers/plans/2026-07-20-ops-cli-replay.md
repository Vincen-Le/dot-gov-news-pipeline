# Ops-CLI Consolidation Replay Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Restore the completed 24-commit ops-CLI consolidation (onboarding + `ops setup`/`doctor`/`remote` regrouping) onto current main in this worktree, verified and merge-ready.

**Architecture:** The original branch `claude/local-dev-setup-process-67aa52` was deleted, but its tip `a52c35a` survives as unreachable commits in this repo. Rather than re-implementing from the design docs (which also live inside that tip), this plan recovers the ref, rebases the 24 commits onto `main@29fa9e4`, resolves the two predicted conflicts, and re-verifies everything. Result is byte-identical to the reviewed, approved work — at replay cost, not re-implementation cost.

**Tech Stack:** git (rebase/recovery), pnpm workspaces, vitest (operator-console), pytest (pipeline), Supabase CLI (migrations), mise (node 24 pin).

## Global Constraints

- Never run `supabase db reset` — corpus-preserving rule from spine lab docs; `migration up --local` only.
- `config/hosted.json` publishable key: the real key exists only uncommitted in the primary worktree (`/Users/vincent.le/Developer/dot-gov-news-pipeline`); the branch tip has placeholder `REPLACE_WITH_SB_PUBLISHABLE_KEY`. Do not invent a key.
- Verify test suites on BOTH node 25 (host default) and node 24 (repo pin) — main without this branch fails console tests on node ≥25 (missing localStorage guard, carried in commit `9310de0`).
- Do not touch main's checkout (primary repo dir is the sibling session's active directory). All work stays in this worktree on branch `claude/worktree-implementation-plan-c6b14d`.
- `pipeline/config.py`'s 54322 default DSN stays as-is (pinned by `test_cache.py`) — out of scope, per original spec.

## Key facts (measured 2026-07-20)

| Fact | Value |
|---|---|
| Lost branch tip | `a52c35a` (exists as object, no ref) |
| True merge-base with main | `47bc8d2` |
| Commits to replay | 24 (`git log --oneline 47bc8d2..a52c35a`) |
| Main tip / worktree HEAD | `29fa9e4` (worktree branch == main, clean) |
| Main commits since base | 21 |
| File overlap (conflict surface) | `package.json`, `pipeline/cli.py` only |
| Migration ordering hazard | branch adds `20260719120000_grant_corpus_read.sql`; main already has 12 later-timestamped migrations (up to `20260720040000`) |
| Design + plan docs | inside tip: `docs/superpowers/plans/2026-07-19-ops-cli-ux-consolidation.md`, `2026-07-19-local-dev-onboarding.md` + design docs (commits `dfff978`, `c7f8220`, `99644fe`, `09927ce`) |

---

### Task 1: Recover the ref (protect from gc)

**Files:** none (git refs only)

**Interfaces:**
- Produces: local branch `ops-cli-recovered` at `a52c35a`, used by Task 2.

- [ ] **Step 1: Create recovery branch**

```bash
git branch ops-cli-recovered a52c35a
```

- [ ] **Step 2: Verify it holds exactly the 24 expected commits**

Run: `git log --oneline 47bc8d2..ops-cli-recovered | wc -l`
Expected: `24`

Run: `git log --oneline -1 ops-cli-recovered`
Expected: `a52c35a fix: show embedding step honestly in dry-run instead of fabricating count`

No commit needed — refs only.

---

### Task 2: Rebase the 24 commits onto main in this worktree

**Files:**
- Conflict-expected: `pipeline/cli.py` (branch commit `3603267` adds remote-DSN refusal; main's `f60d473`/`4fd2be1` etc. touched it since)
- Conflict-expected: `package.json` (branch renames `ops:setup` → `ops deploy` semantics; main may have added scripts, e.g. mirror tooling from `df4dbaa`)

**Interfaces:**
- Consumes: `ops-cli-recovered` from Task 1.
- Produces: this worktree's branch `claude/worktree-implementation-plan-c6b14d` = main + 24 replayed commits.

- [ ] **Step 1: Move this worktree branch to the recovered tip**

Precondition check first: `git status --porcelain` must be empty (it was at plan time).

```bash
git reset --hard a52c35a
```

- [ ] **Step 2: Rebase onto main**

```bash
git rebase main
```

Expected: mostly clean replay; stops at most on `pipeline/cli.py` and/or `package.json`.

- [ ] **Step 3: Resolve conflicts keep-both**

Both predicted conflicts are additive-vs-additive:
- `pipeline/cli.py`: keep main's newer command/flag changes AND the branch's remote-DSN guard (same class as the cli.ts import conflict resolved keep-both in the prior session).
- `package.json`: keep main's new scripts AND the branch's `ops` script changes (`ops:setup` removal / `deploy` rename). If main re-added a script the branch deletes, the branch's rename wins — the name clash was the point.

```bash
git add pipeline/cli.py package.json && git rebase --continue
```

- [ ] **Step 4: Verify shape**

Run: `git log --oneline main..HEAD | wc -l`
Expected: `24`

Run: `git diff a52c35a HEAD --stat | tail -1`
Expected: only the conflict-resolved files differ from the old tip (small stat), everything else identical.

No separate commit — the rebase IS the commits.

---

### Task 3: Full verification on both node versions

**Files:** none (verification only)

- [ ] **Step 1: Python suite**

```bash
mise exec -- python -m pytest tests/ -q
```

Expected: all pass, 0 failures (count will exceed the prior 257 — main added tests since).

- [ ] **Step 2: Console suite + typecheck on host node (v25)**

```bash
pnpm --filter @dot-gov-news/operator-console test
pnpm --filter @dot-gov-news/operator-console typecheck 2>/dev/null || pnpm -r typecheck
```

Expected: all pass. The node-25 localStorage guard (`apps/operator-console/test/setup.ts`, commit `9310de0`) rides in this branch — if console tests fail with `localStorage.setItem is not a function`, the rebase dropped that commit; stop and inspect.

- [ ] **Step 3: Console suite on pinned node 24 — force the exact binary (npx indirection lies)**

```bash
cd apps/operator-console && mise exec node@24 -- node ./node_modules/vitest/vitest.mjs run
```

Expected: same pass count as Step 2.

- [ ] **Step 4: Prettier-drift guard**

Run: `git status --porcelain | wc -l`
Expected: `0`. (Prior session's implementer once left ~90 prettier-drifted files uncommitted; if non-zero and files aren't yours, `git checkout -- .`)

---

### Task 4: Re-validate design deltas against the 21 new main commits

The original design was validated against `main@47bc8d2`-era code. 21 commits landed since. Check each assumption; fix only true breakage.

**Files:**
- Possibly modify: `docs/operations/*` CLI reference (commit `66dc77c` regenerated it — main may have added scripts since)
- Read: `config/pipelines.json`, `package.json`

- [ ] **Step 1: Registry still two pipelines?**

Run: `python3 -c "import json; print([p['name'] for p in json.load(open('config/pipelines.json'))['pipelines']])"`
Expected: `complex_v1` and `simple_v1` present. If main added a pipeline, `ops setup`/`doctor` iterate the registry generically — no code change, but note it in the verification report.

- [ ] **Step 2: New ops-adjacent surface since base?**

Run: `git diff 47bc8d2 main -- package.json | grep '^[+-]\s*"'`
Check: did main add scripts (e.g. golden-mirror tooling from `df4dbaa`, `2cf5ad5`) that belong in the regrouped `pnpm ops` help / regenerated CLI reference? If yes, add them to the appropriate group (Lab or Meta) and regenerate the reference doc the same way `66dc77c` did.

- [ ] **Step 3: If reference regenerated, commit**

```bash
git add docs/ apps/ package.json
git commit -m "docs: fold post-base main scripts into regrouped CLI reference"
```

Skip if Step 2 found nothing.

---

### Task 5: Migration ordering decision

**Files:**
- Inspect: `supabase/migrations/20260719120000_grant_corpus_read.sql`

The branch's grant migration timestamp (`20260719120000`) sorts BEFORE 12 migrations main already has (through `20260720040000`). Local DBs that ran `migration up` on main have the later ones applied; hosted has applied neither this one nor possibly others.

- [ ] **Step 1: Check idempotency of the grant migration**

Run: `git show HEAD:supabase/migrations/20260719120000_grant_corpus_read.sql`
GRANT statements are idempotent; `CREATE POLICY` is not unless guarded.

- [ ] **Step 2: Apply the low-churn resolution**

Recommended: keep the filename, and document that hosted rollout uses `supabase db push --include-all` (picks up out-of-order unapplied migrations). Only if the Supabase CLI version refuses: rename to `20260720050000_grant_corpus_read.sql` in a single commit, noting local DBs that applied it under the old name need `supabase migration repair` or the policy statements need `IF NOT EXISTS`/`DROP ... IF EXISTS` guards.

- [ ] **Step 3: Verify locally**

```bash
mise exec -- pnpm supabase migration up --local
```

Expected: applies (or no-ops) cleanly against the local stack. Never `db reset`.

---

### Task 6: Hosted key + rollout (user-gated, ~5 min)

**Files:**
- Modify: `config/hosted.json` (replace `REPLACE_WITH_SB_PUBLISHABLE_KEY`)

The real publishable key sits uncommitted in the primary worktree's `config/hosted.json`. This is the prior session's still-open "Task 9".

- [ ] **Step 1: Copy the key (read-only touch of the primary dir is fine; no commits there)**

```bash
grep publishableKey /Users/vincent.le/Developer/dot-gov-news-pipeline/config/hosted.json
```

If absent there (sibling session may have moved it), get it from the Supabase dashboard (project `qdqmahimrnwhzdjlcont`) — publishable/anon keys are committable by design.

- [ ] **Step 2: Commit the key**

```bash
git add config/hosted.json
git commit -m "feat: commit hosted publishable key for contributor corpus sync"
```

- [ ] **Step 3: Push grants to hosted (this unblocks the known 401)**

```bash
mise exec -- pnpm supabase db push --include-all
```

Expected: applies `20260719120000_grant_corpus_read.sql` (plus any other unapplied files) to the linked hosted DB.

- [ ] **Step 4: Live-fire verify**

```bash
pnpm ops setup --dry-run   # or the sync step directly
```

Expected: the "sync hosted corpus" step no longer 401s.

**Gate:** confirm with the user before Steps 3–4 — `db push` mutates the shared hosted project.

---

### Task 7: Finish the branch

- [ ] **Step 1: Final suite sweep on tip** (repeat Task 3 Steps 1–3)

- [ ] **Step 2: Use superpowers:finishing-a-development-branch**

Options to present: PR to main (recommended — sibling session works in main's checkout, avoid local merge), or keep branch. Note for the PR body: 24 replayed commits already passed per-task review + two whole-branch reviews in the prior session; this replay changed only conflict resolutions (Task 2) and any Task 4/5 deltas.

---

## Fallback: from-scratch re-execution

Only if the user explicitly wants the process re-run rather than the result restored (e.g. to validate the subagent pipeline). Extract the already-written spec and plan from the recovered tip and execute them with superpowers:subagent-driven-development:

```bash
git show a52c35a:docs/superpowers/plans/2026-07-19-ops-cli-ux-consolidation.md > /tmp/ops-plan.md
git show a52c35a:docs/superpowers/plans/2026-07-19-local-dev-onboarding.md > /tmp/onboarding-plan.md
```

Both plans were validated task-by-task last session; re-validate their file:line references against current main first (21 commits of drift). Expect ~7 tasks + reviews for the ops phase alone. Cost: hours vs minutes for the replay path.
