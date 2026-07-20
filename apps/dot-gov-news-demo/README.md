# DOT GOV News Demo

This app is the public, read-only presentation layer for DOT GOV storylines. It
uses same-origin Vercel Functions under `/api/lab` to read the reviewed golden
serving data directly from Supabase.

The selected date is applied to storyline emergence, theme availability,
overview-card versions, episodes, and entries. A storyline is displayed only
when `unreviewedEntryCount` is zero.

## Run locally

The fastest UI-only workflow proxies `/api/lab` to the local operator console:

```sh
pnpm ops:start
pnpm --filter dot-gov-news-demo dev
```

Copy `.env.example` to `.env.local` when the local API is not mounted at the
default proxy target. `DOT_GOV_API_TOKEN` or `DOT_GOV_API_SESSION_COOKIE` is
added only by the Vite development proxy and is never exposed to browser code.

To exercise the Vercel Function locally, use the local config that omits the
production-only SPA rewrite:

```sh
pnpm dlx vercel dev --local-config vercel.dev.json
```

Configure `SUPABASE_URL` and `SUPABASE_DEMO_KEY` for the linked Vercel project.
The default `vercel.json` catch-all is intended for the production build; using
it with `vercel dev` rewrites Vite's source-module requests to `index.html`.

## Deploy to Vercel

Create the `dot-gov-news-demo` Vercel project with
`apps/dot-gov-news-demo` as its root directory. Vercel can use
the package's `build` script and the default Vite output directory (`dist`).
Keep **Include source files outside of the Root Directory** enabled because the
function imports the workspace package at `packages/demo-api`.

Set these server-side variables for Production and Preview:

- `SUPABASE_URL`
- `SUPABASE_DEMO_KEY`

Generated event-card thumbnails additionally require:

- `CLOUDFLARE_ACCOUNT_ID`
- `R2_ACCESS_KEY_ID`
- `R2_SECRET_ACCESS_KEY`
- `R2_BUCKET_NAME`

Use an R2 credential restricted to reads from the demo asset bucket. You may set
`R2_S3_API_ENDPOINT` explicitly instead of deriving it from the account ID.

`SUPABASE_DEMO_KEY` should be restricted to the reviewed golden serving data.
Until that credential exists, the function also accepts `SUPABASE_SECRET_KEY`
as a server-only compatibility fallback. Never expose either key through a
`VITE_*` variable.

The Vercel function and the operator Worker use the shared
`@dot-gov-news/demo-api` package, so route validation, Supabase queries, and the
reviewed-only boundary remain identical without a Worker-to-Worker proxy.

The client first reads the uncached `/api/lab/revision` singleton, then includes
that revision in every mutable JSON request. Successful revisioned responses
have a one-year Vercel edge lifetime because a reviewed-data mutation advances
the revision and therefore changes the request URL. The API checks the revision
both before and after assembling a response, returning an uncached `409` when a
publication races a read. Bootstrap data bundles the browse catalog, filters,
and card-ready overview/thumbnail metadata so the initial grid does not fetch
every storyline detail.

Thumbnail URLs contain an immutable `images.id`. Publishing or assigning a
different image changes the URL, so thumbnail responses retain a one-year
browser and Vercel edge lifetime. Existing image rows and R2 objects must never
be overwritten in place. Errors and revision lookups remain `no-store`.

No publication-time cache warming is required. To prime or inspect one Vercel
region after a production deployment, resolve the current revision and fetch
the bootstrap response plus the first 18 available thumbnails with:

```sh
DOT_GOV_DEMO_URL=https://news.example.gov pnpm --filter dot-gov-news-demo warm-cache
```

The command prints the resolved revision and Vercel's observed cache status for
the bootstrap and each thumbnail. It is a diagnostic convenience, not a
freshness mechanism or required post-deploy step.

## Required read endpoints

- `GET /api/lab/bootstrap`
- `GET /api/lab/revision`
- `GET /api/lab/storylines`
- `GET /api/lab/storylines/:id`
- `GET /api/lab/agencies`
- `GET /api/lab/topics/categories`
- `GET /api/lab/topics/themes`
- `GET /api/lab/rank/golden`
- `GET /api/lab/rank/golden/filtered-snapshot`
- `GET /api/lab/assets/images/:id/card`

Images and AI-generated episode analysis intentionally render as pending until
those enrichment jobs populate the serving data.
