import { randomUUID } from "node:crypto";
import { mkdirSync, readFileSync, existsSync } from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";

function parseLegacyEvents(filePath) {
  if (!filePath || !existsSync(filePath)) return [];
  const parsed = JSON.parse(readFileSync(filePath, "utf8"));
  if (!Array.isArray(parsed)) throw new Error("legacy event data must be a JSON array");
  return parsed;
}

function createSchema(db) {
  db.exec(`
    PRAGMA foreign_keys = ON;
    PRAGMA journal_mode = WAL;
    PRAGMA busy_timeout = 3000;
    CREATE TABLE IF NOT EXISTS organizations (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      created_at TEXT NOT NULL,
      plan TEXT NOT NULL DEFAULT 'free' CHECK (plan IN ('free', 'community', 'enterprise'))
    );
    INSERT OR IGNORE INTO organizations (id, name, created_at)
      VALUES ('legacy', 'Imported legacy events', '1970-01-01T00:00:00.000Z');
    CREATE TABLE IF NOT EXISTS users (
      id TEXT PRIMARY KEY,
      email TEXT NOT NULL UNIQUE COLLATE NOCASE,
      password_hash TEXT NOT NULL,
      created_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS organization_memberships (
      user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      organization_id TEXT NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
      role TEXT NOT NULL CHECK (role IN ('owner', 'member')),
      created_at TEXT NOT NULL,
      PRIMARY KEY (user_id, organization_id)
    );
    CREATE INDEX IF NOT EXISTS idx_memberships_organization ON organization_memberships(organization_id, user_id);
    CREATE TABLE IF NOT EXISTS auth_sessions (
      token_hash TEXT PRIMARY KEY,
      user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      expires_at TEXT NOT NULL,
      created_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_auth_sessions_expiry ON auth_sessions(expires_at);
    CREATE TABLE IF NOT EXISTS auth_rate_limits (
      key_hash TEXT PRIMARY KEY,
      window_started_at INTEGER NOT NULL,
      attempts INTEGER NOT NULL,
      blocked_until INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS organization_invitations (
      token_hash TEXT PRIMARY KEY,
      organization_id TEXT NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
      created_by_user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      expires_at TEXT NOT NULL,
      used_at TEXT,
      created_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS events (
      id TEXT PRIMARY KEY,
      organization_id TEXT NOT NULL DEFAULT 'legacy' REFERENCES organizations(id),
      name TEXT NOT NULL,
      venue TEXT NOT NULL,
      venue_address TEXT NOT NULL DEFAULT '',
      latitude REAL NOT NULL,
      longitude REAL NOT NULL,
      backup_venue_name TEXT,
      backup_venue_address TEXT,
      backup_venue_latitude REAL,
      backup_venue_longitude REAL,
      participant_count INTEGER NOT NULL DEFAULT 0 CHECK (participant_count >= 0),
      event_date TEXT NOT NULL,
      event_time TEXT NOT NULL,
      event_type TEXT NOT NULL,
      sensitivity TEXT NOT NULL CHECK (sensitivity IN ('low', 'medium', 'high')),
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS event_decisions (
      id TEXT PRIMARY KEY,
      event_id TEXT NOT NULL REFERENCES events(id) ON DELETE CASCADE,
      action TEXT NOT NULL CHECK (action IN ('continue', 'prepare', 'relocate', 'postpone', 'cancel')),
      reason TEXT NOT NULL,
      label TEXT NOT NULL,
      decided_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_event_decisions_event_id ON event_decisions(event_id, decided_at);
    CREATE TABLE IF NOT EXISTS notification_previews (
      decision_id TEXT PRIMARY KEY REFERENCES event_decisions(id) ON DELETE CASCADE,
      mode TEXT NOT NULL CHECK (mode = 'test'),
      status TEXT NOT NULL CHECK (status = 'not_sent'),
      generated_at TEXT NOT NULL,
      intended_recipient_count INTEGER NOT NULL CHECK (intended_recipient_count >= 0),
      title TEXT NOT NULL,
      message TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS legacy_imports (
      source_path TEXT PRIMARY KEY,
      imported_at TEXT NOT NULL,
      imported_count INTEGER NOT NULL
    );
    -- Sponsored messages: aggregated daily counters only, no user or organisation identifiers.
    CREATE TABLE IF NOT EXISTS ad_daily_stats (
      ad_id TEXT NOT NULL,
      placement TEXT NOT NULL,
      day TEXT NOT NULL,
      impressions INTEGER NOT NULL DEFAULT 0 CHECK (impressions >= 0),
      clicks INTEGER NOT NULL DEFAULT 0 CHECK (clicks >= 0),
      PRIMARY KEY (ad_id, placement, day)
    );
  `);
  const columns = db.prepare("PRAGMA table_info(events)").all().map((column) => column.name);
  if (!columns.includes("organization_id")) {
    db.exec("ALTER TABLE events ADD COLUMN organization_id TEXT NOT NULL DEFAULT 'legacy'");
  }
  db.exec("CREATE INDEX IF NOT EXISTS idx_events_organization_created ON events(organization_id, created_at)");
  // Subscription plan per organisation (databases created before plans start everyone on Free).
  const organizationColumns = db.prepare("PRAGMA table_info(organizations)").all().map((column) => column.name);
  if (!organizationColumns.includes("plan")) {
    db.exec("ALTER TABLE organizations ADD COLUMN plan TEXT NOT NULL DEFAULT 'free' CHECK (plan IN ('free', 'community', 'enterprise'))");
  }
}

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

