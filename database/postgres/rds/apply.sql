-- Apply the RainReady schema to an empty Amazon RDS for PostgreSQL 16 database.
--   cd database\postgres
--   psql -f rds/apply.sql        (connection settings come from PG* environment variables)
-- Everything runs in one transaction: if any statement fails, nothing is created.
-- Run it once per database; a second run fails harmlessly because the tables already exist.
\set ON_ERROR_STOP on
BEGIN;
\ir 00_roles.sql
\ir ../init/01_schema.sql
\ir ../init/02_security.sql
\ir ../init/03_reference_data.sql
COMMIT;
\echo 'RainReady schema applied. Next: set the app password with  \password rainready_app'
