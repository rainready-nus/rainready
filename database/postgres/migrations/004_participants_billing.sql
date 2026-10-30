-- Migration 004: participant join links, consented participant emails, participant
-- notifications (one per confirmed relocate/postpone/cancel decision) and billing records.
--
-- New databases already get this from init/. Run once on a database created earlier, after 003.
--   Local Docker:  docker compose exec db psql -U rainready_admin -d rainready -f /migrations/004_participants_billing.sql
--   RDS:           psql -f migrations/004_participants_billing.sql
-- Safe to run more than once: if the tables already exist (for example on a database created
-- from the current init/ files), it says so and changes nothing.
\set ON_ERROR_STOP on
SELECT to_regclass('public.event_join_links') IS NOT NULL AS already_applied \gset
\if :already_applied
\echo 'Migration 004 is already applied (participants, notifications and billing tables exist). Nothing to do.'
\q
\endif
BEGIN;

-- ---------------------------------------------------------------------------
-- Participant notifications and billing.
-- Participant emails are stored only after consent on the event's join link (or synthetic
-- @example.com addresses added by developer demo tools). Emails go out only after an
-- organiser confirms a relocate, postpone or cancel decision: one notification per decision.
-- ---------------------------------------------------------------------------
CREATE TABLE event_join_links (
    event_id         text PRIMARY KEY,
    organization_id  text NOT NULL,
    token            text NOT NULL UNIQUE,
    created_at       timestamptz NOT NULL,
    FOREIGN KEY (organization_id, event_id) REFERENCES events (organization_id, id)
        ON UPDATE CASCADE ON DELETE CASCADE
);

CREATE TABLE event_participants (
    id                 text PRIMARY KEY,
    organization_id    text NOT NULL,
    event_id           text NOT NULL,
    email              citext NOT NULL CHECK (length(email) <= 254),
    name               text NOT NULL DEFAULT '' CHECK (length(name) <= 80),
    consent_source     text NOT NULL CHECK (consent_source IN ('join_link', 'demo')),
    consent_text       text NOT NULL,
    consented_at       timestamptz NOT NULL,
    unsubscribe_token  text NOT NULL UNIQUE,
    unsubscribed_at    timestamptz,
    created_at         timestamptz NOT NULL,
    UNIQUE (event_id, email),
    UNIQUE (organization_id, id),
    FOREIGN KEY (organization_id, event_id) REFERENCES events (organization_id, id)
        ON UPDATE CASCADE ON DELETE CASCADE
);
CREATE INDEX idx_event_participants_org_event ON event_participants (organization_id, event_id);

CREATE TABLE participant_notifications (
    id                  text PRIMARY KEY,
    organization_id     text NOT NULL,
    event_id            text NOT NULL,
    decision_id         text NOT NULL UNIQUE,          -- one notification per decision: no duplicates
    action              text NOT NULL CHECK (action IN ('relocate', 'postpone', 'cancel')),
    subject             text NOT NULL,
    body                text NOT NULL,
    mailer              text NOT NULL CHECK (mailer IN ('outbox', 'ses')),
    recipient_count     integer NOT NULL CHECK (recipient_count >= 0),
    sent_count          integer NOT NULL DEFAULT 0 CHECK (sent_count >= 0),
    failed_count        integer NOT NULL DEFAULT 0 CHECK (failed_count >= 0),
    created_by_user_id  text,
    created_at          timestamptz NOT NULL,
    completed_at        timestamptz,
    UNIQUE (organization_id, id),
    FOREIGN KEY (organization_id, decision_id) REFERENCES event_decisions (organization_id, id)
        ON UPDATE CASCADE ON DELETE CASCADE,
    FOREIGN KEY (organization_id, event_id) REFERENCES events (organization_id, id)
        ON UPDATE CASCADE ON DELETE CASCADE
);
CREATE INDEX idx_participant_notifications_org ON participant_notifications (organization_id, created_at DESC);

