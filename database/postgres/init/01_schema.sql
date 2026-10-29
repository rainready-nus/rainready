-- RainReady PostgreSQL schema (PostgreSQL 16 + PostGIS)
--
-- Part 1 mirrors backend/event-store.mjs (the SQLite schema) table for table and column for
-- column, so the existing store logic and the export script map one-to-one.
-- Part 2 adds what the preliminary report needs beyond the current prototype: stored
-- assessments, organiser-confirmed lightning alerts, data-source freshness and an audit log.
--
-- Differences from SQLite, all deliberate:
--   * timestamps are timestamptz, event_date is date, event_time is time (SGT wall clock)
--   * event_decisions and notification_previews carry organization_id, so row-level
--     security can scope them without joins (the export script fills it from the event)
--   * decisions, previews, assessments, alerts and audit rows are append-only
--   * events get a PostGIS location column computed from latitude/longitude
-- Runs once on first container start, as rainready_admin.

CREATE EXTENSION IF NOT EXISTS postgis;
CREATE EXTENSION IF NOT EXISTS citext;

-- ===========================================================================
-- Part 1 - existing prototype model (event-store.mjs)
-- ===========================================================================

CREATE TABLE organizations (
    id          text PRIMARY KEY,
    name        text NOT NULL,
    created_at  timestamptz NOT NULL,
    plan        text NOT NULL DEFAULT 'free' CHECK (plan IN ('free', 'community', 'enterprise'))  -- free shows sponsored messages
);
INSERT INTO organizations (id, name, created_at)
VALUES ('legacy', 'Imported legacy events', '1970-01-01T00:00:00Z');

CREATE TABLE users (
    id             text PRIMARY KEY,
    email          citext NOT NULL UNIQUE,          -- SQLite: COLLATE NOCASE
    password_hash  text NOT NULL,                   -- scrypt$salt$hash from auth.mjs
    created_at     timestamptz NOT NULL
);

CREATE TABLE organization_memberships (
    user_id          text NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    organization_id  text NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
    role             text NOT NULL CHECK (role IN ('owner', 'member')),
    created_at       timestamptz NOT NULL,
    PRIMARY KEY (user_id, organization_id)
);
CREATE INDEX idx_memberships_organization ON organization_memberships (organization_id, user_id);

CREATE TABLE auth_sessions (
    token_hash  text PRIMARY KEY,                   -- SHA-256 of the cookie token
    user_id     text NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    expires_at  timestamptz NOT NULL,
    created_at  timestamptz NOT NULL
);
CREATE INDEX idx_auth_sessions_expiry ON auth_sessions (expires_at);
CREATE INDEX idx_auth_sessions_user   ON auth_sessions (user_id);

CREATE TABLE auth_rate_limits (
    key_hash           text PRIMARY KEY,
    window_started_at  bigint NOT NULL,             -- epoch milliseconds, as in SQLite
    attempts           integer NOT NULL,
    blocked_until      bigint NOT NULL
);

CREATE TABLE organization_invitations (
    token_hash          text PRIMARY KEY,
    organization_id     text NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
    created_by_user_id  text NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    expires_at          timestamptz NOT NULL,
    used_at             timestamptz,
    created_at          timestamptz NOT NULL
);

CREATE TABLE events (
    id                      text PRIMARY KEY,
    organization_id         text NOT NULL DEFAULT 'legacy' REFERENCES organizations(id),
    name                    text NOT NULL,
    venue                   text NOT NULL,
    venue_address           text NOT NULL DEFAULT '',
    latitude                double precision NOT NULL CHECK (latitude  BETWEEN -90  AND 90),
    longitude               double precision NOT NULL CHECK (longitude BETWEEN -180 AND 180),
    backup_venue_name       text,
    backup_venue_address    text,
    backup_venue_latitude   double precision CHECK (backup_venue_latitude  BETWEEN -90  AND 90),
    backup_venue_longitude  double precision CHECK (backup_venue_longitude BETWEEN -180 AND 180),
    participant_count       integer NOT NULL DEFAULT 0 CHECK (participant_count >= 0),  -- count only, no contact data
    event_date              date NOT NULL,
    event_time              time NOT NULL,          -- SGT wall-clock time, as entered
    event_type              text NOT NULL,
    sensitivity             text NOT NULL CHECK (sensitivity IN ('low', 'medium', 'high')),
    created_at              timestamptz NOT NULL,
    updated_at              timestamptz NOT NULL,
    -- New: lets the database find events near an observation (ST_DWithin)
    location                geography(Point, 4326)
                            GENERATED ALWAYS AS (ST_SetSRID(ST_MakePoint(longitude, latitude), 4326)::geography) STORED,
    CHECK ((backup_venue_latitude IS NULL) = (backup_venue_longitude IS NULL)),
    UNIQUE (organization_id, id)                    -- target of the tenant-safe composite foreign keys
);
CREATE INDEX idx_events_organization_created ON events (organization_id, created_at);
CREATE INDEX idx_events_location            ON events USING gist (location);
CREATE INDEX idx_events_date                ON events (event_date);

