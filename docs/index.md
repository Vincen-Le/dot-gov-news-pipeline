# Documentation Index

This directory is the entry point for repository documentation. Start here
before changing or operating the pipeline.

## Find the right source

| Goal                                                                | Read first                                                                                                                   | Then inspect                                                                                                                                          |
| ------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------- |
| Orient to the project, status, and architecture diagram             | [NDS project hub](https://app.notion.com/p/3a02b47c562f80458178c5134d15dab3)                                                 | [Architecture](architecture.md) and the current live provider state                                                                                   |
| Understand the architecture, current state, and planned phases      | [Architecture](architecture.md)                                                                                              | [Repository README](../README.md)                                                                                                                     |
| Authenticate to Supabase or Cloudflare                              | [Provider access](infrastructure/access.md)                                                                                  | The relevant provider CLI output                                                                                                                      |
| Install dependencies or verify the repository                       | [Infrastructure runbook](infrastructure/runbook.md)                                                                          | [`package.json`](../package.json), [`mise.toml`](../mise.toml), and CI configuration                                                                  |
| Rebuild or reproduce the database                                   | [Database guide](database/README.md)                                                                                         | [Schema reference](database/schema-reference.md), [relationships](database/relationships.md), and [`supabase/migrations`](../supabase/migrations)     |
| Look up a table, key, constraint, or ownership boundary             | [Schema reference](database/schema-reference.md)                                                                             | [Relationships and lifecycle](database/relationships.md)                                                                                              |
| Inspect, run, or recover the GSA inventory sync                     | [GSA inventory runbook](infrastructure/runbook.md#gsa-government-site-inventory)                                             | [`apps/inventory-sync`](../apps/inventory-sync) and the inventory migration                                                                           |
| Query government sites or discovery due state                       | [Service-only inventory API](infrastructure/runbook.md#service-only-inventory-api)                                           | [`20260717000300_create_government_site_inventory.sql`](../supabase/migrations/20260717000300_create_government_site_inventory.sql)                   |
| Monitor health, inventory, queues, or Worker activity               | [Operator CLI cheatsheet](operations/cli-cheatsheet.md)                                                                      | [Operator dashboard design](archive/design-specs/2026-07-17-operator-dashboard-nds-design.md) and [`apps/operator-console`](../apps/operator-console) |
| Backfill the news corpus from curated manifests                     | [Runbook backfill section](infrastructure/runbook.md#news-corpus-backfill-artifacts-and-content)                             | [`apps/news-backfill`](../apps/news-backfill) and [`config/news-backfill`](../config/news-backfill)                                                   |
| Understand the simple, complex, and shared Python layout            | [Python pipeline guide](../pipeline/README.md)                                                                               | [Evaluation harness](operations/evaluation-harness.md), registry config, and database schema                                                          |
| Run or QA the clustering pipeline and experiments                   | [Evaluation harness runbook](operations/evaluation-harness.md)                                                               | [Clustering lab quick guide](operations/clustering-lab.md), [pipeline guide](../pipeline/README.md), and operator-console lab                         |
| Pick the next clustering experiment                                 | [Clustering experimentation spec](operations/clustering-experimentation-spec-2026-07-18.md)                                  | [Topic clustering research validation](operations/topic-clustering-research-validation-2026-07-18.md)                                                 |
| Improve storyline attachment in vector space                        | [Storyline vector representation spec](archive/design-specs/2026-07-18-storyline-vector-representation-hypotheses-design.md) | [Retrieval/enrichment hypotheses (H1–H3)](archive/design-specs/2026-07-18-clustering-retrieval-enrichment-hypotheses-design.md)                       |
| Run or deploy the Worker                                            | [Infrastructure runbook](infrastructure/runbook.md)                                                                          | [`wrangler.jsonc`](../apps/pipeline-worker/wrangler.jsonc) and Worker source                                                                          |
| Add or change durable database state                                | [Architecture](architecture.md)                                                                                              | [`supabase/migrations`](../supabase/migrations) and [`supabase/config.toml`](../supabase/config.toml)                                                 |
| Work with the event envelope                                        | [`pipeline-event.ts`](../packages/contracts/src/pipeline-event.ts)                                                           | Contract and Worker tests                                                                                                                             |
| Work with generalized news-source contracts                         | [`news-source.ts`](../packages/contracts/src/news-source.ts)                                                                 | Generalized schema migration and database tests                                                                                                       |
| Curate aggregation experiments by expected corpus topology          | [Topology-label curation](operations/topology-label-curation.md)                                                             | Versioned sidecar labels and deterministic whole-storyline sampling                                                                                   |
| Build the chronological human-reviewed anchor                       | [Golden news curation](operations/golden-news-curation.md)                                                                   | July-August batches, correction workflow, reconstruction, validation, export, and anchored replay                                                     |
| Generate card thumbnails/article synthesis or recover golden assets | [Image and synthesis generation](../apps/image_and_synthesis_gen/README.md)                                                  | Invoke the **Backfill Golden Enrichment** skill with `$golden-enrichment-backfill` for the reviewed-card workflow                                     |
| Start or recover local Chroma                                       | [Infrastructure runbook](infrastructure/runbook.md)                                                                          | [`infra/chroma/compose.yaml`](../infra/chroma/compose.yaml)                                                                                           |
| Rotate credentials or investigate failures                          | [Infrastructure runbook](infrastructure/runbook.md)                                                                          | [Provider access](infrastructure/access.md)                                                                                                           |
| Remove infrastructure                                               | [Teardown procedure](infrastructure/teardown.md)                                                                             | Live provider inventory before taking action                                                                                                          |
| Understand the original bootstrap decisions                         | [Implementation plan](archive/implementation-plans/minimal-infrastructure-bootstrap-implementation-plan.md)                  | Current configuration and runbook for implemented state                                                                                               |

## Core documents

- [Architecture](architecture.md) is the primary technical handoff. It
  distinguishes the implemented infrastructure, inventory, discovery,
  backfill, and offline clustering stages from the proposed recurring-fetch
  and serving phases.
- [Provider access](infrastructure/access.md) contains non-secret project
  identifiers and safe authentication procedures.
- [Infrastructure runbook](infrastructure/runbook.md) is the primary operating
  guide for setup, deployment, verification, incidents, rotation, limits, and
  recovery.
- [Database guide](database/README.md) is the reproducible database bootstrap,
  migration, role, RLS, and verification guide.
- [Schema reference](database/schema-reference.md) and
  [relationships and lifecycle](database/relationships.md) document the
  current durable public schema without exposing transient staging internals.
- [Teardown procedure](infrastructure/teardown.md) contains the ordered,
  destructive removal process.
- [Implementation plan](archive/implementation-plans/minimal-infrastructure-bootstrap-implementation-plan.md)
  records the completed bootstrap scope and acceptance criteria.
- [Inventory and news-source-discovery plan](archive/implementation-plans/gsa-inventory-and-news-source-discovery-implementation-plan.md)
  records the detailed inventory decisions and the remaining discovery work.
- [Operator CLI cheatsheet](operations/cli-cheatsheet.md) is the generated
  command catalog for health, inventory, queue, event, Worker-tail, and
  clustering-lab queries.
- [Clustering lab guide](operations/clustering-lab.md) is the QA and
  experiment quick reference for the Python clustering pipeline.
- [Python pipeline guide](../pipeline/README.md) defines the active simple
  implementation, retained complex implementation, shared modules, local
  database setup, and per-engine experiment/snapshot tables.
- [Image and synthesis generation](../apps/image_and_synthesis_gen/README.md)
  documents the independent thumbnail and article-synthesis lanes and the
  Backfill Golden Enrichment skill.
- [Evaluation harness runbook](operations/evaluation-harness.md) is the
  comprehensive guide to setup, costs, state boundaries, experiment design,
  topology curation, result interpretation, ranking audits, and recovery.
- [Operator dashboard design](archive/design-specs/2026-07-17-operator-dashboard-nds-design.md)
  records the private local console's interaction and visual design. (Its
  linked browser preview HTML has since been removed from the repository.)
- [Ranking pipeline design](archive/design-specs/2026-07-17-ranking-pipeline-design.md)
  records the proposed downstream clustering, ranking, and serving system.

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
  recovery RPCs, a bounded discovery Worker provisioned disabled, and a
  resumable direct backfill operator path.
- Generalized `news_sources`, many-to-many site provenance, and per-source
  fetch state for syndication, publisher API, HTML archive, and sitemap
  adapters, populated transactionally by discovery completion.
- A Thursday `04:17 UTC` GitHub Actions workflow with manual dispatch and a
  reviewed large-decrease override.
- A separately deployable, token-protected read-only Operator API plus an ad
  hoc CLI and loopback-only dashboard for health, inventory, queue, event, and
  sampled Worker lifecycle visibility.
- A manifest-driven news-corpus backfill (`apps/news-backfill`) with
  content-addressed R2 raw-artifact archival and idempotent entry ingestion.
- Python clustering implementations (`pipeline/simple`, `pipeline/complex`,
  and `pipeline/shared`) covering extraction, normalization, fp16 embeddings
  in Postgres, episode/storyline clustering, event and overview cards, and
  topic themes. The simple implementation is the golden-data path.
- Independent card thumbnail and article-synthesis tooling under
  `apps/image_and_synthesis_gen`; its current trusted exporter targets reviewed
  golden overview cards.
- An operator-console clustering lab (`pnpm ops lab …`) for corpus QA,
  experiments recorded per pipeline (`complex_v1_experiment_runs` /
  `simple_v1_experiment_runs`) with immutable cluster-state snapshots for
  replay, quality metrics, and borderline labeling.
- Local persistent Chroma development service, shared event contracts, unit
  and database tests, CI verification, and operations guidance.

Recurring discovery, complete feed inventory, recurring news-source polling
and ingestion workers, learned ranking, search, public APIs, and the user
interface remain follow-up work. The heartbeat and provisioned queues are
infrastructure scaffolding, not evidence of an always-on feed monitor.

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
