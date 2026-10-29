/**
 * PostgreSQL storage adapter for RainReady.
 *
 * Same interface as createEventStore() in event-store.mjs, so event-service.mjs, auth.mjs and
 * server.mjs work with either store. Differences:
 *   - every method is async (including store.auth.*);
 *   - event queries run in a transaction that first sets app.organization_id, so PostgreSQL
 *     row-level security also enforces the organisation boundary;
 *   - legacy events.json import is not done here: use `npm run db:export` instead.
 *
 * Schema: database/postgres/init/*.sql. Connect as the least-privilege role rainready_app.
 */
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import pg from "pg";

// Return values in the same shapes the SQLite store returns.
const parseTimestamptz = pg.types.getTypeParser(1184);
const resultTypes = {
  getTypeParser(oid, format) {
    if (oid === 1184) return (value) => (value === null ? null : parseTimestamptz(value).toISOString()); // timestamptz -> ISO string
    if (oid === 1082) return (value) => value;                                                            // date -> "YYYY-MM-DD"
    if (oid === 1083) return (value) => (value === null ? null : value.slice(0, 5));                      // time -> "HH:MM"
    if (oid === 20) return (value) => (value === null ? null : Number(value));                            // bigint -> number
    return pg.types.getTypeParser(oid, format);
  },
};

function sslFromEnvironment(environment) {
  const mode = (environment.RAINREADY_DB_SSL ?? "off").toLowerCase();
  if (mode === "off") return false;
  const ca = environment.RAINREADY_DB_SSL_CA ? readFileSync(environment.RAINREADY_DB_SSL_CA, "utf8") : undefined;
  if (mode === "verify-full") return { ca, rejectUnauthorized: true };
  // verify-ca: check the certificate chain but not the host name (needed through an SSM tunnel to RDS)
  if (mode === "verify-ca") return { ca, rejectUnauthorized: true, checkServerIdentity: () => undefined };
  throw new Error("RAINREADY_DB_SSL must be off, verify-ca or verify-full");
}

/** Connection settings from RAINREADY_DB_* environment variables (see .env.example). */
export function pgConfigFromEnv(environment = process.env) {
  if (!environment.RAINREADY_DB_PASSWORD) {
    throw new Error("RAINREADY_DB_PASSWORD is required when RAINREADY_DB_DRIVER=postgres");
  }
  return {
    host: environment.RAINREADY_DB_HOST || "127.0.0.1",
    port: Number(environment.RAINREADY_DB_PORT || 5432),
    database: environment.RAINREADY_DB_NAME || "rainready",
    user: environment.RAINREADY_DB_USER || "rainready_app",
    password: environment.RAINREADY_DB_PASSWORD,
    ssl: sslFromEnvironment(environment),
  };
}

const EVENT_COLUMNS = `id, organization_id, name, venue, venue_address, latitude, longitude,
  backup_venue_name, backup_venue_address, backup_venue_latitude, backup_venue_longitude,
  participant_count, event_date, event_time, event_type, sensitivity, created_at, updated_at`;

function eventFromRow(row, decisions = []) {
  if (!row) return null;
  const backupVenue = row.backup_venue_name === null ? null : {
    name: row.backup_venue_name,
    address: row.backup_venue_address ?? "",
    latitude: row.backup_venue_latitude,
    longitude: row.backup_venue_longitude,
  };
  return {
    id: row.id,
    name: row.name,
    venue: row.venue,
    venueAddress: row.venue_address,
    latitude: row.latitude,
    longitude: row.longitude,
    backupVenue,
    participantCount: row.participant_count,
    date: row.event_date,
    time: row.event_time,
    type: row.event_type,
    sensitivity: row.sensitivity,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    decisions,
  };
}

function decisionFromRow(row) {
  return {
    id: row.id,
    action: row.action,
    reason: row.reason,
    label: row.label,
    decidedAt: row.decided_at,
    testNotification: {
      mode: row.mode,
      status: row.status,
      generatedAt: row.generated_at,
      intendedRecipientCount: row.intended_recipient_count,
      title: row.title,
      message: row.message,
    },
  };
}

function codedError(code, message) {
  const error = new Error(message);
  error.code = code;
  return error;
}

