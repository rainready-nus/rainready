/**
 * Participants (join links, consent, unsubscribe), participant email notifications and billing
 * records for the SQLite store. Created by createEventStore() and exposed as
 * `store.participants`, `store.notifications` and `store.billing`. The PostgreSQL store
 * (notification-store-pg.mjs) has the same methods.
 *
 * Participant emails are personal data: they are only stored after the participant ticks the
 * consent box on the event's join link (or, for developer demos, synthetic @example.com
 * addresses). Every email carries an unsubscribe link; removing a participant deletes the row.
 */
import { randomUUID } from "node:crypto";

/** Most participants one event can have; the join link refuses more. */
export const MAX_PARTICIPANTS_PER_EVENT = 500;
/** A second relocate/postpone/cancel email for the same event within this time is treated as a double submit. */
export const DUPLICATE_WINDOW_MS = 2 * 60 * 1000;

export function createNotificationSchema(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS event_join_links (
      event_id TEXT PRIMARY KEY REFERENCES events(id) ON DELETE CASCADE,
      organization_id TEXT NOT NULL,
      token TEXT NOT NULL UNIQUE,
      created_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS event_participants (
      id TEXT PRIMARY KEY,
      organization_id TEXT NOT NULL,
      event_id TEXT NOT NULL REFERENCES events(id) ON DELETE CASCADE,
      email TEXT NOT NULL,
      name TEXT NOT NULL DEFAULT '',
      consent_source TEXT NOT NULL CHECK (consent_source IN ('join_link', 'demo')),
      consent_text TEXT NOT NULL,
      consented_at TEXT NOT NULL,
      unsubscribe_token TEXT NOT NULL UNIQUE,
      unsubscribed_at TEXT,
      created_at TEXT NOT NULL,
      UNIQUE (event_id, email)
    );
    CREATE INDEX IF NOT EXISTS idx_event_participants_org_event ON event_participants(organization_id, event_id);
    CREATE TABLE IF NOT EXISTS participant_notifications (
      id TEXT PRIMARY KEY,
      organization_id TEXT NOT NULL,
      event_id TEXT NOT NULL REFERENCES events(id) ON DELETE CASCADE,
      decision_id TEXT NOT NULL UNIQUE,
      action TEXT NOT NULL CHECK (action IN ('relocate', 'postpone', 'cancel')),
      subject TEXT NOT NULL,
      body TEXT NOT NULL,
      mailer TEXT NOT NULL,
      recipient_count INTEGER NOT NULL CHECK (recipient_count >= 0),
      sent_count INTEGER NOT NULL DEFAULT 0,
      failed_count INTEGER NOT NULL DEFAULT 0,
      created_by_user_id TEXT,
      created_at TEXT NOT NULL,
      completed_at TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_participant_notifications_org ON participant_notifications(organization_id, created_at);
    CREATE TABLE IF NOT EXISTS notification_deliveries (
      id TEXT PRIMARY KEY,
      notification_id TEXT NOT NULL REFERENCES participant_notifications(id) ON DELETE CASCADE,
      organization_id TEXT NOT NULL,
      participant_id TEXT,
      email TEXT NOT NULL,
      unsubscribe_token TEXT NOT NULL,
      status TEXT NOT NULL CHECK (status IN ('pending', 'sent', 'failed')),
      provider_message_id TEXT,
      error TEXT,
      sent_at TEXT,
      created_at TEXT NOT NULL,
      UNIQUE (notification_id, email)
    );
    CREATE TABLE IF NOT EXISTS billing_subscriptions (
      organization_id TEXT PRIMARY KEY REFERENCES organizations(id) ON DELETE CASCADE,
      provider TEXT NOT NULL CHECK (provider IN ('stripe', 'developer')),
      plan TEXT NOT NULL CHECK (plan IN ('free', 'community', 'enterprise')),
      status TEXT NOT NULL,
      customer_id TEXT,
      subscription_id TEXT UNIQUE,
      checkout_session_id TEXT,
      updated_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS billing_webhook_events (
      id TEXT PRIMARY KEY,
      type TEXT NOT NULL,
      received_at TEXT NOT NULL
    );
  `);
}

export const participantFromRow = (row) => row && ({
  id: row.id,
  eventId: row.event_id,
  email: row.email,
  name: row.name,
  consentSource: row.consent_source,
  consentedAt: row.consented_at,
  unsubscribedAt: row.unsubscribed_at ?? null,
  subscribed: !row.unsubscribed_at,
  createdAt: row.created_at,
});

export const notificationFromRow = (row) => row && ({
  id: row.id,
  eventId: row.event_id,
  eventName: row.event_name ?? undefined,
  decisionId: row.decision_id,
  action: row.action,
  subject: row.subject,
  mailer: row.mailer,
  recipientCount: Number(row.recipient_count),
  sentCount: Number(row.sent_count),
  failedCount: Number(row.failed_count),
  createdAt: row.created_at,
  completedAt: row.completed_at ?? null,
});

export const subscriptionFromRow = (row) => row && ({
  organizationId: row.organization_id,
  provider: row.provider,
  plan: row.plan,
  status: row.status,
  customerId: row.customer_id ?? null,
  subscriptionId: row.subscription_id ?? null,
  checkoutSessionId: row.checkout_session_id ?? null,
  updatedAt: row.updated_at,
});

export function createSqliteNotificationStore(db) {
  const tx = (fn) => {
    db.exec("BEGIN IMMEDIATE");
    try {
      const result = fn();
      db.exec("COMMIT");
      return result;
    } catch (error) {
      db.exec("ROLLBACK");
      throw error;
    }
  };
  const eventExists = (organizationId, eventId) =>
    Boolean(db.prepare("SELECT 1 FROM events WHERE id = ? AND organization_id = ?").get(eventId, organizationId));

  const participants = {
    async getJoinLink(organizationId, eventId) {
      const row = db.prepare("SELECT token, created_at FROM event_join_links WHERE event_id = ? AND organization_id = ?").get(eventId, organizationId);
      return row ? { token: row.token, createdAt: row.created_at } : null;
    },
    /** Creates the event's join link, or replaces it (old links stop working). */
    async setJoinLink(organizationId, eventId, token, now) {
      if (!eventExists(organizationId, eventId)) return null;
      db.prepare(`INSERT INTO event_join_links (event_id, organization_id, token, created_at) VALUES (?, ?, ?, ?)
        ON CONFLICT (event_id) DO UPDATE SET token = excluded.token, created_at = excluded.created_at`).run(eventId, organizationId, token, now);
      return { token, createdAt: now };
    },
    /** Public: what a join link shows. Only event name, date, time and venue. */
    async findJoinTarget(token) {
      const row = db.prepare(`SELECT l.organization_id, e.id, e.name, e.event_date, e.event_time, e.venue
        FROM event_join_links l JOIN events e ON e.id = l.event_id AND e.organization_id = l.organization_id
        WHERE l.token = ?`).get(token);
      return row ? { organizationId: row.organization_id, eventId: row.id, name: row.name, date: row.event_date, time: row.event_time, venue: row.venue } : null;
    },
    /**
     * Adds a participant with their consent record. Someone who unsubscribed is NOT re-subscribed
     * through the (shareable) join link: anyone could type their address. They stay unsubscribed;
     * the organiser can remove the record, after which the person can join again.
     */
    async add(organizationId, eventId, { email, name = "", consentSource, consentText, unsubscribeToken, now }) {
      return tx(() => {
        if (!eventExists(organizationId, eventId)) return { error: "event_not_found" };
        const current = db.prepare("SELECT * FROM event_participants WHERE event_id = ? AND email = ?").get(eventId, email);
        if (current) return { status: current.unsubscribed_at ? "unsubscribed_kept" : "already_joined", participant: participantFromRow(current) };
        const count = db.prepare("SELECT count(*) AS n FROM event_participants WHERE event_id = ?").get(eventId).n;
        if (count >= MAX_PARTICIPANTS_PER_EVENT) return { error: "list_full" };
        const id = randomUUID();
        db.prepare(`INSERT INTO event_participants (id, organization_id, event_id, email, name, consent_source, consent_text, consented_at,
            unsubscribe_token, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
          .run(id, organizationId, eventId, email, name, consentSource, consentText, now, unsubscribeToken, now);
        return { status: "joined", participant: participantFromRow(db.prepare("SELECT * FROM event_participants WHERE id = ?").get(id)) };
      });
    },
    async list(organizationId, eventId) {
      return db.prepare(`SELECT * FROM event_participants WHERE organization_id = ? AND event_id = ?
        ORDER BY unsubscribed_at IS NOT NULL, created_at, email`).all(organizationId, eventId).map(participantFromRow);
    },
    async counts(organizationId) {
      const rows = db.prepare(`SELECT event_id, count(*) AS n FROM event_participants
        WHERE organization_id = ? AND unsubscribed_at IS NULL GROUP BY event_id`).all(organizationId);
      return Object.fromEntries(rows.map((row) => [row.event_id, Number(row.n)]));
    },
    /** Active recipients with their unsubscribe tokens (server-side only). */
    async recipients(organizationId, eventId) {
      return db.prepare(`SELECT id, email, unsubscribe_token FROM event_participants
        WHERE organization_id = ? AND event_id = ? AND unsubscribed_at IS NULL ORDER BY created_at, email`).all(organizationId, eventId)
        .map((row) => ({ participantId: row.id, email: row.email, unsubscribeToken: row.unsubscribe_token }));
    },
    /** Deletes the participant's record and erases their address from past deliveries (right to be forgotten). */
    async remove(organizationId, eventId, participantId) {
      return tx(() => {
        const removed = db.prepare("DELETE FROM event_participants WHERE id = ? AND event_id = ? AND organization_id = ?")
          .run(participantId, eventId, organizationId).changes > 0;
        if (removed) {
          db.prepare(`UPDATE notification_deliveries SET email = 'removed:' || id, unsubscribe_token = ''
            WHERE participant_id = ? AND organization_id = ?`).run(participantId, organizationId);
        }
        return removed;
      });
    },
    /** Public: the unsubscribe page shows which event this is about. */
    async findByUnsubscribeToken(token) {
      const row = db.prepare(`SELECT p.id, p.email, p.unsubscribed_at, e.name FROM event_participants p
        JOIN events e ON e.id = p.event_id WHERE p.unsubscribe_token = ?`).get(token);
      return row ? { participantId: row.id, email: row.email, eventName: row.name, unsubscribed: Boolean(row.unsubscribed_at) } : null;
    },
    async unsubscribe(token, now) {
      return db.prepare("UPDATE event_participants SET unsubscribed_at = COALESCE(unsubscribed_at, ?) WHERE unsubscribe_token = ?")
        .run(now, token).changes > 0;
    },
  };

  const notifications = {
    /**
     * Creates one notification per decision with a pending delivery per recipient, in one
     * transaction. A second call for the same decision returns the existing one (no duplicates).
     */
    async create(organizationId, { eventId, decisionId, action, subject, body, mailer, createdByUserId = null, recipients, now }) {
      return tx(() => {
        const existing = db.prepare("SELECT * FROM participant_notifications WHERE decision_id = ? AND organization_id = ?").get(decisionId, organizationId);
        if (existing) return { duplicate: true, notification: notificationFromRow(existing), deliveries: [] };
        // Double submit or client retry: each POST creates a new decision, so also refuse a second
        // email for the same event and action within a short window (checked inside this transaction).
        const since = new Date(Date.parse(now) - DUPLICATE_WINDOW_MS).toISOString();
        const recent = db.prepare(`SELECT * FROM participant_notifications WHERE organization_id = ? AND event_id = ? AND action = ? AND created_at > ?
          ORDER BY created_at DESC LIMIT 1`).get(organizationId, eventId, action, since);
        if (recent) return { duplicate: true, recent: true, notification: notificationFromRow(recent), deliveries: [] };
        if (!db.prepare("SELECT 1 FROM event_decisions d JOIN events e ON e.id = d.event_id WHERE d.id = ? AND d.event_id = ? AND e.organization_id = ?")
          .get(decisionId, eventId, organizationId)) return { error: "decision_not_found" };
        const id = randomUUID();
        db.prepare(`INSERT INTO participant_notifications (id, organization_id, event_id, decision_id, action, subject, body, mailer,
            recipient_count, created_by_user_id, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
          .run(id, organizationId, eventId, decisionId, action, subject, body, mailer, recipients.length, createdByUserId, now);
        const insert = db.prepare(`INSERT INTO notification_deliveries (id, notification_id, organization_id, participant_id, email,
            unsubscribe_token, status, created_at) VALUES (?, ?, ?, ?, ?, ?, 'pending', ?)`);
        const deliveries = recipients.map((recipient) => {
          const deliveryId = randomUUID();
          insert.run(deliveryId, id, organizationId, recipient.participantId, recipient.email, recipient.unsubscribeToken, now);
          return { id: deliveryId, ...recipient };
        });
        return { duplicate: false, notification: notificationFromRow(db.prepare("SELECT * FROM participant_notifications WHERE id = ?").get(id)), deliveries };
      });
    },
    async markDelivery(organizationId, deliveryId, { status, providerMessageId = null, error = null, sentAt = null }) {
      db.prepare(`UPDATE notification_deliveries SET status = ?, provider_message_id = ?, error = ?, sent_at = ?
        WHERE id = ? AND organization_id = ?`).run(status, providerMessageId, error, sentAt, deliveryId, organizationId);
    },
    async finish(organizationId, notificationId, now) {
      db.prepare(`UPDATE participant_notifications SET
          sent_count = (SELECT count(*) FROM notification_deliveries WHERE notification_id = ? AND status = 'sent'),
          failed_count = (SELECT count(*) FROM notification_deliveries WHERE notification_id = ? AND status = 'failed'),
          completed_at = ? WHERE id = ? AND organization_id = ?`).run(notificationId, notificationId, now, notificationId, organizationId);
      return notificationFromRow(db.prepare("SELECT * FROM participant_notifications WHERE id = ?").get(notificationId));
    },
    async list(organizationId, { eventId = null, limit = 50 } = {}) {
      const rows = db.prepare(`SELECT n.*, e.name AS event_name FROM participant_notifications n JOIN events e ON e.id = n.event_id
        WHERE n.organization_id = ? ${eventId ? "AND n.event_id = ?" : ""} ORDER BY n.created_at DESC LIMIT ?`)
        .all(...(eventId ? [organizationId, eventId, limit] : [organizationId, limit]));
      return rows.map(notificationFromRow);
    },
    /** Developer outbox: the emails as sent, newest first, for one organisation. */
    async outbox(organizationId, { limit = 50 } = {}) {
      return db.prepare(`SELECT d.id, d.email, d.status, d.error, d.sent_at, d.created_at, d.unsubscribe_token, n.subject, n.body, n.mailer,
          e.name AS event_name FROM notification_deliveries d
          JOIN participant_notifications n ON n.id = d.notification_id JOIN events e ON e.id = n.event_id
        WHERE d.organization_id = ? ORDER BY d.created_at DESC, d.email LIMIT ?`).all(organizationId, limit).map((row) => ({
        id: row.id, email: row.email, status: row.status, error: row.error ?? null, sentAt: row.sent_at ?? null, createdAt: row.created_at,
        subject: row.subject, body: row.body, mailer: row.mailer, eventName: row.event_name, unsubscribeToken: row.unsubscribe_token,
      }));
    },
  };

  const billing = {
    async get(organizationId) {
      return subscriptionFromRow(db.prepare("SELECT * FROM billing_subscriptions WHERE organization_id = ?").get(organizationId));
    },
    async findBySubscriptionId(subscriptionId) {
      return subscriptionFromRow(db.prepare("SELECT * FROM billing_subscriptions WHERE subscription_id = ?").get(subscriptionId));
    },
    /** Records the subscription and sets organizations.plan in one transaction. */
    async apply(organizationId, { provider, plan, status, customerId = null, subscriptionId = null, checkoutSessionId = null, now }) {
      return tx(() => {
        if (!db.prepare("SELECT 1 FROM organizations WHERE id = ?").get(organizationId)) return null;
        db.prepare(`INSERT INTO billing_subscriptions (organization_id, provider, plan, status, customer_id, subscription_id, checkout_session_id, updated_at)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT (organization_id) DO UPDATE SET provider = excluded.provider, plan = excluded.plan,
          status = excluded.status, customer_id = COALESCE(excluded.customer_id, customer_id),
          subscription_id = COALESCE(excluded.subscription_id, subscription_id), checkout_session_id = COALESCE(excluded.checkout_session_id, checkout_session_id),
          updated_at = excluded.updated_at`)
          .run(organizationId, provider, plan, status, customerId, subscriptionId, checkoutSessionId, now);
        db.prepare("UPDATE organizations SET plan = ? WHERE id = ?").run(plan, organizationId);
        return subscriptionFromRow(db.prepare("SELECT * FROM billing_subscriptions WHERE organization_id = ?").get(organizationId));
      });
    },
    /** Webhook idempotency: true the first time an event id is seen. */
    async recordWebhookEvent(id, type, now) {
      return db.prepare("INSERT OR IGNORE INTO billing_webhook_events (id, type, received_at) VALUES (?, ?, ?)").run(id, type, now).changes > 0;
    },
  };

  return { participants, notifications, billing };
}
