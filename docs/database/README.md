# Database Guide

This directory explains how to reconstruct, inspect, and safely change the
dot-gov news database. The executable source of truth is the ordered SQL in
[`supabase/migrations`](../../supabase/migrations); these documents describe
the resulting schema but do not replace those migrations.

## Start here

- [Schema reference](schema-reference.md) lists every current, durable public
  table and view, grouped by responsibility.
- [Relationships and lifecycle](relationships.md) explains ownership,
  high-value foreign keys, deletion behavior, and the flow from inventory to
  curated output.
- [Infrastructure runbook](../infrastructure/runbook.md) covers hosted
  credentials, deployment, backups, incidents, and recovery.

## Platform assumptions

The supported database is PostgreSQL 17 managed through Supabase. The
migration chain assumes the Supabase `public`, `extensions`, and
`graphql_public` schemas and the `anon`, `authenticated`, and `service_role`
roles already exist. It creates the application-specific `corpus_reader` role.

Application rows use:

- `uuid` identifiers, normally generated with `gen_random_uuid()`;
- `timestamptz` for every operational or event timestamp;
- `jsonb` for bounded structured payloads and reproducibility metadata;
- `bytea` for compact fp16 embeddings rather than a PostgreSQL vector type;
- row-level security on every public application table.

## Rebuild a local database from nothing

Install the pinned toolchains and dependencies from the repository root:

```sh
mise install
mise exec -- pnpm install --frozen-lockfile
uv sync --locked
```

Start Supabase, destroy and recreate the local application database, then run
the database verification suites:

```sh
mise exec -- pnpm supabase start
mise exec -- pnpm supabase db reset
mise exec -- pnpm test:migration
mise exec -- pnpm supabase test db
```

`supabase db reset` is destructive to the local database. It reapplies every
migration in filename order and then runs [`supabase/seed.sql`](../../supabase/seed.sql).
The seed file grants local test impersonation permissions; it does not insert
application data.

Verify the resulting catalog from the local Postgres container:

```sh
mise exec -- pnpm supabase status
mise exec -- pnpm supabase db dump --local --schema public --file /tmp/dot-gov-schema.sql
```

The reset is complete when:

- the latest migration is present in `supabase_migrations.schema_migrations`;
- the pgTAP suite passes;
- `public.usable_government_sites` can be queried;
- the feed-only legacy tables `feeds`, `government_site_feeds`, and
  `feed_fetch_state` do not exist;
- the current experiment tables use the `complex_v1_*` and `simple_v1_*`
  namespaces.

## Build the schema in another database

### Recommended: a fresh Supabase project

1. Create a Supabase project using PostgreSQL 17.
2. Copy this repository and install the pinned Node dependencies.
3. Link the CLI to the new project.
4. preview the complete migration set, then apply it.

```sh
mise exec -- pnpm supabase link --project-ref <project-ref>
mise exec -- pnpm supabase db push --dry-run --include-all
mise exec -- pnpm supabase db push --include-all
```

Use `--include-all` because migration
`20260719120000_grant_corpus_read.sql` was added after later-timestamped
migrations had already shipped to the original hosted project. A second dry
run should report that the remote database is up to date:

```sh
mise exec -- pnpm supabase db push --dry-run --include-all
```

Do not copy project identifiers, secrets, or data from the original hosted
project. Configure a new `SUPABASE_URL` and server-side service key in ignored
environment files.

### Plain PostgreSQL

The table DDL is standard PostgreSQL, but applying the migration files directly
to a non-Supabase server is not a supported one-command path. Before applying
them in lexical order, an administrator must provide equivalent schemas,
roles, `gen_random_uuid()`, and API/security semantics for Supabase's
`anon`, `authenticated`, and `service_role` roles. The migrations deliberately
revoke public access and rely on those roles for grants and RLS policies.

If Supabase compatibility is not desired, treat the migration chain as the
reference implementation and create a separately reviewed bootstrap rather
than editing already-applied migrations.

## Migration rules

- Add a new timestamped migration; never rewrite a migration that may have
  reached another database.
