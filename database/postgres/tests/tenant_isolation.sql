-- Cross-tenant checks for the app role (report evaluation: zero unauthorised access).
-- Self-contained: creates two test organisations, runs every check as rainready_app,
-- then ROLLBACK leaves the database exactly as it was.
--   docker compose exec db psql -U rainready_admin -d rainready -f /tests/tenant_isolation.sql
-- Success = the final line "PASS: tenant isolation (6 checks)". Any failure stops with an error.
\set ON_ERROR_STOP on
BEGIN;

INSERT INTO organizations (id, name, created_at) VALUES
    ('test-org-a', 'Test Org A', now()),
    ('test-org-b', 'Test Org B', now());
INSERT INTO events (id, organization_id, name, venue, latitude, longitude,
                    event_date, event_time, event_type, sensitivity, created_at, updated_at) VALUES
    ('test-event-a', 'test-org-a', 'A: field games', 'UTown Green', 1.3050, 103.7735,
     current_date + 1, '16:00', 'sports', 'high', now(), now()),
    ('test-event-b', 'test-org-b', 'B: time trial', 'SRC track', 1.2995, 103.7766,
     current_date + 1, '18:00', 'running', 'medium', now(), now());

SET LOCAL ROLE rainready_app;
SELECT set_config('app.organization_id', 'test-org-a', true);

DO $$
DECLARE
    n integer;
BEGIN
    -- 1. Only the own organisation's event is visible
    SELECT count(*) INTO n FROM events WHERE id LIKE 'test-event-%';
    ASSERT n = 1, format('1: expected 1 visible test event, saw %s', n);

    -- 2. Updating another organisation's event changes nothing
    UPDATE events SET name = 'hijacked' WHERE id = 'test-event-b';
    GET DIAGNOSTICS n = ROW_COUNT;
    ASSERT n = 0, '2: cross-tenant update changed a row';

    -- 3. Deleting another organisation's event deletes nothing
    DELETE FROM events WHERE id = 'test-event-b';
    GET DIAGNOSTICS n = ROW_COUNT;
    ASSERT n = 0, '3: cross-tenant delete removed a row';

    -- 4. Inserting a row for another organisation is refused
    BEGIN
        INSERT INTO events (id, organization_id, name, venue, latitude, longitude,
                            event_date, event_time, event_type, sensitivity, created_at, updated_at)
        VALUES ('planted', 'test-org-b', 'planted', 'x', 1.30, 103.77,
                current_date, '09:00', 'x', 'low', now(), now());
        RAISE EXCEPTION '4: cross-tenant insert was allowed';
    EXCEPTION WHEN insufficient_privilege THEN NULL;   -- "violates row-level security policy"
    END;

    -- 5. A decision cannot point at another organisation's event
    BEGIN
        INSERT INTO event_decisions (id, organization_id, event_id, action, reason, label, decided_at)
        VALUES ('test-dec-x', 'test-org-a', 'test-event-b', 'cancel', 'x', 'x', now());
        RAISE EXCEPTION '5: decision on another tenant''s event was allowed';
    EXCEPTION WHEN foreign_key_violation OR insufficient_privilege THEN NULL;
    END;

    -- 6. With no organisation set, nothing is visible
    PERFORM set_config('app.organization_id', '', true);
    SELECT count(*) INTO n FROM events;
    ASSERT n = 0, format('6: expected 0 events without an organisation, saw %s', n);

    RAISE NOTICE 'PASS: tenant isolation (6 checks)';
END $$;

ROLLBACK;
