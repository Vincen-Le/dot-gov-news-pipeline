#!/usr/bin/env bash
# scripts/create-spine-bench.sh
# Provision a parallel bench database so spine experiments never touch the
# classic engine's bench state. Clones corpus + prepared features (embeddings,
# enrichment — the expensive half) from the primary bench db, truncates run
# history, and wipes derived clustering state.
set -euo pipefail

readonly repository_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
readonly database_container="${SUPABASE_DB_CONTAINER:-supabase_db_dot-gov-news-pipeline}"
readonly bench_database="${1:-spine_bench}"
readonly source_database="${SOURCE_DATABASE:-postgres}"
readonly bench_url="postgresql://postgres:postgres@127.0.0.1:57422/${bench_database}"

if [[ "${bench_database}" == "${source_database}" ]]; then
  echo "Refusing: bench database (${bench_database}) must differ from the source database (${source_database}) — this would dropdb --force the source, then clone it into itself." >&2
  exit 1
fi
if [[ "${bench_database}" == "postgres" ]]; then
  echo "Refusing: 'postgres' is not a valid bench database name (it is the default primary database)." >&2
  exit 1
fi

if ! docker inspect "${database_container}" >/dev/null 2>&1; then
  echo "Local Supabase database container ${database_container} is not running." >&2
  echo "Start it with: pnpm supabase start" >&2
  exit 1
fi

docker exec "${database_container}" dropdb \
  --username postgres --if-exists --force "${bench_database}"
docker exec "${database_container}" createdb \
  --username postgres "${bench_database}"

# Full-db clone keeps corpus, features, RPCs, and grants identical. Supabase
# system schemas restore with benign ownership noise (hence no ON_ERROR_STOP);
# the verification below is what actually gates success.
docker exec "${database_container}" pg_dump \
    --username postgres --dbname "${source_database}" \
  | docker exec -i "${database_container}" psql \
      --username postgres --dbname "${bench_database}" --quiet \
  >/dev/null 2>"/tmp/${bench_database}-restore.log" || true

sql() {
  docker exec "${database_container}" psql \
    --username postgres --dbname "${bench_database}" \
    --tuples-only --no-align --command "$1"
}

entries="$(sql 'select count(*) from public.news_entries')"
features="$(sql 'select count(*) from public.news_entries where embedding is not null')"
rpc="$(sql "select count(*) from pg_proc p
            join pg_namespace n on n.oid = p.pronamespace
            where n.nspname = 'public'
              and p.proname = 'create_episode_with_storyline'")"
if [[ "${entries}" -eq 0 || "${rpc}" -ne 1 ]]; then
  echo "Clone verification failed (entries=${entries}, rpc=${rpc})." >&2
  echo "See /tmp/${bench_database}-restore.log" >&2
  exit 1
fi

# Cloned run history belongs to the classic engine — drop it, then wipe
# derived clustering state (corpus + prepared features survive). rank_
# snapshots/rank_audit_pairs/rank_audit_runs all FK to experiment_runs
# ON DELETE CASCADE, so the cascading truncate clears them too.
sql 'truncate public.experiment_runs cascade' >/dev/null
cd "${repository_root}"
DATABASE_URL="${bench_url}" uv run python -m pipeline.cli reset --clusters

echo "Bench database ready: ${bench_url}"
echo "  entries: ${entries}  with features: ${features}"