CREATE TABLE notification_deliveries (
    id                   text PRIMARY KEY,
    notification_id      text NOT NULL,
    organization_id      text NOT NULL,
    participant_id       text,                         -- no FK: the record stays if the participant is removed
    email                citext NOT NULL,
    unsubscribe_token    text NOT NULL,
    status               text NOT NULL CHECK (status IN ('pending', 'sent', 'failed')),
    provider_message_id  text,
    error                text,
    sent_at              timestamptz,
    created_at           timestamptz NOT NULL,
    UNIQUE (notification_id, email),
    FOREIGN KEY (organization_id, notification_id) REFERENCES participant_notifications (organization_id, id)
        ON UPDATE CASCADE ON DELETE CASCADE
);
CREATE INDEX idx_notification_deliveries_org ON notification_deliveries (organization_id, created_at DESC);

-- Billing is per organisation and written by the payment webhook, which has no organisation
-- context yet, so these two tables are not under row-level security (like organizations).
CREATE TABLE billing_subscriptions (
    organization_id      text PRIMARY KEY REFERENCES organizations(id) ON DELETE CASCADE,
    provider             text NOT NULL CHECK (provider IN ('stripe', 'developer')),
    plan                 text NOT NULL CHECK (plan IN ('free', 'community', 'enterprise')),
    status               text NOT NULL,
    customer_id          text,
    subscription_id      text UNIQUE,
    checkout_session_id  text,
    updated_at           timestamptz NOT NULL
);

CREATE TABLE billing_webhook_events (
    id           text PRIMARY KEY,                     -- payment provider's event id: each is applied once
    type         text NOT NULL,
    received_at  timestamptz NOT NULL
);

-- Public pages (join link, unsubscribe link) know only a token, not the organisation, so
-- row-level security would hide the row. These two functions return the minimum needed,
-- for one exact token, and run with owner rights.
CREATE FUNCTION join_link_target(p_token text)
RETURNS TABLE (organization_id text, event_id text, name text, event_date date, event_time time, venue text)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
    SELECT e.organization_id, e.id, e.name, e.event_date, e.event_time, e.venue
      FROM event_join_links l
      JOIN events e ON e.id = l.event_id AND e.organization_id = l.organization_id
     WHERE l.token = p_token AND length(p_token) >= 20;
$$;

CREATE FUNCTION unsubscribe_target(p_token text)
RETURNS TABLE (organization_id text, participant_id text, email text, event_name text, unsubscribed boolean)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
    SELECT p.organization_id, p.id, p.email::text, e.name, p.unsubscribed_at IS NOT NULL
      FROM event_participants p
      JOIN events e ON e.id = p.event_id AND e.organization_id = p.organization_id
     WHERE p.unsubscribe_token = p_token AND length(p_token) >= 20;
$$;

-- Participant notifications: row-level security per organisation, like events.
DO $$
DECLARE
    t text;
BEGIN
    FOREACH t IN ARRAY ARRAY['event_join_links', 'event_participants', 'participant_notifications', 'notification_deliveries']
    LOOP
        EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
        EXECUTE format($p$CREATE POLICY tenant_isolation ON %I TO rainready_app
                         USING (organization_id = app_current_organization())
                         WITH CHECK (organization_id = app_current_organization())$p$, t);
    END LOOP;
END $$;
GRANT SELECT, INSERT, UPDATE         ON event_join_links          TO rainready_app;  -- update: new link
GRANT SELECT, INSERT, UPDATE, DELETE ON event_participants        TO rainready_app;  -- delete: remove a participant
GRANT SELECT, INSERT, UPDATE         ON participant_notifications,
                                        notification_deliveries   TO rainready_app;  -- update: delivery status, counts
GRANT SELECT, INSERT, UPDATE         ON billing_subscriptions     TO rainready_app;
GRANT SELECT, INSERT                 ON billing_webhook_events    TO rainready_app;
REVOKE ALL ON FUNCTION join_link_target(text), unsubscribe_target(text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION join_link_target(text), unsubscribe_target(text) TO rainready_app;

COMMIT;
\echo 'Migration 004 applied: participants, notifications and billing tables created.'
