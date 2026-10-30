#!/usr/bin/env bash
# Aplica db/migrations/*.sql em ordem, uma vez cada, como sd_owner.
#   DATABASE_URL_OWNER=postgresql://sd_owner:...@localhost:5432/helpdesk ./db/migrate.sh
set -euo pipefail

: "${DATABASE_URL_OWNER:?defina DATABASE_URL_OWNER}"
DIR="$(cd "$(dirname "$0")" && pwd)/migrations"
PSQL=(psql "$DATABASE_URL_OWNER" -v ON_ERROR_STOP=1 -q)

"${PSQL[@]}" -c "CREATE TABLE IF NOT EXISTS schema_migrations (
  version text PRIMARY KEY, applied_at timestamptz NOT NULL DEFAULT now())"

for f in "$DIR"/*.sql; do
  v="$(basename "$f" .sql)"
  done_already="$("${PSQL[@]}" -tA -c "SELECT 1 FROM schema_migrations WHERE version = '$v'")"
  if [ -z "$done_already" ]; then
    echo "-> aplicando $v"
    "${PSQL[@]}" --single-transaction -f "$f" \
      -c "INSERT INTO schema_migrations(version) VALUES ('$v')"
  fi
done
echo "Migrations em dia."
