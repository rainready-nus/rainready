-- Correctness of events_near(): right place, right time window, one organisation only.
-- Self-contained; ROLLBACK at the end leaves no data behind.
--   docker compose exec db psql -U rainready_admin -d rainready -f /tests/events_near.sql
-- Success = the final line "PASS: events_near (6 checks)".
\set ON_ERROR_STOP on
BEGIN;

INSERT INTO organizations (id, name, created_at) VALUES
    ('test-near-a', 'Near Test A', now()),
    ('test-near-b', 'Near Test B', now());

-- Reference point: University Town (1.3050, 103.7735). Reference time: tomorrow 08:00 SGT.
-- Woodlands (1.4360, 103.7865) is about 14.6 km away, outside a 5 km radius.
INSERT INTO events (id, organization_id, name, venue, latitude, longitude,
                    event_date, event_time, event_type, sensitivity, created_at, updated_at) VALUES
    ('near-in-window',  'test-near-a', 'A: nearby, starts 2 h later',      'UTown',     1.3060, 103.7740, current_date + 1, '10:00', 'Sports', 'high', now(), now()),
    ('near-live',       'test-near-a', 'B: nearby, started 5 h earlier',   'UTown',     1.3040, 103.7730, current_date + 1, '03:00', 'Sports', 'high', now(), now()),
    ('near-too-late',   'test-near-a', 'C: nearby, starts in 3 days',      'UTown',     1.3050, 103.7735, current_date + 4, '10:00', 'Sports', 'high', now(), now()),
    ('near-too-early',  'test-near-a', 'D: nearby, started 12 h earlier',  'UTown',     1.3050, 103.7735, current_date,     '20:00', 'Sports', 'high', now(), now()),
    ('far-in-window',   'test-near-a', 'E: far away, starts 2 h later',    'Woodlands', 1.4360, 103.7865, current_date + 1, '10:00', 'Sports', 'high', now(), now()),
    ('other-org-near',  'test-near-b', 'F: nearby, other organisation',    'UTown',     1.3055, 103.7738, current_date + 1, '10:00', 'Sports', 'high', now(), now());

SET LOCAL ROLE rainready_app;
SELECT set_config('app.organization_id', 'test-near-a', true);

DO $$
DECLARE
    found text[];
    ref   timestamptz := (current_date + 1 + time '08:00') AT TIME ZONE 'Asia/Singapore';
BEGIN
    SELECT array_agg(id ORDER BY id) INTO found
      FROM events_near(1.3050, 103.7735, 5000, ref, interval '24 hours')
     WHERE id IN ('near-in-window', 'near-live', 'near-too-late', 'near-too-early', 'far-in-window', 'other-org-near');

    ASSERT 'near-in-window' = ANY (found), '1: nearby event starting within the window was not returned';
    ASSERT 'near-live'      = ANY (found), '2: nearby event that started within the last 6 hours was not returned';
    ASSERT NOT ('near-too-late'  = ANY (found)), '3: event starting after the look-ahead window was returned';
    ASSERT NOT ('near-too-early' = ANY (found)), '4: event that started more than 6 hours earlier was returned';
    ASSERT NOT ('far-in-window'  = ANY (found)), '5: event outside the radius was returned';
    ASSERT NOT ('other-org-near' = ANY (found)), '6: another organisation''s event was returned';

    RAISE NOTICE 'PASS: events_near (6 checks)';
END $$;

ROLLBACK;
