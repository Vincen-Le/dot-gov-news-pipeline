#!/usr/bin/env bash
# scripts/create-pipeline-db.sh <pipeline> [source_db]
#
# Provision a per-pipeline database `<pipeline>_db` from scratch: apply every
# supabase/migrations/*.sql migration in filename order, then copy the corpus
# (news_sources, news_source_publishers, news_entries — read-only source
# tables, not derived clustering state) from a source database (default
# `postgres`) via pg_dump --data-only. This replaces the clone-based
# create-spine-bench.sh: every pipeline gets its own database with an
# identical, migration-defined schema rather than a full clone of another
# bench's derived state.
#
# A fresh pipeline database starts clean: no run history, no episodes,
# storylines, or event cards — only the corpus survives the copy.
set -euo pipefail

readonly repository_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
readonly database_container="${SUPABASE_DB_CONTAINER:-supabase_db_dot-gov-news-pipeline}"
readonly pipeline_name="${1:?usage: create-pipeline-db.sh <pipeline> [source_db]}"
readonly source_database="${2:-postgres}"
readonly target_database="${pipeline_name}_db"
readonly target_url="postgresql://postgres:postgres@127.0.0.1:57422/${target_database}"

if [[ "${target_database}" == "postgres" ]]; then
  echo "Refusing: 'postgres' is not a valid pipeline database name (it is the primary database)." >&2
  exit 1
fi
if [[ "${target_database}" == "${source_database}" ]]; then
  echo "Refusing: target database (${target_database}) must differ from the source database (${source_database})." >&2
  exit 1
fi

if ! docker inspect "${database_container}" >/dev/null 2>&1; then
  echo "Local Supabase database container ${database_container} is not running." >&2
  echo "Start it with: pnpm supabase start" >&2
  exit 1
fi

docker exec "${database_container}" dropdb \
  --username postgres --if-exists --force "${target_database}"
docker exec "${database_container}" createdb \
  --username postgres "${target_database}"

shopt -s nullglob
migrations=("${repository_root}"/supabase/migrations/*.sql)
shopt -u nullglob
if [[ ${#migrations[@]} -eq 0 ]]; then
  echo "No migrations found under supabase/migrations/." >&2
  exit 1
fi

# Filenames sort lexicographically in the same order they were applied to
# the primary database (timestamp-prefixed), matching
# scripts/test-news-source-migration.sh's ON_ERROR_STOP pattern.
IFS=$'\n' migrations=($(sort <<<"${migrations[*]}"))
unset IFS
for migration in "${migrations[@]}"; do
  docker exec -i "${database_container}" psql \
    --username postgres \
    --dbname "${target_database}" \
    --set ON_ERROR_STOP=1 \
    --quiet \
    < "${migration}"
done

# news_sources and news_source_publishers have no FK outside the corpus
# tables being copied, so a plain data-only dump is safe and must land
# before news_entries, whose FK references news_sources.
docker exec "${database_container}" pg_dump \
    --username postgres --dbname "${source_database}" \
    --data-only \
    --table=public.news_sources \
    --table=public.news_source_publishers \
  | docker exec -i "${database_container}" psql \
      --username postgres --dbname "${target_database}" --quiet \
      --set ON_ERROR_STOP=1

sql() {
  docker exec "${database_container}" psql \
    --username postgres --dbname "${target_database}" \
    --tuples-only --no-align --command "$1"
}

# news_entries.episode_id is a clustering assignment (derived state) whose
# episodes/storylines rows are deliberately never copied here — a plain
# pg_dump of the table would violate its own FK against the still-empty
# episodes table. Copy every column except episode_id instead, discovered
# from the freshly migrated schema so future migrations' columns are picked
# up automatically.
news_entries_columns="$(
  docker exec "${database_container}" psql \
    --username postgres --dbname "${target_database}" \
    --tuples-only --no-align --command "
      select string_agg(quote_ident(column_name), ', ' order by ordinal_position)
      from information_schema.columns
      where table_schema = 'public' and table_name = 'news_entries'
        and column_name <> 'episode_id'
    "
)"
docker exec "${database_container}" psql \
    --username postgres --dbname "${source_database}" --quiet \
    --set ON_ERROR_STOP=1 \
    --command "\copy (select ${news_entries_columns} from public.news_entries) to stdout" \
  | docker exec -i "${database_container}" psql \
      --username postgres --dbname "${target_database}" --quiet \
      --set ON_ERROR_STOP=1 \
      --command "\copy public.news_entries (${news_entries_columns}) from stdin"

entries="$(sql 'select count(*) from public.news_entries')"
rpc="$(sql "select count(*) from pg_proc p
            join pg_namespace n on n.oid = p.pronamespace
            where n.nspname = 'public'
              and p.proname = 'create_episode_with_storyline'")"
# experiment_runs is namespaced per pipeline (supabase/migrations/
# 20260719140000, 20260719150000); the registry's pipeline name is the
# namespace itself (complex_v1, simple_v1), so <pipeline>_experiment_runs is
# the table this fresh database actually has.
experiment_runs_table="${pipeline_name}_experiment_runs"
experiment_runs_present="$(sql "select to_regclass('public.${experiment_runs_table}') is not null")"
experiment_runs_count="$(sql "select count(*) from public.${experiment_runs_table}")"

if [[ "${entries}" -eq 0 ]]; then
  echo "Verification failed: news_entries is empty after corpus copy." >&2
  exit 1
fi
if [[ "${rpc}" -ne 1 ]]; then
  echo "Verification failed: create_episode_with_storyline RPC is missing." >&2
  exit 1
fi
if [[ "${experiment_runs_present}" != "t" ]]; then
  echo "Verification failed: public.${experiment_runs_table} table is missing." >&2
  exit 1
fi
if [[ "${experiment_runs_count}" -ne 0 ]]; then
  echo "Verification failed: public.${experiment_runs_table} is not empty on a fresh database." >&2
  exit 1
fi

echo "Pipeline database ready: ${target_url}"
echo "  entries: ${entries}  experiment_runs: ${experiment_runs_count}"
