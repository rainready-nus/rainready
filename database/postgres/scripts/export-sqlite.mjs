#!/usr/bin/env node
/**
 * Export the local RainReady SQLite database to a PostgreSQL load script.
 *
 *   npm run db:export                                   # default paths
 *   node database/postgres/scripts/export-sqlite.mjs [sqliteFile] [outputSqlFile]
 *
 * - Opens the SQLite file READ-ONLY; it is never modified.
 * - Uses only Node built-ins (node:sqlite), like the rest of the project.
 * - Writes one transaction with ON CONFLICT DO NOTHING, so loading it twice is harmless.
 * - Skips auth_sessions and auth_rate_limits: they are short-lived, and everyone simply
 *   signs in again after the switch.
 * - Fills organization_id on decisions and previews from their event.
 *
 * The output contains password hashes and invitation hashes. The default output path is
 * inside backend/data/, which .gitignore already excludes. Do not commit or share it.
 */
import { DatabaseSync } from "node:sqlite";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";

const input = path.resolve(process.argv[2] ?? process.env.RAINREADY_DB_FILE ?? "backend/data/rainready.sqlite");
const output = path.resolve(process.argv[3] ?? "backend/data/postgres-import.sql");
const BATCH = 500;

if (!existsSync(input)) {
  console.error(`SQLite database not found: ${input}\nStart the app once (npm start) or pass the path as the first argument.`);
  process.exit(1);
}

const db = new DatabaseSync(input, { readOnly: true });
const hasTable = (name) => Boolean(db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?").get(name));

const literal = (value) => {
  if (value === null || value === undefined) return "NULL";
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new RangeError(`cannot export non-finite number ${value}`);
    return String(value);
  }
  if (typeof value === "bigint") return value.toString();
  return `'${String(value).replaceAll("'", "''")}'`;
};

// [target table, columns, SQLite query returning exactly those columns in order]
const exports = [
  ["organizations", ["id", "name", "created_at"],
    "SELECT id, name, created_at FROM organizations ORDER BY created_at, id"],
  ["users", ["id", "email", "password_hash", "created_at"],
    "SELECT id, email, password_hash, created_at FROM users ORDER BY created_at, id"],
  ["organization_memberships", ["user_id", "organization_id", "role", "created_at"],
    "SELECT user_id, organization_id, role, created_at FROM organization_memberships ORDER BY created_at"],
  ["organization_invitations", ["token_hash", "organization_id", "created_by_user_id", "expires_at", "used_at", "created_at"],
    "SELECT token_hash, organization_id, created_by_user_id, expires_at, used_at, created_at FROM organization_invitations ORDER BY created_at"],
  ["events", ["id", "organization_id", "name", "venue", "venue_address", "latitude", "longitude",
    "backup_venue_name", "backup_venue_address", "backup_venue_latitude", "backup_venue_longitude",
    "participant_count", "event_date", "event_time", "event_type", "sensitivity", "created_at", "updated_at"],
    `SELECT id, organization_id, name, venue, venue_address, latitude, longitude,
            backup_venue_name, backup_venue_address, backup_venue_latitude, backup_venue_longitude,
            participant_count, event_date, event_time, event_type, sensitivity, created_at, updated_at
       FROM events ORDER BY created_at, rowid`],
  ["event_decisions", ["id", "organization_id", "event_id", "action", "reason", "label", "decided_at"],
    `SELECT d.id, e.organization_id, d.event_id, d.action, d.reason, d.label, d.decided_at
       FROM event_decisions d JOIN events e ON e.id = d.event_id
      ORDER BY d.decided_at, d.rowid`],
  ["notification_previews", ["decision_id", "organization_id", "mode", "status", "generated_at",
    "intended_recipient_count", "title", "message"],
    `SELECT n.decision_id, e.organization_id, n.mode, n.status, n.generated_at,
            n.intended_recipient_count, n.title, n.message
       FROM notification_previews n
       JOIN event_decisions d ON d.id = n.decision_id
       JOIN events e ON e.id = d.event_id
      ORDER BY n.generated_at`],
  ["legacy_imports", ["source_path", "imported_at", "imported_count"],
    "SELECT source_path, imported_at, imported_count FROM legacy_imports ORDER BY imported_at"],
];

const lines = [
  "-- RainReady SQLite -> PostgreSQL data load",
  `-- Source: ${path.basename(input)}   Generated: ${new Date().toISOString()}`,
  "-- Contains password and invitation hashes: keep private, never commit.",
  "\\set ON_ERROR_STOP on",
  "BEGIN;",
  "SELECT set_config('app.actor', 'sqlite-migration', true);",
];
const counts = [];

for (const [table, columns, query] of exports) {
  if (!hasTable(table)) { // table names are the same in SQLite and PostgreSQL
    lines.push(`-- ${table}: not present in this SQLite file, skipped`);
    counts.push([table, 0]);
    continue;
  }
  const rows = db.prepare(query).all();
  counts.push([table, rows.length]);
  lines.push("", `-- ${table}: ${rows.length} row(s)`);
  for (let start = 0; start < rows.length; start += BATCH) {
    const chunk = rows.slice(start, start + BATCH);
    const values = chunk.map((row) => `  (${columns.map((column) => literal(row[column])).join(", ")})`);
    lines.push(`INSERT INTO ${table} (${columns.join(", ")}) VALUES`, values.join(",\n"), "ON CONFLICT DO NOTHING;");
  }
}

// Orphans that the SQLite join could not place (should be zero; reported for review)
const orphanDecisions = hasTable("event_decisions")
  ? db.prepare("SELECT count(*) AS n FROM event_decisions d LEFT JOIN events e ON e.id = d.event_id WHERE e.id IS NULL").get().n
  : 0;

lines.push(
  "",
  "COMMIT;",
  "",
  "-- Row counts: PostgreSQL now vs. exported from SQLite",
  "SELECT t.table_name, t.exported_from_sqlite, t.rows_in_postgres FROM (VALUES",
  counts.map(([table, n]) => `  ('${table}', ${n}, (SELECT count(*) FROM ${table}))`).join(",\n"),
  ") AS t(table_name, exported_from_sqlite, rows_in_postgres);",
);

db.close();
mkdirSync(path.dirname(output), { recursive: true });
writeFileSync(output, `${lines.join("\n")}\n`, "utf8");

console.log(`Wrote ${output}`);
for (const [table, n] of counts) console.log(`  ${table.padEnd(26)} ${n}`);
if (orphanDecisions) console.warn(`  WARNING: ${orphanDecisions} decision(s) reference a missing event and were not exported.`);
console.log("Skipped by design: auth_sessions, auth_rate_limits (users sign in again).");
