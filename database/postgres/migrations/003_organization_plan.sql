-- Migration 003: subscription plan per organisation. Free organisations see sponsored messages;
-- Community and Enterprise organisations do not. Existing organisations start on Free.
--
-- New databases already get this from init/01_schema.sql and init/02_security.sql. Run once on a
-- database created earlier, after 002. Safe to run more than once.
--   Local Docker:  docker compose exec db psql -U rainready_admin -d rainready -f /migrations/003_organization_plan.sql
--   RDS:           psql -f migrations/003_organization_plan.sql
\set ON_ERROR_STOP on
BEGIN;

ALTER TABLE organizations
    ADD COLUMN IF NOT EXISTS plan text NOT NULL DEFAULT 'free';
DO $$
BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'organizations_plan_check') THEN
        ALTER TABLE organizations ADD CONSTRAINT organizations_plan_check
            CHECK (plan IN ('free', 'community', 'enterprise'));
    END IF;
END $$;

-- The app may change the plan column only (operator script now, a billing webhook later).
GRANT UPDATE (plan) ON organizations TO rainready_app;

COMMIT;
\echo 'Migration 003 applied: organizations.plan added (existing organisations are on Free).'
