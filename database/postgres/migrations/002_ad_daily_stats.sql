-- Migration 002: counters for sponsored messages (ads on the Free plan).
--
-- New databases already get this from init/01_schema.sql and init/02_security.sql. Run this once
-- on a database created before the ads feature (local Docker or RDS). Safe to run more than once.
--   Local Docker:  docker compose exec db psql -U rainready_admin -d rainready -f /migrations/002_ad_daily_stats.sql
--   RDS:           psql -f migrations/002_ad_daily_stats.sql
\set ON_ERROR_STOP on
BEGIN;

CREATE TABLE IF NOT EXISTS ad_daily_stats (
    ad_id        text    NOT NULL CHECK (ad_id ~ '^[a-z0-9][a-z0-9-]{1,47}$'),
    placement    text    NOT NULL CHECK (placement IN ('overview', 'events', 'decisions', 'settings')),
    day          date    NOT NULL,             -- Singapore calendar day
    impressions  integer NOT NULL DEFAULT 0 CHECK (impressions >= 0),
    clicks       integer NOT NULL DEFAULT 0 CHECK (clicks >= 0),
    PRIMARY KEY (ad_id, placement, day)
);
COMMENT ON TABLE ad_daily_stats IS
    'Sponsored-message counters per ad, placement and day. Aggregated only: no user, organisation or event identifiers.';

GRANT SELECT, INSERT, UPDATE         ON ad_daily_stats           TO rainready_app;  -- update: counter += 1

COMMIT;
\echo 'Migration 002 applied: ad_daily_stats created and granted to rainready_app.'
