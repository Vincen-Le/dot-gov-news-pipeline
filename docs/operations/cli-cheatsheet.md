# Operator CLI Cheatsheet

Generated from `apps/operator-console/src/recipes.ts`. Do not edit by hand. All query commands are read-only.

## One-time setup

Add `SUPABASE_SECRET_KEY` to the ignored root `.env`, then run `pnpm ops:setup`. The setup command deploys the read-only Operator API, generates its token, and atomically writes its URL and token back to a mode-`0600` `.env` before enabling reads. Use `pnpm ops:setup --dry-run` to validate without changing Cloudflare or local configuration. Browser code never receives these values.

## Everyday startup

Run `pnpm ops:start` to open the one-time authenticated local dashboard URL. Cloudflare continues processing when the dashboard is closed.

## Output conventions

Add `--json` to read commands for machine-readable output. Warnings go to stderr. Health checks return a nonzero exit code when requested checks fail.

### Run deep health check

Verify Worker, Supabase, R2, and Queue dependencies.

```bash
pnpm ops health --deep
```

### Inspect queue pressure

Read current main Queue and DLQ pressure.

```bash
pnpm ops queues
```

### Verify inventory sync

Verify the latest GSA reconciliation receipt.

```bash
pnpm ops inventory summary
```

### List inventory runs

List recent inventory attempts and outcomes.

```bash
pnpm ops inventory runs --limit 10
```

### Look up a site

Find the durable inventory record for a hostname.

```bash
pnpm ops inventory sites --hostname nasa.gov
```

### Read recent events

Read recent durable pipeline events.

```bash
pnpm ops events list --since 30m
```

### Follow Worker activity

Follow sampled structured Worker activity.

```bash
pnpm ops worker tail --search worker_lifecycle
```

### Open local dashboard

Start the private dashboard on loopback.

```bash
pnpm ops dashboard
```

### Inspect the corpus

Inspect the synced news-entries corpus and feature coverage.

```bash
pnpm ops lab corpus
```

### Browse storyline chains

List multi-episode storyline chains for QA.

```bash
pnpm ops lab storylines --min-episodes 2
```

### QA a storyline chain

Walk one chain: episodes, attach evidence, event cards.

```bash
pnpm ops lab storyline <id>
```

### Run a stub experiment

Run a clustering experiment via the pipeline CLI.

```bash
pnpm ops lab run --name baseline --stub
```

### List experiment runs

List experiment runs and compare their summaries.

```bash
pnpm ops lab experiments
```

### Open the label queue

List borderline attach decisions awaiting labels; label them in the dashboard.

```bash
pnpm ops lab borderline --limit 50
```
