#!/usr/bin/env bash
# Cria banco, roles e extensões. Rodar UMA vez como superusuário do Postgres.
#
#   PGSUPER_URL=postgresql://postgres@localhost:5432/postgres \
#   OWNER_PASSWORD=... APP_PASSWORD=... WORKER_PASSWORD=... \
#   ./db/bootstrap.sh
#
# Roles:
#   sd_owner  - dono do schema; roda migrations; NUNCA usado pela aplicação
#   sd_app    - role da API; sujeita a RLS (NOBYPASSRLS)
#   sd_worker - jobs/webhooks (fila de e-mail, SLA, cobrança); BYPASSRLS, com grants mínimos
set -euo pipefail

: "${PGSUPER_URL:?defina PGSUPER_URL}"
: "${OWNER_PASSWORD:?}"
: "${APP_PASSWORD:?}"
: "${WORKER_PASSWORD:?}"
DB_NAME="${DB_NAME:-helpdesk}"

psql "$PGSUPER_URL" -v ON_ERROR_STOP=1 -q \
  -v owner_pw="$OWNER_PASSWORD" -v app_pw="$APP_PASSWORD" -v worker_pw="$WORKER_PASSWORD" \
  -v db_name="$DB_NAME" <<'SQL'
SELECT format('CREATE ROLE sd_owner LOGIN PASSWORD %L NOSUPERUSER NOBYPASSRLS', :'owner_pw')
 WHERE NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'sd_owner') \gexec
SELECT format('CREATE ROLE sd_app LOGIN PASSWORD %L NOSUPERUSER NOBYPASSRLS', :'app_pw')
 WHERE NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'sd_app') \gexec
SELECT format('CREATE ROLE sd_worker LOGIN PASSWORD %L NOSUPERUSER BYPASSRLS', :'worker_pw')
 WHERE NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'sd_worker') \gexec

SELECT format('CREATE DATABASE %I OWNER sd_owner ENCODING ''UTF8'' TEMPLATE template0', :'db_name')
 WHERE NOT EXISTS (SELECT 1 FROM pg_database WHERE datname = :'db_name') \gexec
SQL

# Extensões (precisam de superusuário em alguns ambientes gerenciados)
DB_URL="${PGSUPER_URL%/*}/${DB_NAME}"
psql "$DB_URL" -v ON_ERROR_STOP=1 -q <<'SQL'
CREATE EXTENSION IF NOT EXISTS citext;
CREATE EXTENSION IF NOT EXISTS pg_trgm;
CREATE EXTENSION IF NOT EXISTS unaccent;
CREATE EXTENSION IF NOT EXISTS pgcrypto;
REVOKE ALL ON SCHEMA public FROM PUBLIC;
GRANT USAGE, CREATE ON SCHEMA public TO sd_owner;
GRANT USAGE ON SCHEMA public TO sd_app, sd_worker;
SQL

echo "Bootstrap ok: banco '${DB_NAME}', roles sd_owner / sd_app / sd_worker"
