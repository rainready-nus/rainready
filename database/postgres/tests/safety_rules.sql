-- Safety and record-keeping rules enforced by the database.
-- Self-contained; ROLLBACK at the end leaves no data behind.
--   docker compose exec db psql -U rainready_admin -d rainready -f /tests/safety_rules.sql
-- Success = the final line "PASS: safety rules (7 checks)".
\set ON_ERROR_STOP on
BEGIN;

INSERT INTO organizations (id, name, created_at) VALUES ('test-org-s', 'Safety Test Org', now());
INSERT INTO events (id, organization_id, name, venue, latitude, longitude,
                    event_date, event_time, event_type, sensitivity, created_at, updated_at)
VALUES ('test-event-s', 'test-org-s', 'Orientation games', 'UTown Green', 1.3050, 103.7735,
        current_date + 1, '16:00', 'sports', 'high', now(), now());

SET LOCAL ROLE rainready_app;
SELECT set_config('app.organization_id', 'test-org-s', true);
SELECT set_config('app.actor', 'test-runner', true);

DO $$
DECLARE
    n integer;
BEGIN
    -- 1. Under an organiser-confirmed lightning alert, "continue" is refused ...
    INSERT INTO lightning_alerts (organization_id, event_id, status)
    VALUES ('test-org-s', 'test-event-s', 'confirmed_alert');
    BEGIN
        INSERT INTO event_decisions (id, organization_id, event_id, action, reason, label, decided_at)
        VALUES ('test-dec-1', 'test-org-s', 'test-event-s', 'continue', 'looks fine', 'Continue as planned', now());
        RAISE EXCEPTION '1: continue was accepted during a confirmed lightning alert';
    EXCEPTION WHEN check_violation THEN NULL;
    END;

    -- 2. ... while a protective decision is accepted
    INSERT INTO event_decisions (id, organization_id, event_id, action, reason, label, decided_at)
    VALUES ('test-dec-2', 'test-org-s', 'test-event-s', 'postpone', 'lightning nearby', 'Postpone the event', now());

    -- 3. After someone records the all-clear, continue is possible again (never automatic)
    INSERT INTO lightning_alerts (organization_id, event_id, status)
    VALUES ('test-org-s', 'test-event-s', 'all_clear');
    INSERT INTO event_decisions (id, organization_id, event_id, action, reason, label, decided_at)
    VALUES ('test-dec-3', 'test-org-s', 'test-event-s', 'continue', 'all-clear confirmed', 'Continue as planned', now());

    -- 4. Decisions cannot be edited by the app (no UPDATE grant) ...
    BEGIN
        UPDATE event_decisions SET reason = 'rewritten' WHERE id = 'test-dec-2';
        RAISE EXCEPTION '4: the app role could edit a decision';
    EXCEPTION WHEN insufficient_privilege THEN NULL;
    END;

    -- 5. Risk bands must match risk-engine.mjs (score 80 is critical, not low)
    BEGIN
        INSERT INTO risk_assessments (organization_id, event_id, status, score, risk_level,
                                      recommended_action, assessment)
        VALUES ('test-org-s', 'test-event-s', 'current', 80, 'low', 'continue_and_monitor', '{}');
        RAISE EXCEPTION '5: an inconsistent risk band was stored';
    EXCEPTION WHEN check_violation THEN NULL;
    END;
    INSERT INTO risk_assessments (organization_id, event_id, status, score, risk_level,
                                  recommended_action, assessment)
    VALUES ('test-org-s', 'test-event-s', 'current', 80, 'critical', 'review_cancel_or_relocate', '{}');

    -- 6. Decisions and alerts were written to the audit log
    SELECT count(*) INTO n FROM audit_log WHERE organization_id = 'test-org-s';
    ASSERT n = 4, format('6: expected 4 audit rows (2 decisions + 2 alerts), saw %s', n);

    RAISE NOTICE 'safety checks 1-6 passed';
END $$;

-- 7. Even the owner role cannot rewrite history, but deleting the event still works
RESET ROLE;
DO $$
DECLARE
    n integer;
BEGIN
    BEGIN
        UPDATE event_decisions SET reason = 'rewritten' WHERE id = 'test-dec-2';
        RAISE EXCEPTION '7a: the admin role could edit a decision';
    EXCEPTION WHEN insufficient_privilege THEN NULL;   -- append-only trigger
    END;

    DELETE FROM events WHERE id = 'test-event-s';      -- cascades to decisions, alerts, assessments
    SELECT count(*) INTO n FROM event_decisions WHERE event_id = 'test-event-s';
    ASSERT n = 0, '7b: decisions were not removed with their event';
    SELECT count(*) INTO n FROM audit_log WHERE entity = 'events' AND entity_id = 'test-event-s' AND action = 'delete';
    ASSERT n = 1, '7c: the event deletion was not audited';

    RAISE NOTICE 'PASS: safety rules (7 checks)';
END $$;

ROLLBACK;
