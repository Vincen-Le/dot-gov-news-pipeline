# Provider Access

The bootstrap uses interactive local authentication. Do not paste credentials into issues, pull requests, chat, shell history, or tracked files.

## Known project identifiers

| Setting                    | Value                                      |
| -------------------------- | ------------------------------------------ |
| Supabase project reference | `qdqmahimrnwhzdjlcont`                     |
| Supabase URL               | `https://qdqmahimrnwhzdjlcont.supabase.co` |
| Supabase region            | `us-east-2`                                |
| Cloudflare account ID      | `a2d6c849c1770d0e7e4fc042db14de25`         |
| Workers subdomain          | `vincen-le.workers.dev`                    |

These identifiers are not secrets.

## Supabase

Authenticate and link the local repository:

```sh
mise exec -- pnpm supabase login
mise exec -- pnpm supabase link --project-ref qdqmahimrnwhzdjlcont
```

Enter the database password only at the CLI prompt. The linked-project state lives under the ignored `supabase/.temp/` directory.

The deployed Worker requires a modern Supabase secret key (`sb_secret_...`). Copy it from **Supabase Dashboard > Project Settings > API Keys**, then enter it directly into Wrangler:

```sh
mise exec -- pnpm --filter @dot-gov-news/pipeline-worker exec wrangler secret put SUPABASE_SECRET_KEY
```

The secret bypasses Row Level Security and must never be exposed in browser code.

## Cloudflare

Use OAuth with OS-keychain storage:

```sh
mise exec -- pnpm --filter @dot-gov-news/pipeline-worker exec wrangler login --use-keyring
mise exec -- pnpm --filter @dot-gov-news/pipeline-worker exec wrangler whoami
```

The account must have Workers, Queues, and R2 enabled. No DNS or zone permission is needed for the `workers.dev` deployment.

Do not use a Cloudflare Global API Key. If CI deployment is added later, use an account-scoped token with only Workers Scripts Edit, Queues Edit, and Workers R2 Storage Edit.

### R2 S3-compatible access

The inventory batch runs outside the Worker runtime, so it uses R2's
S3-compatible API rather than the `ARTIFACTS` Worker binding. In **Cloudflare
Dashboard > Storage & databases > R2 > Overview > Manage API Tokens**, create
an account token with **Object Read & Write** limited to
`dot-gov-news-artifacts-dev`.

Record the generated values only in approved secret stores:

```text
R2_ACCESS_KEY_ID
R2_SECRET_ACCESS_KEY
```

The inventory client combines those values with these non-secret identifiers:

```text
CLOUDFLARE_ACCOUNT_ID=a2d6c849c1770d0e7e4fc042db14de25
R2_BUCKET_NAME=dot-gov-news-artifacts-dev
```

`R2_S3_API_ENDPOINT` is optional and derived from `CLOUDFLARE_ACCOUNT_ID`
when omitted.

For local use, place all four values in the ignored root `.env` file. For the
scheduled workflow, place `CLOUDFLARE_ACCOUNT_ID`, `R2_BUCKET_NAME`, and
`SUPABASE_URL` in the GitHub `development` environment as variables, and place
`R2_ACCESS_KEY_ID`, `R2_SECRET_ACCESS_KEY`, and `SUPABASE_SECRET_KEY` there as
secrets.

`CLOUDFLARE_API_TOKEN` is a management API credential and is not interchangeable
with either S3-compatible R2 value. The Worker binding itself does not require
S3 credentials.

## Chroma

The bootstrap runs Chroma locally through Docker and requires no account or API key.

## Local Worker secrets

For local development only:

```sh
cp apps/pipeline-worker/.dev.vars.example apps/pipeline-worker/.dev.vars
```

Populate the ignored `.dev.vars` file locally. Never put real credentials in `.dev.vars.example`.

## Operator API and local console

The preferred setup reads `SUPABASE_SECRET_KEY` from the ignored root `.env`,
generates a high-entropy Operator API token, supplies both secrets to the first
deployment through a permission-restricted temporary JSON file, deletes that
file after setup, and atomically writes the Operator API URL and token to a
mode-`0600` `.env` before enabling remote reads:

```sh
pnpm ops deploy
```

The resulting ignored local configuration contains:

```text
OPS_API_URL=https://dot-gov-news-operator-api-dev.<workers-subdomain>.workers.dev
OPS_API_TOKEN=<random value of at least 32 characters>
OPS_WORKER_NAME=dot-gov-news-pipeline-dev
OPS_ENVIRONMENT=development
```

The bearer token protects a single-user read-only endpoint. Rotate it before
sharing the environment or if it may have appeared in logs. The local browser
receives neither this token nor the Supabase service key; it calls only the
loopback proxy through a one-time local bootstrap URL and an HttpOnly session
cookie. Run `pnpm ops deploy --rotate-token` to rotate the token without putting
it in shell history.

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

1. Push the migration: `mise exec -- pnpm supabase db push --include-all`
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