CREATE TABLE event_decisions (
    id                  text PRIMARY KEY,
    organization_id     text NOT NULL,              -- new: copied from the event
    event_id            text NOT NULL,
    action              text NOT NULL CHECK (action IN ('continue', 'prepare', 'relocate', 'postpone', 'cancel')),
    reason              text NOT NULL,
    label               text NOT NULL,
    decided_at          timestamptz NOT NULL,
    decided_by_user_id  text,                       -- new, optional; no FK so removing a member keeps history
    assessment_id       text,                       -- new, optional link to risk_assessments.id
    UNIQUE (organization_id, id),
    FOREIGN KEY (organization_id, event_id) REFERENCES events (organization_id, id)
        ON UPDATE CASCADE ON DELETE CASCADE
);
CREATE INDEX idx_event_decisions_event_id ON event_decisions (event_id, decided_at);

CREATE TABLE notification_previews (
    decision_id               text PRIMARY KEY,
    organization_id           text NOT NULL,        -- new: copied from the event
    mode                      text NOT NULL CHECK (mode = 'test'),
    status                    text NOT NULL CHECK (status = 'not_sent'),
    generated_at              timestamptz NOT NULL,
    intended_recipient_count  integer NOT NULL CHECK (intended_recipient_count >= 0),
    title                     text NOT NULL,
    message                   text NOT NULL,
    FOREIGN KEY (organization_id, decision_id) REFERENCES event_decisions (organization_id, id)
        ON UPDATE CASCADE ON DELETE CASCADE
);

CREATE TABLE legacy_imports (
    source_path     text PRIMARY KEY,
    imported_at     timestamptz NOT NULL,
    imported_count  integer NOT NULL
);

-- Event start as an absolute time (the app stores SGT date + time separately).
-- security_invoker makes the view obey the caller's row-level security.
CREATE VIEW events_with_start WITH (security_invoker = true) AS
SELECT e.*, (e.event_date + e.event_time) AT TIME ZONE 'Asia/Singapore' AS starts_at
FROM events e;

-- ===========================================================================
-- Part 2 - additions from the report
-- ===========================================================================

-- Data sources, keyed like DATA_ENDPOINTS in backend/weather-data.mjs
CREATE TABLE data_sources (
    code               text PRIMARY KEY,
    name               text NOT NULL,
    endpoint           text NOT NULL,
    published_cadence  text NOT NULL,
    freshness_limit    interval NOT NULL,           -- matches FRESHNESS_LIMITS_MS
    used_for           text NOT NULL
);

-- Every retrieval: source time AND retrieval time (docs/data-sources.md polling policy)
CREATE TABLE weather_snapshots (
    id                bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    source_code       text NOT NULL REFERENCES data_sources(code),
    source_timestamp  timestamptz,                  -- publisher's observation/update time
    retrieved_at      timestamptz NOT NULL DEFAULT now(),
    ok                boolean NOT NULL,
    error             text,
    payload           jsonb,                        -- normalised response, no secrets
    CHECK (ok OR error IS NOT NULL)
);
CREATE UNIQUE INDEX uq_weather_snapshots_source_time
    ON weather_snapshots (source_code, source_timestamp) WHERE ok;
CREATE INDEX idx_weather_snapshots_recent ON weather_snapshots (source_code, retrieved_at DESC);

-- Freshness per source, using the same Current / Stale / Unavailable idea as the app
CREATE VIEW source_freshness AS
SELECT ds.code,
       ds.name,
       ds.freshness_limit,
       last_ok.source_timestamp,
       last_ok.retrieved_at                                   AS last_success_at,
       last_try.retrieved_at                                  AS last_attempt_at,
       last_try.ok                                            AS last_attempt_ok,
       CASE
           WHEN last_ok.source_timestamp IS NULL THEN 'unavailable'
           WHEN now() - last_ok.source_timestamp > ds.freshness_limit THEN 'stale'
           WHEN last_try.ok IS FALSE THEN 'stale'             -- serving last-known-good after a failure
           ELSE 'current'
       END                                                    AS freshness_status
FROM data_sources ds
LEFT JOIN LATERAL (
    SELECT source_timestamp, retrieved_at FROM weather_snapshots w
    WHERE w.source_code = ds.code AND w.ok ORDER BY w.source_timestamp DESC NULLS LAST LIMIT 1
) last_ok ON true
LEFT JOIN LATERAL (
    SELECT ok, retrieved_at FROM weather_snapshots w
    WHERE w.source_code = ds.code ORDER BY w.retrieved_at DESC LIMIT 1
) last_try ON true;

