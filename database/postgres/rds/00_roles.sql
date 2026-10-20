-- Amazon RDS for PostgreSQL: the RDS equivalent of init/00_roles.sh.
-- Run through rds/apply.sql as the RDS master user (rainready_admin).
-- The RDS master user is not a superuser, so the role is created here in plain SQL and
-- its password is set afterwards with:  \password rainready_app
-- (psql prompts for it; it never appears in a file or in shell history).

DO $$
BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'rainready_app') THEN
        CREATE ROLE rainready_app LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOBYPASSRLS;
    END IF;
END $$;

-- Lets the master user run the test scripts, which use SET ROLE rainready_app
-- (PostgreSQL 16+ no longer grants this automatically to the role's creator).
GRANT rainready_app TO CURRENT_USER WITH SET TRUE;

REVOKE ALL ON DATABASE rainready FROM PUBLIC;
REVOKE CREATE ON SCHEMA public FROM PUBLIC;
GRANT CONNECT ON DATABASE rainready TO rainready_app;
