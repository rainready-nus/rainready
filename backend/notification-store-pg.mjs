/**
 * Participants, participant notifications and billing for the PostgreSQL store (same methods as
 * notification-store-sqlite.mjs). Organisation data runs inside forOrganization(), so row-level
 * security applies. The public join and unsubscribe pages know only a token: they go through the
 * join_link_target() / unsubscribe_target() functions, then write inside that organisation.
 */
import { randomUUID } from "node:crypto";
import { DUPLICATE_WINDOW_MS, MAX_PARTICIPANTS_PER_EVENT, notificationFromRow, participantFromRow, subscriptionFromRow } from "./notification-store-sqlite.mjs";

const iso = (value) => value instanceof Date ? value.toISOString() : value ?? null;
const PARTICIPANT_COLUMNS = `id, event_id, email::text AS email, name, consent_source, consent_text, consented_at,
  unsubscribed_at, created_at`;
const participantRow = (row) => row && participantFromRow({ ...row, consented_at: iso(row.consented_at), unsubscribed_at: iso(row.unsubscribed_at), created_at: iso(row.created_at) });
const notificationRow = (row) => row && notificationFromRow({ ...row, created_at: iso(row.created_at), completed_at: iso(row.completed_at) });
const subscriptionRow = (row) => row && subscriptionFromRow({ ...row, updated_at: iso(row.updated_at) });