export function createEventStore({ databasePath, legacyFilePath = null } = {}) {
  if (!databasePath) throw new TypeError("databasePath is required");
  mkdirSync(path.dirname(databasePath), { recursive: true });
  const db = new DatabaseSync(databasePath);
  let closed = false;
  createSchema(db);

  const selectEvent = db.prepare("SELECT * FROM events WHERE id = ? AND organization_id = ?");
  const selectDecisions = db.prepare(`
    SELECT d.*, n.mode, n.status, n.generated_at, n.intended_recipient_count, n.title, n.message
    FROM event_decisions d LEFT JOIN notification_previews n ON n.decision_id = d.id
    WHERE d.event_id = ? ORDER BY d.decided_at, d.rowid
  `);
  const insertEvent = db.prepare(`
    INSERT INTO events (id, organization_id, name, venue, venue_address, latitude, longitude,
      backup_venue_name, backup_venue_address, backup_venue_latitude, backup_venue_longitude,
      participant_count, event_date, event_time, event_type, sensitivity, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);

  const decisionsFor = (id) => selectDecisions.all(id).map((row) => ({
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
  }));
  const get = (organizationId, id) => {
    const row = selectEvent.get(id, organizationId);
    return row ? eventFromRow(row, decisionsFor(id)) : null;
  };

  function insertEventRecord(event) {
    insertEvent.run(
      event.id, event.organizationId ?? "legacy", event.name, event.venue, event.venueAddress ?? "", event.latitude, event.longitude,
      event.backupVenue?.name ?? null, event.backupVenue?.address ?? null,
      event.backupVenue?.latitude ?? null, event.backupVenue?.longitude ?? null,
      event.participantCount ?? 0, event.date, event.time, event.type, event.sensitivity,
      event.createdAt, event.updatedAt,
    );
    for (const decision of event.decisions ?? []) {
      const decisionId = decision.id ?? randomUUID();
      db.prepare(`INSERT OR IGNORE INTO event_decisions (id, event_id, action, reason, label, decided_at)
        VALUES (?, ?, ?, ?, ?, ?)`).run(decisionId, event.id, decision.action, decision.reason, decision.label ?? decision.action, decision.decidedAt);
      if (decision.testNotification) {
        const notification = decision.testNotification;
        db.prepare(`INSERT OR IGNORE INTO notification_previews
          (decision_id, mode, status, generated_at, intended_recipient_count, title, message)
          VALUES (?, ?, ?, ?, ?, ?, ?)`).run(
          decisionId, notification.mode, notification.status, notification.generatedAt,
          notification.intendedRecipientCount ?? 0, notification.title, notification.message,
        );
      }
    }
  }

  function migrateLegacy() {
    if (!legacyFilePath || !existsSync(legacyFilePath)) return;
    const sourcePath = path.resolve(legacyFilePath);
    if (db.prepare("SELECT 1 FROM legacy_imports WHERE source_path = ?").get(sourcePath)) return;
    const events = parseLegacyEvents(sourcePath);
    db.exec("BEGIN IMMEDIATE");
    try {
      for (const event of events) {
        if (!event?.id || selectEvent.get(event.id, "legacy")) continue;
        insertEventRecord({ ...event, decisions: event.decisions ?? [] });
      }
      db.prepare("INSERT INTO legacy_imports (source_path, imported_at, imported_count) VALUES (?, ?, ?)")
        .run(sourcePath, new Date().toISOString(), events.length);
      db.exec("COMMIT");
    } catch (error) {
      db.exec("ROLLBACK");
      throw error;
    }
  }
  migrateLegacy();

  const auth = {
    findUserByEmail(email) {
      return db.prepare("SELECT id, email, password_hash, created_at FROM users WHERE email = ? COLLATE NOCASE").get(email) ?? null;
    },
    createAccount({ userId, email, passwordHash, organizationId, organizationName, invitationTokenHash, now }) {
      db.exec("BEGIN IMMEDIATE");
      try {
        if (db.prepare("SELECT 1 FROM users WHERE email = ? COLLATE NOCASE").get(email)) {
          const error = new Error("An account with this email already exists.");
          error.code = "email_exists";
          throw error;
        }
        let selectedOrganizationId = organizationId;
        let role = "owner";
        if (invitationTokenHash) {
          const invitation = db.prepare(`SELECT organization_id FROM organization_invitations
            WHERE token_hash = ? AND used_at IS NULL AND expires_at > ?`).get(invitationTokenHash, now);
          if (!invitation) {
            const error = new Error("This invitation is invalid, expired, or already used.");
            error.code = "invalid_invitation";
            throw error;
          }
          selectedOrganizationId = invitation.organization_id;
          role = "member";
        } else {
          db.prepare("INSERT INTO organizations (id, name, created_at) VALUES (?, ?, ?)")
            .run(organizationId, organizationName, now);
          const isFirstUser = !db.prepare("SELECT 1 FROM users LIMIT 1").get();
          if (isFirstUser) db.prepare("UPDATE events SET organization_id = ? WHERE organization_id = 'legacy'").run(organizationId);
        }
        db.prepare("INSERT INTO users (id, email, password_hash, created_at) VALUES (?, ?, ?, ?)")
          .run(userId, email, passwordHash, now);
        db.prepare(`INSERT INTO organization_memberships (user_id, organization_id, role, created_at)
          VALUES (?, ?, ?, ?)`).run(userId, selectedOrganizationId, role, now);
        if (invitationTokenHash) {
          db.prepare("UPDATE organization_invitations SET used_at = ? WHERE token_hash = ? AND used_at IS NULL")
            .run(now, invitationTokenHash);
        }
        db.exec("COMMIT");
        return { id: userId, email, organizationId: selectedOrganizationId, role };
      } catch (error) {
        db.exec("ROLLBACK");
        throw error;
      }
    },
    listMemberships(userId) {
      return db.prepare(`SELECT o.id, o.name, o.plan, m.role FROM organization_memberships m
        JOIN organizations o ON o.id = m.organization_id
        WHERE m.user_id = ? ORDER BY o.created_at, o.name`).all(userId);
    },
    createSession({ tokenHash, userId, expiresAt, now }) {
      db.prepare("DELETE FROM auth_sessions WHERE expires_at <= ?").run(now);
      db.prepare("INSERT INTO auth_sessions (token_hash, user_id, expires_at, created_at) VALUES (?, ?, ?, ?)")
        .run(tokenHash, userId, expiresAt, now);
    },
    getSession(tokenHash, now) {
      return db.prepare(`SELECT s.user_id, s.expires_at, u.email FROM auth_sessions s
        JOIN users u ON u.id = s.user_id WHERE s.token_hash = ? AND s.expires_at > ?`).get(tokenHash, now) ?? null;
    },
    deleteSession(tokenHash) {
      db.prepare("DELETE FROM auth_sessions WHERE token_hash = ?").run(tokenHash);
    },
    getMembership(userId, organizationId) {
      return db.prepare(`SELECT m.role, o.id, o.name, o.plan FROM organization_memberships m
        JOIN organizations o ON o.id = m.organization_id
        WHERE m.user_id = ? AND m.organization_id = ?`).get(userId, organizationId) ?? null;
    },
    /** Operator/billing use only (npm run plan); no HTTP route changes a plan. */
    setOrganizationPlan(organizationId, plan) {
      return db.prepare("UPDATE organizations SET plan = ? WHERE id = ?").run(plan, organizationId).changes > 0;
    },
    getOrganization(organizationId) {
      return db.prepare("SELECT id, name, plan FROM organizations WHERE id = ?").get(organizationId) ?? null;
    },
    createInvitation({ tokenHash, organizationId, createdByUserId, expiresAt, now }) {
      db.prepare(`INSERT INTO organization_invitations
        (token_hash, organization_id, created_by_user_id, expires_at, created_at)
        VALUES (?, ?, ?, ?, ?)`).run(tokenHash, organizationId, createdByUserId, expiresAt, now);
    },
    listOrganizationMembers(organizationId) {
      return db.prepare(`SELECT u.id, u.email, m.role, m.created_at AS joined_at
        FROM organization_memberships m JOIN users u ON u.id = m.user_id
        WHERE m.organization_id = ? ORDER BY CASE m.role WHEN 'owner' THEN 0 ELSE 1 END, u.email`).all(organizationId);
    },
    removeOrganizationMember({ actorUserId, organizationId, targetUserId }) {
      db.exec("BEGIN IMMEDIATE");
      try {
        const actor = db.prepare("SELECT role FROM organization_memberships WHERE user_id = ? AND organization_id = ?")
          .get(actorUserId, organizationId);
        const target = db.prepare("SELECT role FROM organization_memberships WHERE user_id = ? AND organization_id = ?")
          .get(targetUserId, organizationId);
        if (actor?.role !== "owner" || target?.role !== "member" || actorUserId === targetUserId) {
          db.exec("ROLLBACK");
          return false;
        }
        db.prepare("DELETE FROM organization_memberships WHERE user_id = ? AND organization_id = ? AND role = 'member'")
          .run(targetUserId, organizationId);
        db.prepare("DELETE FROM auth_sessions WHERE user_id = ?").run(targetUserId);
        const remainingMemberships = db.prepare("SELECT 1 FROM organization_memberships WHERE user_id = ? LIMIT 1").get(targetUserId);
        if (!remainingMemberships) db.prepare("DELETE FROM users WHERE id = ?").run(targetUserId);
        db.exec("COMMIT");
        return true;
      } catch (error) {
        db.exec("ROLLBACK");
        throw error;
      }
    },
    deleteUserSessions(userId) {
      return db.prepare("DELETE FROM auth_sessions WHERE user_id = ?").run(userId).changes;
    },
    consumeRateLimit({ keyHash, now, windowMs, maxAttempts }) {
      db.exec("BEGIN IMMEDIATE");
      try {
        const current = db.prepare("SELECT window_started_at, attempts, blocked_until FROM auth_rate_limits WHERE key_hash = ?").get(keyHash);
        if (current && current.window_started_at + windowMs > now && current.attempts >= maxAttempts) {
          db.exec("COMMIT");
          return { allowed: false, retryAfterSeconds: Math.max(1, Math.ceil((current.blocked_until - now) / 1000)) };
        }
        const windowStartedAt = current && current.window_started_at + windowMs > now ? current.window_started_at : now;
        const attempts = current && current.window_started_at + windowMs > now ? current.attempts + 1 : 1;
        const blockedUntil = windowStartedAt + windowMs;
        db.prepare(`INSERT INTO auth_rate_limits (key_hash, window_started_at, attempts, blocked_until)
          VALUES (?, ?, ?, ?) ON CONFLICT(key_hash) DO UPDATE SET
          window_started_at = excluded.window_started_at, attempts = excluded.attempts, blocked_until = excluded.blocked_until`)
          .run(keyHash, windowStartedAt, attempts, blockedUntil);
        db.prepare("DELETE FROM auth_rate_limits WHERE blocked_until < ? - 86400000").run(now);
        db.exec("COMMIT");
        return { allowed: true, retryAfterSeconds: 0 };
      } catch (error) {
        db.exec("ROLLBACK");
        throw error;
      }
    },
  };

  const ads = {
    /** kind is "impression" or "click"; adds one to that day's counter. */
    async record({ adId, placement, day, kind }) {
      const column = kind === "click" ? "clicks" : "impressions";
      db.prepare(`INSERT INTO ad_daily_stats (ad_id, placement, day, ${column}) VALUES (?, ?, ?, 1)
        ON CONFLICT (ad_id, placement, day) DO UPDATE SET ${column} = ${column} + 1`).run(adId, placement, day);
    },
    async stats({ fromDay = "0000-00-00", toDay = "9999-99-99" } = {}) {
      return db.prepare(`SELECT ad_id AS adId, placement, day, impressions, clicks FROM ad_daily_stats
        WHERE day >= ? AND day <= ? ORDER BY day, ad_id, placement`).all(fromDay, toDay).map((row) => ({ ...row }));
    },
  };

  return {
    auth,
    ads,
    async list(organizationId) {
      return db.prepare("SELECT id FROM events WHERE organization_id = ? ORDER BY created_at, rowid").all(organizationId).map(({ id }) => get(organizationId, id));
    },
    async get(organizationId, id) { return get(organizationId, id); },
    async create(organizationId, fields) {
      const now = new Date().toISOString();
      const event = { id: randomUUID(), organizationId, ...fields, createdAt: now, updatedAt: now, decisions: [] };
      insertEventRecord(event);
      return get(organizationId, event.id);
    },
    async update(organizationId, id, fields) {
      const current = get(organizationId, id);
      if (!current) return null;
      const updatedAt = new Date().toISOString();
      db.prepare(`UPDATE events SET name=?, venue=?, venue_address=?, latitude=?, longitude=?,
        backup_venue_name=?, backup_venue_address=?, backup_venue_latitude=?, backup_venue_longitude=?,
        participant_count=?, event_date=?, event_time=?, event_type=?, sensitivity=?, updated_at=? WHERE id=? AND organization_id=?`)
        .run(fields.name, fields.venue, fields.venueAddress ?? "", fields.latitude, fields.longitude,
          fields.backupVenue?.name ?? null, fields.backupVenue?.address ?? null,
          fields.backupVenue?.latitude ?? null, fields.backupVenue?.longitude ?? null,
          fields.participantCount ?? 0, fields.date, fields.time, fields.type, fields.sensitivity, updatedAt, id, organizationId);
      return get(organizationId, id);
    },
    async addDecision(organizationId, id, decision) {
      const event = get(organizationId, id);
      if (!event) return null;
      const notification = decision.testNotification;
      db.exec("BEGIN IMMEDIATE");
      try {
        db.prepare("INSERT INTO event_decisions (id, event_id, action, reason, label, decided_at) VALUES (?, ?, ?, ?, ?, ?)")
          .run(decision.id, id, decision.action, decision.reason, decision.label, decision.decidedAt);
        db.prepare(`INSERT INTO notification_previews (decision_id, mode, status, generated_at, intended_recipient_count, title, message)
          VALUES (?, ?, ?, ?, ?, ?, ?)`)
          .run(decision.id, notification.mode, notification.status, notification.generatedAt,
            notification.intendedRecipientCount, notification.title, notification.message);
        db.prepare("UPDATE events SET updated_at = ? WHERE id = ? AND organization_id = ?").run(decision.decidedAt, id, organizationId);
        db.exec("COMMIT");
      } catch (error) {
        db.exec("ROLLBACK");
        throw error;
      }
      return get(organizationId, id);
    },
    async listDecisions(organizationId, id) {
      if (!selectEvent.get(id, organizationId)) return null;
      return decisionsFor(id);
    },
    async delete(organizationId, id) {
      return db.prepare("DELETE FROM events WHERE id = ? AND organization_id = ?").run(id, organizationId).changes > 0;
    },
    close() {
      if (closed) return;
      db.close();
      closed = true;
    },
  };
}