-- Stored output of buildRiskAssessment() for an event (decision evidence)
CREATE TABLE risk_assessments (
    id                  text PRIMARY KEY DEFAULT gen_random_uuid()::text,
    organization_id     text NOT NULL,
    event_id            text NOT NULL,
    assessed_at         timestamptz NOT NULL DEFAULT now(),
    status              text NOT NULL CHECK (status IN ('current', 'partial', 'stale', 'unavailable', 'override')),
    score               smallint CHECK (score BETWEEN 0 AND 100),
    risk_level          text NOT NULL CHECK (risk_level IN ('low', 'medium', 'high', 'critical', 'unavailable')),
    recommended_action  text NOT NULL,
    lightning_override  boolean NOT NULL DEFAULT false,
    air_quality_level   text,                       -- good, moderate, unhealthy, ... or unavailable
    rules_version       text NOT NULL DEFAULT 'prototype-0.5.0',
    assessment          jsonb NOT NULL,             -- the full JSON returned by /api/assessment
    UNIQUE (organization_id, id),
    FOREIGN KEY (organization_id, event_id) REFERENCES events (organization_id, id)
        ON UPDATE CASCADE ON DELETE CASCADE,
    -- Same bands as bandFor() in backend/risk-engine.mjs
    CHECK (
        (status = 'unavailable' AND score IS NULL AND risk_level = 'unavailable')
     OR (status = 'override' AND lightning_override AND risk_level = 'critical')
     OR (status IN ('current', 'partial', 'stale') AND score IS NOT NULL AND NOT lightning_override
         AND risk_level = CASE WHEN score >= 75 THEN 'critical'
                               WHEN score >= 55 THEN 'high'
                               WHEN score >= 30 THEN 'medium'
                               ELSE 'low' END)
    )
);
CREATE INDEX idx_risk_assessments_event ON risk_assessments (event_id, assessed_at DESC);