export function createPgEventStore(config) {
  if (!config) throw new TypeError("PostgreSQL connection settings are required");
  const pool = new pg.Pool({ ...config, types: resultTypes, max: config.max ?? 10, application_name: "rainready" });
  pool.on("error", (error) => console.error("RainReady PostgreSQL pool error:", error.message));
  let closed = false;

  /** Run fn(client) in one transaction; with an organisation id, row-level security is scoped to it. */
  async function transaction(fn, organizationId = null) {
    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      if (organizationId !== null) {
        await client.query("SELECT set_config('app.organization_id', $1, true)", [organizationId]);
      }
      const result = await fn(client);
      await client.query("COMMIT");
      return result;
    } catch (error) {
      try { await client.query("ROLLBACK"); } catch { /* connection already failed */ }
      throw error;
    } finally {
      client.release();
    }
  }
  const forOrganization = (organizationId, fn) => transaction(fn, String(organizationId ?? ""));

  async function decisionsByEvent(client, organizationId, eventIds) {
    const grouped = new Map(eventIds.map((id) => [id, []]));
    if (!eventIds.length) return grouped;
    const { rows } = await client.query(`
      SELECT d.id, d.event_id, d.action, d.reason, d.label, d.decided_at,
             n.mode, n.status, n.generated_at, n.intended_recipient_count, n.title, n.message
        FROM event_decisions d
        LEFT JOIN notification_previews n ON n.decision_id = d.id
       WHERE d.organization_id = $1 AND d.event_id = ANY($2::text[])
       ORDER BY d.decided_at, d.id`, [organizationId, eventIds]);
    for (const row of rows) grouped.get(row.event_id)?.push(decisionFromRow(row));
    return grouped;
  }

  async function getWith(client, organizationId, id) {
    const { rows } = await client.query(
      `SELECT ${EVENT_COLUMNS} FROM events WHERE id = $1 AND organization_id = $2`, [id, organizationId]);
    if (!rows.length) return null;
    const decisions = await decisionsByEvent(client, organizationId, [id]);
    return eventFromRow(rows[0], decisions.get(id));
  }

  const get = (organizationId, id) => forOrganization(organizationId, (client) => getWith(client, organizationId, id));

  const eventValues = (fields) => [
    fields.name, fields.venue, fields.venueAddress ?? "", fields.latitude, fields.longitude,
    fields.backupVenue?.name ?? null, fields.backupVenue?.address ?? null,
    fields.backupVenue?.latitude ?? null, fields.backupVenue?.longitude ?? null,
    fields.participantCount ?? 0, fields.date, fields.time, fields.type, fields.sensitivity,
  ];

  const auth = {
    async findUserByEmail(email) {
      const { rows } = await pool.query("SELECT id, email, password_hash, created_at FROM users WHERE email = $1", [email]);
      return rows[0] ?? null;
    },
    async createAccount({ userId, email, passwordHash, organizationId, organizationName, invitationTokenHash, now }) {
      try {
        return await transaction(async (client) => {
          if ((await client.query("SELECT 1 FROM users WHERE email = $1", [email])).rowCount) {
            throw codedError("email_exists", "An account with this email already exists.");
          }
          let selectedOrganizationId = organizationId;
          let role = "owner";
          if (invitationTokenHash) {
            const invitation = await client.query(`SELECT organization_id FROM organization_invitations
              WHERE token_hash = $1 AND used_at IS NULL AND expires_at > $2 FOR UPDATE`, [invitationTokenHash, now]);
            if (!invitation.rowCount) throw codedError("invalid_invitation", "This invitation is invalid, expired, or already used.");
            selectedOrganizationId = invitation.rows[0].organization_id;
            role = "member";
          } else {
            await client.query("INSERT INTO organizations (id, name, created_at) VALUES ($1, $2, $3)",
              [organizationId, organizationName, now]);
            // First registered workspace takes ownership of imported legacy events (the function
            // does nothing once any user exists), matching event-store.mjs.
            await client.query("SELECT claim_legacy_events($1)", [organizationId]);
          }
          await client.query("INSERT INTO users (id, email, password_hash, created_at) VALUES ($1, $2, $3, $4)",
            [userId, email, passwordHash, now]);
          await client.query(`INSERT INTO organization_memberships (user_id, organization_id, role, created_at)
            VALUES ($1, $2, $3, $4)`, [userId, selectedOrganizationId, role, now]);
          if (invitationTokenHash) {
            await client.query("UPDATE organization_invitations SET used_at = $1 WHERE token_hash = $2 AND used_at IS NULL",
              [now, invitationTokenHash]);
          }
          return { id: userId, email, organizationId: selectedOrganizationId, role };
        });
      } catch (error) {
        if (error.code === "23505" && error.constraint === "users_email_key") {
          throw codedError("email_exists", "An account with this email already exists.");
        }
        throw error;
      }
    },
    async listMemberships(userId) {
      const { rows } = await pool.query(`SELECT o.id, o.name, o.plan, m.role FROM organization_memberships m
        JOIN organizations o ON o.id = m.organization_id
        WHERE m.user_id = $1 ORDER BY o.created_at, o.name`, [userId]);
      return rows;
    },
    async createSession({ tokenHash, userId, expiresAt, now }) {
      await pool.query("DELETE FROM auth_sessions WHERE expires_at <= $1", [now]);
      await pool.query("INSERT INTO auth_sessions (token_hash, user_id, expires_at, created_at) VALUES ($1, $2, $3, $4)",
        [tokenHash, userId, expiresAt, now]);
    },
    async getSession(tokenHash, now) {
      const { rows } = await pool.query(`SELECT s.user_id, s.expires_at, u.email FROM auth_sessions s
        JOIN users u ON u.id = s.user_id WHERE s.token_hash = $1 AND s.expires_at > $2`, [tokenHash, now]);
      return rows[0] ?? null;
    },
    async deleteSession(tokenHash) {
      await pool.query("DELETE FROM auth_sessions WHERE token_hash = $1", [tokenHash]);
    },
    async getMembership(userId, organizationId) {
      const { rows } = await pool.query(`SELECT m.role, o.id, o.name, o.plan FROM organization_memberships m
        JOIN organizations o ON o.id = m.organization_id
        WHERE m.user_id = $1 AND m.organization_id = $2`, [userId, organizationId]);
      return rows[0] ?? null;
    },
    /** Operator/billing use only (npm run plan); no HTTP route changes a plan. */
    async setOrganizationPlan(organizationId, plan) {
      return (await pool.query("UPDATE organizations SET plan = $1 WHERE id = $2", [plan, organizationId])).rowCount > 0;
    },
    async getOrganization(organizationId) {
      return (await pool.query("SELECT id, name, plan FROM organizations WHERE id = $1", [organizationId])).rows[0] ?? null;
    },
    async createInvitation({ tokenHash, organizationId, createdByUserId, expiresAt, now }) {
      await pool.query(`INSERT INTO organization_invitations
        (token_hash, organization_id, created_by_user_id, expires_at, created_at)
        VALUES ($1, $2, $3, $4, $5)`, [tokenHash, organizationId, createdByUserId, expiresAt, now]);
    },
    async listOrganizationMembers(organizationId) {
      const { rows } = await pool.query(`SELECT u.id, u.email::text AS email, m.role, m.created_at AS joined_at
        FROM organization_memberships m JOIN users u ON u.id = m.user_id
        WHERE m.organization_id = $1
        ORDER BY CASE m.role WHEN 'owner' THEN 0 ELSE 1 END, u.email`, [organizationId]);
      return rows;
    },
    async removeOrganizationMember({ actorUserId, organizationId, targetUserId }) {
      return transaction(async (client) => {
        const roleOf = async (userId) => (await client.query(
          "SELECT role FROM organization_memberships WHERE user_id = $1 AND organization_id = $2",
          [userId, organizationId])).rows[0]?.role;
        const actorRole = await roleOf(actorUserId);
        const targetRole = await roleOf(targetUserId);
        if (actorRole !== "owner" || targetRole !== "member" || actorUserId === targetUserId) return false;
        await client.query("DELETE FROM organization_memberships WHERE user_id = $1 AND organization_id = $2 AND role = 'member'",
          [targetUserId, organizationId]);
        await client.query("DELETE FROM auth_sessions WHERE user_id = $1", [targetUserId]);
        const remaining = await client.query("SELECT 1 FROM organization_memberships WHERE user_id = $1 LIMIT 1", [targetUserId]);
        if (!remaining.rowCount) await client.query("DELETE FROM users WHERE id = $1", [targetUserId]);
        return true;
      });
    },
    async deleteUserSessions(userId) {
      return (await pool.query("DELETE FROM auth_sessions WHERE user_id = $1", [userId])).rowCount;
    },
    async consumeRateLimit({ keyHash, now, windowMs, maxAttempts }) {
      return transaction(async (client) => {
        const current = (await client.query(
          "SELECT window_started_at, attempts, blocked_until FROM auth_rate_limits WHERE key_hash = $1 FOR UPDATE",
          [keyHash])).rows[0];
        const inWindow = current && current.window_started_at + windowMs > now;
        if (inWindow && current.attempts >= maxAttempts) {
          return { allowed: false, retryAfterSeconds: Math.max(1, Math.ceil((current.blocked_until - now) / 1000)) };
        }
        const windowStartedAt = inWindow ? current.window_started_at : now;
        const attempts = inWindow ? current.attempts + 1 : 1;
        await client.query(`INSERT INTO auth_rate_limits (key_hash, window_started_at, attempts, blocked_until)
          VALUES ($1, $2, $3, $4) ON CONFLICT (key_hash) DO UPDATE SET
          window_started_at = EXCLUDED.window_started_at, attempts = EXCLUDED.attempts, blocked_until = EXCLUDED.blocked_until`,
          [keyHash, windowStartedAt, attempts, windowStartedAt + windowMs]);
        await client.query("DELETE FROM auth_rate_limits WHERE blocked_until < $1", [now - 86_400_000]);
        return { allowed: true, retryAfterSeconds: 0 };
      });
    },
  };

  const ads = {
    /** kind is "impression" or "click"; adds one to that day's counter (not organisation data, so no RLS scope). */
    async record({ adId, placement, day, kind }) {
      const column = kind === "click" ? "clicks" : "impressions";
      await pool.query(`INSERT INTO ad_daily_stats (ad_id, placement, day, ${column}) VALUES ($1, $2, $3::date, 1)
        ON CONFLICT (ad_id, placement, day) DO UPDATE SET ${column} = ad_daily_stats.${column} + 1`, [adId, placement, day]);
    },
    async stats({ fromDay = "2000-01-01", toDay = "2100-12-31" } = {}) {
      const { rows } = await pool.query(`SELECT ad_id AS "adId", placement, to_char(day, 'YYYY-MM-DD') AS day,
          impressions::int AS impressions, clicks::int AS clicks
        FROM ad_daily_stats WHERE day BETWEEN $1::date AND $2::date ORDER BY day, ad_id, placement`, [fromDay, toDay]);
      return rows;
    },
  };

  return {
    auth,
    ads,
    driver: "postgres",
    async list(organizationId) {
      return forOrganization(organizationId, async (client) => {
        const { rows } = await client.query(
          `SELECT ${EVENT_COLUMNS} FROM events WHERE organization_id = $1 ORDER BY created_at, id`, [organizationId]);
        const decisions = await decisionsByEvent(client, organizationId, rows.map((row) => row.id));
        return rows.map((row) => eventFromRow(row, decisions.get(row.id)));
      });
    },
    get,
    async create(organizationId, fields) {
      const now = new Date().toISOString();
      const id = randomUUID();
      return forOrganization(organizationId, async (client) => {
        await client.query(`INSERT INTO events (id, organization_id, name, venue, venue_address, latitude, longitude,
            backup_venue_name, backup_venue_address, backup_venue_latitude, backup_venue_longitude,
            participant_count, event_date, event_time, event_type, sensitivity, created_at, updated_at)
          VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18)`,
          [id, organizationId, ...eventValues(fields), now, now]);
        return getWith(client, organizationId, id);
      });
    },
    async update(organizationId, id, fields) {
      return forOrganization(organizationId, async (client) => {
        const result = await client.query(`UPDATE events SET name = $1, venue = $2, venue_address = $3,
            latitude = $4, longitude = $5, backup_venue_name = $6, backup_venue_address = $7,
            backup_venue_latitude = $8, backup_venue_longitude = $9, participant_count = $10,
            event_date = $11, event_time = $12, event_type = $13, sensitivity = $14, updated_at = $15
          WHERE id = $16 AND organization_id = $17`,
          [...eventValues(fields), new Date().toISOString(), id, organizationId]);
        return result.rowCount ? getWith(client, organizationId, id) : null;
      });
    },
    async addDecision(organizationId, id, decision) {
      const notification = decision.testNotification;
      return forOrganization(organizationId, async (client) => {
        const locked = await client.query("SELECT 1 FROM events WHERE id = $1 AND organization_id = $2 FOR UPDATE",
          [id, organizationId]);
        if (!locked.rowCount) return null;
        await client.query(`INSERT INTO event_decisions (id, organization_id, event_id, action, reason, label, decided_at)
          VALUES ($1, $2, $3, $4, $5, $6, $7)`,
          [decision.id, organizationId, id, decision.action, decision.reason, decision.label, decision.decidedAt]);
        await client.query(`INSERT INTO notification_previews (decision_id, organization_id, mode, status, generated_at,
            intended_recipient_count, title, message)
          VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
          [decision.id, organizationId, notification.mode, notification.status, notification.generatedAt,
            notification.intendedRecipientCount, notification.title, notification.message]);
        await client.query("UPDATE events SET updated_at = $1 WHERE id = $2 AND organization_id = $3",
          [decision.decidedAt, id, organizationId]);
        return getWith(client, organizationId, id);
      });
    },
    async listDecisions(organizationId, id) {
      return forOrganization(organizationId, async (client) => {
        const exists = await client.query("SELECT 1 FROM events WHERE id = $1 AND organization_id = $2", [id, organizationId]);
        if (!exists.rowCount) return null;
        return (await decisionsByEvent(client, organizationId, [id])).get(id);
      });
    },
    async delete(organizationId, id) {
      return forOrganization(organizationId, async (client) =>
        (await client.query("DELETE FROM events WHERE id = $1 AND organization_id = $2", [id, organizationId])).rowCount > 0);
    },
    async close() {
      if (closed) return;
      closed = true;
      await pool.end();
    },
  };
}
