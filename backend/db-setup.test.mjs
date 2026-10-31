import test from "node:test";
import assert from "node:assert/strict";
import { setupConfigFromEnv, setupRequested, startDatabaseSetup, stripPsqlCommands } from "./db-setup.mjs";

const ssl = () => false;

test("database setup is off unless RAINREADY_DB_SETUP=true", () => {
  assert.equal(setupRequested({}), false);
  assert.equal(setupRequested({ RAINREADY_DB_SETUP: "TRUE" }), true);
  assert.deepEqual(startDatabaseSetup({}, ssl), { status: "not_requested", message: "" });
});

test("setup needs the admin password and a long app password", () => {
  assert.throws(() => setupConfigFromEnv({ RAINREADY_DB_PASSWORD: "x".repeat(20) }, ssl), /RAINREADY_DB_ADMIN_PASSWORD/);
  assert.throws(() => setupConfigFromEnv({ RAINREADY_DB_ADMIN_PASSWORD: "a", RAINREADY_DB_PASSWORD: "short" }, ssl), /16 characters/);
  const config = setupConfigFromEnv({ RAINREADY_DB_ADMIN_PASSWORD: "admin", RAINREADY_DB_PASSWORD: "x".repeat(20), RAINREADY_DB_HOST: "db.example" }, ssl);
  assert.equal(config.connection.user, "rainready_admin");
  assert.equal(config.connection.host, "db.example");
  const failed = startDatabaseSetup({ RAINREADY_DB_SETUP: "true" }, ssl, { log: { error() {}, log() {} } });
  assert.equal(failed.status, "failed");
});

test("psql-only lines are removed from migration files", () => {
  const text = "\\set ON_ERROR_STOP on\nSELECT 1 AS x \\gset\n\\if :x\n\\q\n\\endif\nBEGIN;\nCREATE TABLE t (id int);\nCOMMIT;\n\\echo 'done'";
  assert.equal(stripPsqlCommands(text), "BEGIN;\nCREATE TABLE t (id int);\nCOMMIT;");
});
