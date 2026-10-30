#!/usr/bin/env bash
# Roda a suíte de testes do banco (precisa de superusuário para usar SET ROLE).
#   PGSUPER_DB_URL=postgresql://postgres:...@localhost:5432/helpdesk ./db/tests/run.sh
set -euo pipefail
: "${PGSUPER_DB_URL:?defina PGSUPER_DB_URL}"
cd "$(dirname "$0")"
# stdout (tabelas de resultado) descartado; NOTICE/ERROR/\echo aparecem
psql "$PGSUPER_DB_URL" -v ON_ERROR_STOP=1 -q -f test_db.sql 2>&1 >/dev/null \
  | sed -e 's/^psql:[^ ]* //' -e 's/^NOTICE:  //'
exit "${PIPESTATUS[0]}"
