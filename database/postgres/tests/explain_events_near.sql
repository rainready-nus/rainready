-- Evidence for the report: events_near() uses indexes instead of reading every event.
-- Loads 20,000 synthetic events across Singapore over a 4-month span, prints the query plans
-- and row counts, then rolls everything back. Nothing is left in the database.
--   docker compose exec db psql -U rainready_admin -d rainready -f /tests/explain_events_near.sql
-- What to look for in plan 1: "Index Scan" or "Bitmap Index Scan" on idx_events_location
-- and/or idx_events_date, and no "Seq Scan on events". Plan 2 shows the full-scan alternative.
\set ON_ERROR_STOP on
\pset pager off
BEGIN;

INSERT INTO organizations (id, name, created_at) VALUES ('explain-demo-org', 'EXPLAIN demo', now());

INSERT INTO events (id, organization_id, name, venue, latitude, longitude, event_date, event_time,
                    event_type, sensitivity, participant_count, created_at, updated_at)
SELECT 'explain-' || g, 'explain-demo-org', 'Synthetic event ' || g, 'Synthetic venue',
       1.24 + random() * 0.22,                                  -- latitude across Singapore
       103.62 + random() * 0.38,                                -- longitude across Singapore
       current_date + (floor(random() * 121)::int - 60),        -- 60 days back to 60 days ahead
       make_time(7 + floor(random() * 14)::int, (floor(random() * 4) * 15)::int, 0),
       'Sports', (ARRAY['low', 'medium', 'high'])[1 + floor(random() * 3)::int], 50, now(), now()
  FROM generate_series(1, 20000) AS g;

ANALYZE events;   -- up-to-date statistics so the planner sees the real table size

\echo ''
\echo '== Row counts: all events vs. events within 5 km of UTown starting in the next 24 hours'
SELECT (SELECT count(*) FROM events) AS events_stored,
       (SELECT count(*) FROM events_near(1.3050, 103.7735, 5000)) AS events_returned;

\echo ''
\echo '== Plan 1: events_near() as RainReady calls it (indexes available)'
EXPLAIN (ANALYZE, BUFFERS)
SELECT id, name, starts_at FROM events_near(1.3050, 103.7735, 5000);

\echo ''
\echo '== Plan 2: the same query with index use switched off, i.e. reading every event'
SET LOCAL enable_indexscan = off;
SET LOCAL enable_bitmapscan = off;
EXPLAIN (ANALYZE, BUFFERS)
SELECT id, name, starts_at FROM events_near(1.3050, 103.7735, 5000);

ROLLBACK;
\echo ''
\echo 'Synthetic events rolled back; the database is unchanged.'