- Put table creation, constraints, indexes, RLS, grants, and related RPCs in
  the same migration when practical.
- Revoke default access before granting the smallest required privileges.
- Prefer service-only RPCs for multi-table writes and lease transitions.
- Make retryable writes converge with unique keys, lease tokens, or explicit
  idempotency keys.
- Add or update pgTAP coverage in [`supabase/tests/database`](../../supabase/tests/database).
- Run a clean `db reset`, the legacy migration harness, and the complete pgTAP
  suite before shipping.

## Roles and row-level security

All current public application tables have RLS enabled. Unless a migration
explicitly grants access, client roles cannot read or mutate them.

| Role            | Intended use                              | Current direct corpus access                                                                              |
| --------------- | ----------------------------------------- | --------------------------------------------------------------------------------------------------------- |
| `service_role`  | Trusted server and batch applications     | Service-specific grants and RPC execution                                                                 |
| `anon`          | Public, read-only corpus client           | `SELECT` on `news_sources`, `news_source_publishers`, and `news_entries` through the `corpus_read` policy |
| `corpus_reader` | Dedicated, no-login read role             | Same three corpus relations through `corpus_read`                                                         |
| `authenticated` | Reserved for future authenticated clients | No general application-table access                                                                       |

Service credentials must never be exposed to a browser. The operator API and
batch applications keep the service key server-side.

## Stable database interfaces

Most application writes use bounded RPCs instead of direct multi-table CRUD.
The main interface families are:

| Domain            | Representative RPCs                                                                                                                                                                |
| ----------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Inventory         | `begin_gsa_inventory_sync`, `stage_gsa_inventory_batch`, `finalize_gsa_inventory_sync`, `get_government_inventory_summary`                                                         |
| Discovery         | `claim_due_site_discoveries`, `renew_site_discovery_lease`, `complete_site_discovery`, `fail_site_discovery`, `recover_expired_site_discovery_leases`                              |
| Backfill          | `begin_news_backfill_run`, `ensure_news_backfill_target`, `ingest_news_entries_v2`, `checkpoint_news_backfill_target`, `complete_news_backfill_target`, `finish_news_backfill_run` |
| Clustering        | `upsert_news_source`, `ingest_news_entry`, `update_entry_features`, `create_episode_with_storyline`, `attach_entry_to_episode`, `insert_event_card`                                |
| Topics            | `upsert_topic_category`, `create_topic_theme`, `assign_storyline_theme`, `set_storyline_category`, `merge_topic_theme`, `demote_topic_theme`                                       |
| Evaluation        | `begin_topology_label_set`, `upsert_news_entry_topology_labels`, the namespaced snapshot capture/annotation RPCs                                                                   |
| Golden enrichment | `publish_golden_event_card_article_overview`                                                                                                                                       |

Function signatures and grants can evolve. Before integrating a new caller,
inspect the latest migration and generated Supabase API rather than relying on
the abbreviated list above.

## Loading or restoring data

For a complete environment, prefer a PostgreSQL/Supabase dump so cyclic links
such as `storylines.latest_card_id` and `event_cards.storyline_id` are restored
correctly. For purpose-built imports, load domains in this order:

1. inventory runs and government sites;
2. news sources, site provenance, publisher identity, and fetch state;
3. news entries and entry origins;
4. categories, themes, storylines, episodes, episode membership, and cards;
5. experiment, ranking, topology-label, and golden datasets.

Backfill control and audit tables are operational history. They are useful for
resuming the same job, but are not required to reconstruct a read-only corpus
from already normalized entries.

## Intentionally excluded schemas

The detailed reference omits `private.gsa_inventory_stage`. It is a transient,
service-owned buffer whose rows are validated and consumed by inventory RPCs;
external callers should not build against it.

The names `feeds`, `government_site_feeds`, and `feed_fetch_state` are
historical. They were replaced by the generalized news-source model and are
absent from the current schema. Likewise, generic `experiment_runs` and
`experiment_cluster_snapshots` names were replaced by namespaced experiment
families. New integrations must use only the current names in the schema
reference.
