# Documentation Index

This directory is the entry point for repository documentation. Start here
before changing or operating the pipeline.

## Find the right source

| Goal                                                           | Read first                                                                                      | Then inspect                                                                                                                        |
| -------------------------------------------------------------- | ----------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------- |
| Orient to the project, status, and architecture diagram        | [NDS project hub](https://app.notion.com/p/3a02b47c562f80458178c5134d15dab3)                    | [Architecture](../architecture.md) and the current live provider state                                                              |
| Understand the architecture, current state, and planned phases | [Architecture](../architecture.md)                                                              | [Repository README](../README.md)                                                                                                   |
| Authenticate to Supabase or Cloudflare                         | [Provider access](infrastructure/access.md)                                                     | The relevant provider CLI output                                                                                                    |
| Install dependencies or verify the repository                  | [Infrastructure runbook](infrastructure/runbook.md)                                             | [`package.json`](../package.json), [`mise.toml`](../mise.toml), and CI configuration                                                |
| Inspect, run, or recover the GSA inventory sync                | [GSA inventory runbook](infrastructure/runbook.md#gsa-government-site-inventory)                | [`apps/inventory-sync`](../apps/inventory-sync) and the inventory migration                                                         |
| Query government sites or discovery due state                  | [Service-only inventory API](infrastructure/runbook.md#service-only-inventory-api)              | [`20260717000300_create_government_site_inventory.sql`](../supabase/migrations/20260717000300_create_government_site_inventory.sql) |
| Run or deploy the Worker                                       | [Infrastructure runbook](infrastructure/runbook.md)                                             | [`wrangler.jsonc`](../apps/pipeline-worker/wrangler.jsonc) and Worker source                                                        |
| Add or change durable database state                           | [Architecture](../architecture.md)                                                              | [`supabase/migrations`](../supabase/migrations) and [`supabase/config.toml`](../supabase/config.toml)                               |
| Work with the event envelope                                   | [`pipeline-event.ts`](../packages/contracts/src/pipeline-event.ts)                              | Contract and Worker tests                                                                                                           |
| Start or recover local Chroma                                  | [Infrastructure runbook](infrastructure/runbook.md)                                             | [`infra/chroma/compose.yaml`](../infra/chroma/compose.yaml)                                                                         |
| Rotate credentials or investigate failures                     | [Infrastructure runbook](infrastructure/runbook.md)                                             | [Provider access](infrastructure/access.md)                                                                                         |
| Remove infrastructure                                          | [Teardown procedure](infrastructure/teardown.md)                                                | Live provider inventory before taking action                                                                                        |
| Understand the original bootstrap decisions                    | [Implementation plan](../.claude/plans/minimal-infrastructure-bootstrap-implementation-plan.md) | Current configuration and runbook for implemented state                                                                             |

## Core documents

- [Architecture](../architecture.md) is the primary technical handoff. It
  distinguishes implemented infrastructure from proposed ingestion, discovery,
  polling, and downstream phases.
- [Provider access](infrastructure/access.md) contains non-secret project
  identifiers and safe authentication procedures.
- [Infrastructure runbook](infrastructure/runbook.md) is the primary operating
  guide for setup, deployment, verification, incidents, rotation, limits, and
  recovery.
- [Teardown procedure](infrastructure/teardown.md) contains the ordered,
  destructive removal process.
- [Implementation plan](../.claude/plans/minimal-infrastructure-bootstrap-implementation-plan.md)
  records the completed bootstrap scope and acceptance criteria.
- [Inventory and feed-discovery plan](../.claude/plans/gsa-inventory-and-feed-discovery-implementation-plan.md)
  records the detailed inventory decisions and the remaining discovery work.

## Notion project hub

The [NDS project hub](https://app.notion.com/p/3a02b47c562f80458178c5134d15dab3)
is the agent- and human-friendly orientation layer for project status,
decisions, and visual architecture. Update it in the same body of work when a
material architecture decision, infrastructure resource, implementation
milestone, or project diagram changes.

Keep executable configuration, schemas, migrations, tests, operational
commands, and detailed designs in this repository. Summarize and link those
changes from NDS; do not make Notion the only record of a technical decision.

## Sources of truth

When documentation and implementation disagree, use this precedence:

1. Live provider state for operational facts such as deployment status,
   backlog, and resource existence.
2. Version-controlled configuration and migrations for the intended deployed
   state.
3. The infrastructure runbook for procedures and recorded verification.
4. The architecture document for system design and future implementation
   direction.
5. The implementation plan for historical decisions and bootstrap scope.

Update the relevant documentation in the same change whenever infrastructure
names, bindings, migrations, commands, access requirements, architecture, or
operational procedures change.

## Current scope

The repository currently provides:

- Supabase durable event storage and hosted infrastructure heartbeat state.
- Cloudflare Worker, Cron Trigger, Queue, DLQ, and R2 artifact storage.
- A Node/TypeScript GSA inventory batch with HTTPS-only bounded downloads,
  streaming SHA-256, strict CSV normalization, and content-addressed R2
  archival.
- Atomic inventory reconciliation into `government_sites`, with private
  staging, auditable sync runs, soft deactivation, checksum no-ops, and
  service-only query/RPC access.
- `site_discovery_state` due rows plus lease-safe claim and expired-lease
  recovery RPCs. These are durable discovery backlog primitives, not an active
  discovery Worker.
- A Thursday `04:17 UTC` GitHub Actions workflow with manual dispatch and a
  reviewed large-decrease override.
- Local persistent Chroma development service, shared event contracts, unit
  and database tests, CI verification, and operations guidance.

Actual feed discovery, feed tables, feed polling, article parsing, embeddings,
search, ranking, public APIs, and the user interface remain follow-up work. Do
not infer that they exist from their architectural designs or from pending
`site_discovery_state` rows.

## Safety for agents

- Never place Supabase keys, Cloudflare tokens, database passwords, or other
  credentials in documentation or tracked files.
- Resolve exact resource names and inspect live state before destructive
  operations.
- Add new database changes as migrations; do not rewrite migrations that have
  already been applied remotely.
- Keep Chroma local-only unless a later design explicitly selects hosted vector
  infrastructure.
- Do not introduce dependencies on Zip-owned infrastructure.