export function createPgNotificationStore({ pool, transaction, forOrganization }) {
  const eventExists = async (client, organizationId, eventId) =>
    (await client.query("SELECT 1 FROM events WHERE id = $1 AND organization_id = $2", [eventId, organizationId])).rowCount > 0;

  const participants = {
    async getJoinLink(organizationId, eventId) {
      return forOrganization(organizationId, async (client) => {
        const row = (await client.query("SELECT token, created_at FROM event_join_links WHERE event_id = $1 AND organization_id = $2", [eventId, organizationId])).rows[0];
        return row ? { token: row.token, createdAt: iso(row.created_at) } : null;
      });
    },
    async setJoinLink(organizationId, eventId, token, now) {
      return forOrganization(organizationId, async (client) => {
        if (!await eventExists(client, organizationId, eventId)) return null;
        await client.query(`INSERT INTO event_join_links (event_id, organization_id, token, created_at) VALUES ($1, $2, $3, $4)
          ON CONFLICT (event_id) DO UPDATE SET token = EXCLUDED.token, created_at = EXCLUDED.created_at`, [eventId, organizationId, token, now]);
        return { token, createdAt: now };
      });
    },
    async findJoinTarget(token) {
      const row = (await pool.query("SELECT * FROM join_link_target($1)", [token])).rows[0];
      return row ? { organizationId: row.organization_id, eventId: row.event_id, name: row.name, date: row.event_date, time: row.event_time, venue: row.venue } : null;
    },
    async add(organizationId, eventId, { email, name = "", consentSource, consentText, unsubscribeToken, now }) {
      return forOrganization(organizationId, async (client) => {
        if (!await eventExists(client, organizationId, eventId)) return { error: "event_not_found" };
        // Lock the event row so two sign-ups for the same email cannot race.
        await client.query("SELECT 1 FROM events WHERE id = $1 AND organization_id = $2 FOR UPDATE", [eventId, organizationId]);
        const current = (await client.query(`SELECT ${PARTICIPANT_COLUMNS} FROM event_participants WHERE event_id = $1 AND email = $2`, [eventId, email])).rows[0];
        // Unsubscribed people are not re-subscribed through the shareable join link (see the SQLite store).
        if (current) return { status: current.unsubscribed_at ? "unsubscribed_kept" : "already_joined", participant: participantRow(current) };
        const count = (await client.query("SELECT count(*)::int AS n FROM event_participants WHERE event_id = $1", [eventId])).rows[0].n;
        if (count >= MAX_PARTICIPANTS_PER_EVENT) return { error: "list_full" };
        const row = (await client.query(`INSERT INTO event_participants (id, organization_id, event_id, email, name, consent_source, consent_text,
            consented_at, unsubscribe_token, created_at) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $8) RETURNING ${PARTICIPANT_COLUMNS}`,
        [randomUUID(), organizationId, eventId, email, name, consentSource, consentText, now, unsubscribeToken])).rows[0];
        return { status: "joined", participant: participantRow(row) };
      });
    },
    async list(organizationId, eventId) {
      return forOrganization(organizationId, async (client) => (await client.query(
        `SELECT ${PARTICIPANT_COLUMNS} FROM event_participants WHERE organization_id = $1 AND event_id = $2
          ORDER BY unsubscribed_at IS NOT NULL, created_at, email`, [organizationId, eventId])).rows.map(participantRow));
    },
    async counts(organizationId) {
      return forOrganization(organizationId, async (client) => {
        const { rows } = await client.query(`SELECT event_id, count(*)::int AS n FROM event_participants
          WHERE organization_id = $1 AND unsubscribed_at IS NULL GROUP BY event_id`, [organizationId]);
        return Object.fromEntries(rows.map((row) => [row.event_id, row.n]));
      });
    },
    async recipients(organizationId, eventId) {
      return forOrganization(organizationId, async (client) => (await client.query(
        `SELECT id, email::text AS email, unsubscribe_token FROM event_participants
          WHERE organization_id = $1 AND event_id = $2 AND unsubscribed_at IS NULL ORDER BY created_at, email`, [organizationId, eventId]))
        .rows.map((row) => ({ participantId: row.id, email: row.email, unsubscribeToken: row.unsubscribe_token })));
    },
    async remove(organizationId, eventId, participantId) {
      return forOrganization(organizationId, async (client) => {
        const removed = (await client.query("DELETE FROM event_participants WHERE id = $1 AND event_id = $2 AND organization_id = $3",
          [participantId, eventId, organizationId])).rowCount > 0;
        if (removed) {
          await client.query(`UPDATE notification_deliveries SET email = 'removed:' || id, unsubscribe_token = ''
            WHERE participant_id = $1 AND organization_id = $2`, [participantId, organizationId]);
        }
        return removed;
      });
    },
    async findByUnsubscribeToken(token) {
      const row = (await pool.query("SELECT * FROM unsubscribe_target($1)", [token])).rows[0];
      return row ? { participantId: row.participant_id, email: row.email, eventName: row.event_name, unsubscribed: row.unsubscribed, organizationId: row.organization_id } : null;
    },
    async unsubscribe(token, now) {
      const target = await participants.findByUnsubscribeToken(token);
      if (!target) return false;
      return forOrganization(target.organizationId, async (client) => (await client.query(
        "UPDATE event_participants SET unsubscribed_at = COALESCE(unsubscribed_at, $1) WHERE unsubscribe_token = $2 AND organization_id = $3",
        [now, token, target.organizationId])).rowCount > 0);
    },
  };

  const notifications = {
    async create(organizationId, { eventId, decisionId, action, subject, body, mailer, createdByUserId = null, recipients, now }) {
      return forOrganization(organizationId, async (client) => {
        const decision = await client.query("SELECT 1 FROM event_decisions WHERE id = $1 AND event_id = $2 AND organization_id = $3",
          [decisionId, eventId, organizationId]);
        if (!decision.rowCount) return { error: "decision_not_found" };
        // Serialise notifications per event, then refuse a double submit (see the SQLite store).
        await client.query("SELECT 1 FROM events WHERE id = $1 AND organization_id = $2 FOR UPDATE", [eventId, organizationId]);
        const recent = (await client.query(`SELECT * FROM participant_notifications WHERE organization_id = $1 AND event_id = $2 AND action = $3
            AND created_at > $4::timestamptz - make_interval(secs => $5) ORDER BY created_at DESC LIMIT 1`,
        [organizationId, eventId, action, now, DUPLICATE_WINDOW_MS / 1000])).rows[0];
        if (recent) return { duplicate: true, recent: true, notification: notificationRow(recent), deliveries: [] };
        const id = randomUUID();
        const inserted = await client.query(`INSERT INTO participant_notifications (id, organization_id, event_id, decision_id, action, subject, body,
            mailer, recipient_count, created_by_user_id, created_at) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)
          ON CONFLICT (decision_id) DO NOTHING RETURNING *`,
        [id, organizationId, eventId, decisionId, action, subject, body, mailer, recipients.length, createdByUserId, now]);
        if (!inserted.rowCount) {
          const existing = (await client.query("SELECT * FROM participant_notifications WHERE decision_id = $1 AND organization_id = $2", [decisionId, organizationId])).rows[0];
          return existing ? { duplicate: true, notification: notificationRow(existing), deliveries: [] } : { error: "decision_not_found" };
        }
        const deliveries = [];
        for (const recipient of recipients) {
          const deliveryId = randomUUID();
          await client.query(`INSERT INTO notification_deliveries (id, notification_id, organization_id, participant_id, email, unsubscribe_token,
              status, created_at) VALUES ($1, $2, $3, $4, $5, $6, 'pending', $7)`,
          [deliveryId, id, organizationId, recipient.participantId, recipient.email, recipient.unsubscribeToken, now]);
          deliveries.push({ id: deliveryId, ...recipient });
        }
        return { duplicate: false, notification: notificationRow(inserted.rows[0]), deliveries };
      });
    },
    async markDelivery(organizationId, deliveryId, { status, providerMessageId = null, error = null, sentAt = null }) {
      await forOrganization(organizationId, (client) => client.query(`UPDATE notification_deliveries SET status = $1, provider_message_id = $2,
          error = $3, sent_at = $4 WHERE id = $5 AND organization_id = $6`, [status, providerMessageId, error, sentAt, deliveryId, organizationId]));
    },
    async finish(organizationId, notificationId, now) {
      return forOrganization(organizationId, async (client) => notificationRow((await client.query(`UPDATE participant_notifications n SET
          sent_count = (SELECT count(*) FROM notification_deliveries d WHERE d.notification_id = n.id AND d.status = 'sent'),
          failed_count = (SELECT count(*) FROM notification_deliveries d WHERE d.notification_id = n.id AND d.status = 'failed'),
          completed_at = $1 WHERE n.id = $2 AND n.organization_id = $3 RETURNING n.*`, [now, notificationId, organizationId])).rows[0]));
    },
    async list(organizationId, { eventId = null, limit = 50 } = {}) {
      return forOrganization(organizationId, async (client) => (await client.query(
        `SELECT n.*, e.name AS event_name FROM participant_notifications n JOIN events e ON e.id = n.event_id
          WHERE n.organization_id = $1 AND ($2::text IS NULL OR n.event_id = $2) ORDER BY n.created_at DESC LIMIT $3`,
        [organizationId, eventId, limit])).rows.map(notificationRow));
    },
    async outbox(organizationId, { limit = 50 } = {}) {
      return forOrganization(organizationId, async (client) => (await client.query(
        `SELECT d.id, d.email::text AS email, d.status, d.error, d.sent_at, d.created_at, d.unsubscribe_token, n.subject, n.body, n.mailer,
            e.name AS event_name FROM notification_deliveries d
            JOIN participant_notifications n ON n.id = d.notification_id JOIN events e ON e.id = n.event_id
          WHERE d.organization_id = $1 ORDER BY d.created_at DESC, d.email LIMIT $2`, [organizationId, limit])).rows.map((row) => ({
        id: row.id, email: row.email, status: row.status, error: row.error ?? null, sentAt: iso(row.sent_at), createdAt: iso(row.created_at),
        subject: row.subject, body: row.body, mailer: row.mailer, eventName: row.event_name, unsubscribeToken: row.unsubscribe_token,
      })));
    },
  };

  const billing = {
    async get(organizationId) {
      return subscriptionRow((await pool.query("SELECT * FROM billing_subscriptions WHERE organization_id = $1", [organizationId])).rows[0]);
    },
    async findBySubscriptionId(subscriptionId) {
      return subscriptionRow((await pool.query("SELECT * FROM billing_subscriptions WHERE subscription_id = $1", [subscriptionId])).rows[0]);
    },
    async apply(organizationId, { provider, plan, status, customerId = null, subscriptionId = null, checkoutSessionId = null, now }) {
      return transaction(async (client) => {
        const organization = await client.query("SELECT 1 FROM organizations WHERE id = $1 FOR UPDATE", [organizationId]);
        if (!organization.rowCount) return null;
        const row = (await client.query(`INSERT INTO billing_subscriptions (organization_id, provider, plan, status, customer_id, subscription_id,
            checkout_session_id, updated_at) VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
          ON CONFLICT (organization_id) DO UPDATE SET provider = EXCLUDED.provider, plan = EXCLUDED.plan, status = EXCLUDED.status,
            customer_id = COALESCE(EXCLUDED.customer_id, billing_subscriptions.customer_id),
            subscription_id = COALESCE(EXCLUDED.subscription_id, billing_subscriptions.subscription_id),
            checkout_session_id = COALESCE(EXCLUDED.checkout_session_id, billing_subscriptions.checkout_session_id), updated_at = EXCLUDED.updated_at
          RETURNING *`, [organizationId, provider, plan, status, customerId, subscriptionId, checkoutSessionId, now])).rows[0];
        await client.query("UPDATE organizations SET plan = $1 WHERE id = $2", [plan, organizationId]);
        return subscriptionRow(row);
      });
    },
    async recordWebhookEvent(id, type, now) {
      return (await pool.query("INSERT INTO billing_webhook_events (id, type, received_at) VALUES ($1, $2, $3) ON CONFLICT (id) DO NOTHING",
        [id, type, now])).rowCount > 0;
    },
  };

  return { participants, notifications, billing };
}
