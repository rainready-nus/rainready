-- Tenant isolation and least-privilege grants for rainready_app.
--
-- The backend already checks X-RainReady-Organization against the user's membership.
-- With PostgreSQL it should also tell the database which organisation the request is for,
-- once per transaction:
--     BEGIN;
--     SELECT set_config('app.organization_id', $1, true);   -- $1 = verified organisation id
--     SELECT set_config('app.actor', $2, true);             -- $2 = user id, for the audit log
--     ...queries...
--     COMMIT;
-- Row-level security then hides and blocks every other organisation's rows, even if a
-- query forgets its "AND organization_id = ?" filter.
--
-- Auth tables (users, sessions, memberships, invitations, rate limits) are not row-level
-- scoped: sign-in has to look a user up before any organisation is known, as in SQLite.

CREATE FUNCTION app_current_organization() RETURNS text
LANGUAGE sql STABLE AS $$
    SELECT NULLIF(current_setting('app.organization_id', true), '')
$$;

DO $$
DECLARE
    t text;
BEGIN
    FOREACH t IN ARRAY ARRAY['events', 'event_decisions', 'notification_previews',
                             'risk_assessments', 'lightning_alerts', 'audit_log']
    LOOP
        EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
        EXECUTE format($p$CREATE POLICY tenant_isolation ON %I TO rainready_app
                         USING (organization_id = app_current_organization())
                         WITH CHECK (organization_id = app_current_organization())$p$, t);
    END LOOP;
END $$;

-- ---------------------------------------------------------------------------
-- Grants (only what event-store.mjs actually does)
-- ---------------------------------------------------------------------------
GRANT USAGE ON SCHEMA public TO rainready_app;

GRANT SELECT, INSERT                 ON organizations            TO rainready_app;
GRANT SELECT, INSERT, DELETE         ON users                    TO rainready_app;  -- delete: removeOrganizationMember
GRANT SELECT, INSERT, DELETE         ON organization_memberships TO rainready_app;
GRANT SELECT, INSERT, DELETE         ON auth_sessions            TO rainready_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON auth_rate_limits         TO rainready_app;
GRANT SELECT, INSERT, UPDATE         ON organization_invitations TO rainready_app;  -- update: used_at
GRANT SELECT, INSERT                 ON legacy_imports           TO rainready_app;

GRANT SELECT, INSERT, UPDATE, DELETE ON events                   TO rainready_app;
GRANT SELECT, INSERT                 ON event_decisions,
                                        notification_previews,
                                        risk_assessments,
                                        lightning_alerts,
                                        audit_log                TO rainready_app;  -- no UPDATE/DELETE: append-only

GRANT SELECT                         ON data_sources             TO rainready_app;
GRANT SELECT, INSERT                 ON weather_snapshots        TO rainready_app;
GRANT SELECT ON events_with_start, source_freshness              TO rainready_app;
GRANT USAGE  ON ALL SEQUENCES IN SCHEMA public                   TO rainready_app;

REVOKE ALL ON FUNCTION claim_legacy_events(text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION claim_legacy_events(text)              TO rainready_app;
GRANT EXECUTE ON FUNCTION events_near(double precision, double precision, double precision, timestamptz, interval) TO rainready_app;
GRANT EXECUTE ON FUNCTION app_current_organization()             TO rainready_app;
