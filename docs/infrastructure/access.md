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

## Chroma

The bootstrap runs Chroma locally through Docker and requires no account or API key.

## Local Worker secrets

For local development only:

```sh
cp apps/pipeline-worker/.dev.vars.example apps/pipeline-worker/.dev.vars
```

Populate the ignored `.dev.vars` file locally. Never put real credentials in `.dev.vars.example`.
