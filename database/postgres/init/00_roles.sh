#!/bin/bash
# Runs once inside the container on first start (empty data volume).
# rainready_admin (POSTGRES_USER) owns the schema; rainready_app is the least-privilege
# login the Node backend will use. rainready_app is subject to row-level security.
# No "set -u" here: on Windows checkouts this file has no execute bit, so the postgres
# entrypoint sources it into its own shell, which already runs with "set -Eeo pipefail".

psql -v ON_ERROR_STOP=1 --username "$POSTGRES_USER" --dbname "$POSTGRES_DB" \
  -v app_pw="$APP_DB_PASSWORD" <<'EOSQL'
CREATE ROLE rainready_app LOGIN PASSWORD :'app_pw' NOSUPERUSER NOCREATEDB NOCREATEROLE NOBYPASSRLS;
REVOKE ALL ON DATABASE rainready FROM PUBLIC;
REVOKE CREATE ON SCHEMA public FROM PUBLIC;
GRANT CONNECT ON DATABASE rainready TO rainready_app;
EOSQL
