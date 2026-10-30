#!/usr/bin/env bash
# Recria o banco de DESENVOLVIMENTO do zero: drop -> bootstrap -> migrations -> seed.
# Lê as variáveis de .env (veja .env.example). Nunca rode contra produção.
set -euo pipefail
cd "$(dirname "$0")/.."

set -a; . ./.env; set +a
: "${PGSUPER_URL:?}"; : "${DATABASE_URL_OWNER:?}"

psql "$PGSUPER_URL" -q -c "DROP DATABASE IF EXISTS helpdesk WITH (FORCE)"
./db/bootstrap.sh
./db/migrate.sh
psql "$DATABASE_URL_OWNER" -v ON_ERROR_STOP=1 -q -f db/seed/dev.sql
echo "Banco de desenvolvimento pronto."
