# Teardown Procedure

Teardown is destructive. Resolve exact resource names with list commands, disable producers first, and retain exports until deletion is verified.

## 1. Disable new work

Set `DISCOVERY_ENABLED=false`, remove or disable Cron Triggers in
`apps/pipeline-worker/wrangler.jsonc`, deploy that version, and wait for both
consumer queues to drain. Pause `dot-gov-site-discovery-dev` first if publisher
traffic must stop immediately.

Disable operator reads independently by setting `OPS_API_ENABLED=false` and
deploying `operator-api`, or delete/rotate `OPS_API_TOKEN`. Stopping the local
dashboard does not affect pipeline work.

## 2. Export durable data

Create a Supabase dump and download any R2 artifacts that must be retained. Store exports outside this repository.

## 3. Remove Cloudflare compute and queues

After verifying the exact account and names:

```sh
mise exec -- pnpm --filter @dot-gov-news/pipeline-worker exec wrangler delete dot-gov-news-pipeline-dev
mise exec -- pnpm --filter @dot-gov-news/operator-api exec wrangler delete dot-gov-news-operator-api-dev
mise exec -- pnpm --filter @dot-gov-news/pipeline-worker exec wrangler queues delete dot-gov-news-events-dev
mise exec -- pnpm --filter @dot-gov-news/pipeline-worker exec wrangler queues delete dot-gov-news-events-dlq-dev
mise exec -- pnpm --filter @dot-gov-news/pipeline-worker exec wrangler queues delete dot-gov-site-discovery-dev
mise exec -- pnpm --filter @dot-gov-news/pipeline-worker exec wrangler queues delete dot-gov-site-discovery-dlq-dev
```

## 4. Remove R2 only after emptying it

List and explicitly remove the intended objects, then delete only `dot-gov-news-artifacts-dev`. Never use a broad or unresolved bucket target.

```sh
mise exec -- pnpm --filter @dot-gov-news/pipeline-worker exec wrangler r2 bucket delete dot-gov-news-artifacts-dev
```

## 5. Remove local Chroma data

Normal shutdown preserves the named volume:

```sh
docker compose -f infra/chroma/compose.yaml down
```

Only when local vector data is intentionally disposable, delete the explicit volume:

```sh
docker volume rm dot-gov-news-chroma-data
```

## 6. Supabase rollback

Do not automatically drop `public.pipeline_events`, `public.feeds`,
`public.government_site_feeds`, or `public.feed_fetch_state`. Retain them for
diagnostics unless the project owner explicitly approves data deletion. The
discovery migration is additive and leaving its tables in place is the safe
Worker rollback.
