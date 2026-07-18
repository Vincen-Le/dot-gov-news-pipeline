#!/usr/bin/env bash

set -euo pipefail

readonly repository_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
readonly database_container="${SUPABASE_DB_CONTAINER:-supabase_db_dot-gov-news-pipeline}"
readonly test_database="news_source_migration_test"

cleanup() {
  docker exec "${database_container}" dropdb \
    --username postgres \
    --if-exists \
    --force \
    "${test_database}" >/dev/null
}

if ! docker inspect "${database_container}" >/dev/null 2>&1; then
  echo "Local Supabase database container ${database_container} is not running." >&2
  echo "Start it with: pnpm supabase start" >&2
  exit 1
fi

trap cleanup EXIT
cleanup
docker exec "${database_container}" createdb \
  --username postgres \
  "${test_database}"

readonly migrations=(
  "supabase/migrations/20260717000100_create_pipeline_events.sql"
  "supabase/migrations/20260717000200_harden_pipeline_event_grants.sql"
  "supabase/migrations/20260717000300_create_government_site_inventory.sql"
  "supabase/migrations/20260717000400_create_feed_discovery.sql"
  "supabase/migrations/20260718000100_add_pending_only_discovery_claim.sql"
  "supabase/migrations/20260718000200_add_backfill_domain_lanes.sql"
)

for migration in "${migrations[@]}"; do
  docker exec -i "${database_container}" psql \
    --username postgres \
    --dbname "${test_database}" \
    --set ON_ERROR_STOP=1 \
    < "${repository_root}/${migration}"
done

docker exec -i "${database_container}" psql \
  --username postgres \
  --dbname "${test_database}" \
  --set ON_ERROR_STOP=1 \
  < "${repository_root}/supabase/migration-tests/legacy_news_sources_fixture.sql"

docker exec -i "${database_container}" psql \
  --username postgres \
  --dbname "${test_database}" \
  --set ON_ERROR_STOP=1 \
  < "${repository_root}/supabase/migrations/20260718000300_generalize_news_sources.sql"

docker exec -i "${database_container}" psql \
  --username postgres \
  --dbname "${test_database}" \
  --set ON_ERROR_STOP=1 \
  < "${repository_root}/supabase/migration-tests/news_sources_migration_assertions.sql"

echo "Legacy-to-news-source migration assertions passed."
