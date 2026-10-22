-- Migration 001: let events_near() use the event_date index as well as the location index.
--
-- New databases already get this from init/01_schema.sql. Run this once on a database that
-- was created before 21 Oct 2026 (local Docker or RDS). Safe to run more than once.
--   Local Docker:  docker compose exec db psql -U rainready_admin -d rainready -f /migrations/001_events_near_date_index.sql
--   RDS:           psql -f migrations/001_events_near_date_index.sql
-- CREATE OR REPLACE keeps the existing EXECUTE grant to rainready_app.
\set ON_ERROR_STOP on
BEGIN;

CREATE OR REPLACE FUNCTION events_near(p_lat double precision, p_lon double precision,
                                       p_radius_m double precision,
                                       p_from timestamptz DEFAULT now(),
                                       p_lookahead interval DEFAULT interval '24 hours')
RETURNS SETOF events_with_start
LANGUAGE sql STABLE AS $$
    SELECT *
      FROM events_with_start e
     WHERE e.event_date BETWEEN ((p_from - interval '6 hours') AT TIME ZONE 'Asia/Singapore')::date
                            AND ((p_from + p_lookahead) AT TIME ZONE 'Asia/Singapore')::date
       AND e.starts_at BETWEEN p_from - interval '6 hours' AND p_from + p_lookahead
       AND ST_DWithin(e.location, ST_SetSRID(ST_MakePoint(p_lon, p_lat), 4326)::geography, p_radius_m);
$$;

COMMIT;
\echo 'Migration 001 applied: events_near() now filters by event_date as well as location.'
