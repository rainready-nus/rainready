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
    CREATE TABLE IF NOT EXISTS events (
      id TEXT PRIMARY KEY,
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
  `);
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

  const selectEvent = db.prepare("SELECT * FROM events WHERE id = ?");
  const selectDecisions = db.prepare(`
    SELECT d.*, n.mode, n.status, n.generated_at, n.intended_recipient_count, n.title, n.message
    FROM event_decisions d LEFT JOIN notification_previews n ON n.decision_id = d.id
    WHERE d.event_id = ? ORDER BY d.decided_at, d.rowid
  `);
  const insertEvent = db.prepare(`
    INSERT INTO events (id, name, venue, venue_address, latitude, longitude,
      backup_venue_name, backup_venue_address, backup_venue_latitude, backup_venue_longitude,
      participant_count, event_date, event_time, event_type, sensitivity, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
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
  const get = (id) => eventFromRow(selectEvent.get(id), decisionsFor(id));

  function insertEventRecord(event) {
    insertEvent.run(
      event.id, event.name, event.venue, event.venueAddress ?? "", event.latitude, event.longitude,
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
        if (!event?.id || selectEvent.get(event.id)) continue;
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

  return {
    async list() {
      return db.prepare("SELECT id FROM events ORDER BY created_at, rowid").all().map(({ id }) => get(id));
    },
    async get(id) { return get(id); },
    async create(fields) {
      const now = new Date().toISOString();
      const event = { id: randomUUID(), ...fields, createdAt: now, updatedAt: now, decisions: [] };
      insertEventRecord(event);
      return get(event.id);
    },
    async update(id, fields) {
      const current = get(id);
      if (!current) return null;
      const updatedAt = new Date().toISOString();
      db.prepare(`UPDATE events SET name=?, venue=?, venue_address=?, latitude=?, longitude=?,
        backup_venue_name=?, backup_venue_address=?, backup_venue_latitude=?, backup_venue_longitude=?,
        participant_count=?, event_date=?, event_time=?, event_type=?, sensitivity=?, updated_at=? WHERE id=?`)
        .run(fields.name, fields.venue, fields.venueAddress ?? "", fields.latitude, fields.longitude,
          fields.backupVenue?.name ?? null, fields.backupVenue?.address ?? null,
          fields.backupVenue?.latitude ?? null, fields.backupVenue?.longitude ?? null,
          fields.participantCount ?? 0, fields.date, fields.time, fields.type, fields.sensitivity, updatedAt, id);
      return get(id);
    },
    async addDecision(id, decision) {
      const event = get(id);
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
        db.prepare("UPDATE events SET updated_at = ? WHERE id = ?").run(decision.decidedAt, id);
        db.exec("COMMIT");
      } catch (error) {
        db.exec("ROLLBACK");
        throw error;
      }
      return get(id);
    },
    async listDecisions(id) {
      if (!selectEvent.get(id)) return null;
      return decisionsFor(id);
    },
    async delete(id) {
      return db.prepare("DELETE FROM events WHERE id = ?").run(id).changes > 0;
    },
    close() {
      if (closed) return;
      db.close();
      closed = true;
    },
  };
}