-- Organiser-confirmed lightning alert / all-clear (the app's lightningStatus=confirmed_alert).
-- Never inferred from the NEA observation feed.
CREATE TABLE lightning_alerts (
    id                    text PRIMARY KEY DEFAULT gen_random_uuid()::text,
    organization_id       text NOT NULL,
    event_id              text NOT NULL,
    status                text NOT NULL CHECK (status IN ('confirmed_alert', 'all_clear')),
    source                text NOT NULL DEFAULT 'organiser-confirmed demo alert',
    confirmed_by_user_id  text,
    confirmed_at          timestamptz NOT NULL DEFAULT clock_timestamp(),
    note                  text,
    FOREIGN KEY (organization_id, event_id) REFERENCES events (organization_id, id)
        ON UPDATE CASCADE ON DELETE CASCADE
);
CREATE INDEX idx_lightning_alerts_event ON lightning_alerts (event_id, confirmed_at DESC);

CREATE TABLE audit_log (
    id               bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    organization_id  text,
    actor            text NOT NULL,
    action           text NOT NULL,
    entity           text NOT NULL,
    entity_id        text NOT NULL,
    at               timestamptz NOT NULL DEFAULT clock_timestamp(),
    detail           jsonb NOT NULL DEFAULT '{}'::jsonb
);
CREATE INDEX idx_audit_log_org ON audit_log (organization_id, at DESC);

-- ===========================================================================
-- Rules enforced by the database
-- ===========================================================================

-- Append-only records. Updates and deletes are refused, except when PostgreSQL itself
-- cascades them from a parent row: deleting an event (the app's DELETE /api/events/:id)
-- or moving legacy events to the first workspace (claim_legacy_events below).
CREATE FUNCTION forbid_change() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
    IF pg_trigger_depth() > 1 THEN
        IF TG_OP = 'DELETE' THEN
            RETURN OLD;
        END IF;
        IF TG_OP = 'UPDATE'
           AND (to_jsonb(NEW) - 'organization_id') = (to_jsonb(OLD) - 'organization_id') THEN
            RETURN NEW;
        END IF;
    END IF;
    RAISE EXCEPTION '% is append-only: % is not allowed', TG_TABLE_NAME, TG_OP
        USING ERRCODE = 'insufficient_privilege';
END $$;

CREATE TRIGGER event_decisions_append_only       BEFORE UPDATE OR DELETE ON event_decisions       FOR EACH ROW EXECUTE FUNCTION forbid_change();
CREATE TRIGGER notification_previews_append_only BEFORE UPDATE OR DELETE ON notification_previews FOR EACH ROW EXECUTE FUNCTION forbid_change();
CREATE TRIGGER risk_assessments_append_only      BEFORE UPDATE OR DELETE ON risk_assessments      FOR EACH ROW EXECUTE FUNCTION forbid_change();
CREATE TRIGGER lightning_alerts_append_only      BEFORE UPDATE OR DELETE ON lightning_alerts      FOR EACH ROW EXECUTE FUNCTION forbid_change();
CREATE TRIGGER audit_log_append_only             BEFORE UPDATE OR DELETE ON audit_log             FOR EACH ROW EXECUTE FUNCTION forbid_change();

-- A decision must belong to the same organisation as its event (the composite FK already
-- guarantees this; this trigger gives a clearer message) and cannot be "continue" while an
-- organiser-confirmed lightning alert is in force. The system never resumes by itself:
-- someone must record an all_clear first, then a new decision.
CREATE FUNCTION enforce_lightning_hold() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
    latest text;
BEGIN
    SELECT status INTO latest
      FROM lightning_alerts
     WHERE event_id = NEW.event_id AND organization_id = NEW.organization_id
     ORDER BY confirmed_at DESC, id DESC
     LIMIT 1;

    IF latest = 'confirmed_alert' AND NEW.action = 'continue' THEN
        RAISE EXCEPTION 'Event % has a confirmed lightning alert: record an all-clear before choosing continue', NEW.event_id
            USING ERRCODE = 'check_violation';
    END IF;
    RETURN NEW;
END $$;

CREATE TRIGGER event_decisions_lightning_hold BEFORE INSERT ON event_decisions
    FOR EACH ROW EXECUTE FUNCTION enforce_lightning_hold();

-- Audit trail. Actor = the decision's user if given, else app.actor, else the DB role.
CREATE FUNCTION audit_row() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
    rec   jsonb := CASE WHEN TG_OP = 'DELETE' THEN to_jsonb(OLD) ELSE to_jsonb(NEW) END;
BEGIN
    INSERT INTO audit_log (organization_id, actor, action, entity, entity_id, detail)
    VALUES (rec->>'organization_id',
            coalesce(rec->>'decided_by_user_id', rec->>'confirmed_by_user_id',
                     NULLIF(current_setting('app.actor', true), ''), current_user),
            lower(TG_OP), TG_TABLE_NAME, coalesce(rec->>'id', rec->>'decision_id'),
            rec - 'location');
    RETURN NULL;
END $$;

CREATE TRIGGER event_decisions_audit  AFTER INSERT ON event_decisions  FOR EACH ROW EXECUTE FUNCTION audit_row();
CREATE TRIGGER lightning_alerts_audit AFTER INSERT ON lightning_alerts FOR EACH ROW EXECUTE FUNCTION audit_row();
CREATE TRIGGER events_audit_delete    AFTER DELETE ON events           FOR EACH ROW EXECUTE FUNCTION audit_row();

-- ===========================================================================
-- Helper functions
-- ===========================================================================

-- Upcoming events within radius_m of a point (e.g. a rainfall station or lightning strike).
-- Both conditions can use an index, so PostgreSQL never has to read every stored event:
--   * location: ST_DWithin on events.location uses the GiST index idx_events_location;
--   * time: the event_date range uses the B-tree index idx_events_date. The exact start-time
--     window is then checked on the few rows that remain (starts_at is calculated per row).
-- Events that started up to 6 hours before p_from are included, so live events are found.
-- Runs with the caller's rights, so row-level security still limits it to one organisation.
CREATE FUNCTION events_near(p_lat double precision, p_lon double precision,
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

-- event-store.mjs createAccount(): the first registered workspace takes ownership of
-- imported legacy events. Row-level security would hide 'legacy' rows from the app role,
-- so this one step runs with owner rights, and only while no user exists yet.
CREATE FUNCTION claim_legacy_events(p_organization_id text) RETURNS integer
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE
    moved integer;
BEGIN
    IF EXISTS (SELECT 1 FROM users) THEN
        RETURN 0;
    END IF;
    UPDATE events SET organization_id = p_organization_id WHERE organization_id = 'legacy';
    GET DIAGNOSTICS moved = ROW_COUNT;
    RETURN moved;
END $$;

-- ---------------------------------------------------------------------------
-- Sponsored messages (Free plan ads). Not organisation data, so no row-level
-- security: the rows hold counts only and never identify who saw an ad.
-- ---------------------------------------------------------------------------
CREATE TABLE ad_daily_stats (
    ad_id        text    NOT NULL CHECK (ad_id ~ '^[a-z0-9][a-z0-9-]{1,47}$'),
    placement    text    NOT NULL CHECK (placement IN ('overview', 'events', 'decisions', 'settings')),
    day          date    NOT NULL,             -- Singapore calendar day
    impressions  integer NOT NULL DEFAULT 0 CHECK (impressions >= 0),
    clicks       integer NOT NULL DEFAULT 0 CHECK (clicks >= 0),
    PRIMARY KEY (ad_id, placement, day)
);
COMMENT ON TABLE ad_daily_stats IS
    'Sponsored-message counters per ad, placement and day. Aggregated only: no user, organisation or event identifiers.';

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
