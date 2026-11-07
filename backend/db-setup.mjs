/**
 * One-time database setup from inside the app, so the AWS demo needs no tunnel and no psql.
 *
 *   RAINREADY_DB_SETUP=true                 turn it on (remove it again once /health says "done")
 *   RAINREADY_DB_ADMIN_USER                 RDS master user, default rainready_admin
 *   RAINREADY_DB_ADMIN_PASSWORD             RDS master password (from the RDS-managed secret)
 *   RAINREADY_DB_PASSWORD                   the password to give rainready_app (the app's own login)
 *   RAINREADY_DB_HOST / _PORT / _NAME / _SSL / _SSL_CA   as for the app
 *
 * What it does, as the master user:
 *   - empty database: creates the role, schema, row-level security and reference data
 *     (database/postgres/rds/00_roles.sql and init/01-03) in ONE transaction;
 *   - existing database: applies the migrations that are missing (001-004);
 *   - always: sets rainready_app's password to RAINREADY_DB_PASSWORD.
 * Until the database can be reached (for example before its security group allows the app),
 * it retries every 20 seconds and reports why on /health. The master password is only used
 * here; the app itself always connects as rainready_app.
 */
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const sql = (relative) => readFileSync(path.join(root, "database", "postgres", relative), "utf8");
/** psql-only lines (\set, \echo, \if, ... \gset) are not SQL; the transaction lines stay. */
export const stripPsqlCommands = (text) => text.split(/\r?\n/).filter((line) => !line.trimStart().startsWith("\\") && !line.includes("\\gset")).join("\n");

const CONNECTION_ERRORS = new Set(["ECONNREFUSED", "ETIMEDOUT", "ENOTFOUND", "EHOSTUNREACH", "ECONNRESET", "EAI_AGAIN", "57P03"]);

export function setupRequested(environment = process.env) {
  return String(environment.RAINREADY_DB_SETUP ?? "").toLowerCase() === "true";
}

export function setupConfigFromEnv(environment, sslFromEnvironment) {
  const missing = ["RAINREADY_DB_ADMIN_PASSWORD", "RAINREADY_DB_PASSWORD"].filter((name) => !environment[name]);
  if (missing.length) throw new Error(`RAINREADY_DB_SETUP=true needs ${missing.join(" and ")}`);
  if (String(environment.RAINREADY_DB_PASSWORD).length < 16) throw new Error("RAINREADY_DB_PASSWORD must be at least 16 characters");
  return {
    connection: {
      host: environment.RAINREADY_DB_HOST || "127.0.0.1",
      port: Number(environment.RAINREADY_DB_PORT || 5432),
      database: environment.RAINREADY_DB_NAME || "rainready",
      user: environment.RAINREADY_DB_ADMIN_USER || "rainready_admin",
      password: environment.RAINREADY_DB_ADMIN_PASSWORD,
      ssl: sslFromEnvironment(environment),
      connectionTimeoutMillis: 10_000,
    },
    appPassword: String(environment.RAINREADY_DB_PASSWORD),
  };
}

/** Database names the setup may create: plain lower-case identifiers only. */
const DATABASE_NAME = /^[a-z_][a-z0-9_]{0,62}$/;

/**
 * Connects as the master user. If the database itself is missing (RDS created without an
 * "Initial database name"), creates it from the built-in "postgres" database first.
 */
async function connectCreatingDatabase(pg, connection, done) {
  const client = new pg.Client(connection);
  try {
    await client.connect();
    return client;
  } catch (error) {
    await client.end().catch(() => {});
    if (error.code !== "3D000" || connection.database === "postgres") throw error; // 3D000: database does not exist
    if (!DATABASE_NAME.test(connection.database)) throw new Error(`RAINREADY_DB_NAME "${connection.database}" must be lower-case letters, digits or underscores`);
    const maintenance = new pg.Client({ ...connection, database: "postgres" });
    await maintenance.connect();
    try {
      await maintenance.query(`CREATE DATABASE "${connection.database}"`);
    } catch (createError) {
      if (createError.code !== "42P04") throw createError; // 42P04: created meanwhile by another task
    } finally {
      await maintenance.end().catch(() => {});
    }
    done.push(`created the database ${connection.database}`);
    const retry = new pg.Client(connection);
    await retry.connect();
    return retry;
  }
}

/** Runs the setup once. Returns a short description of what was done. */
export async function setupDatabase({ connection, appPassword }) {
  const { default: pg } = await import("pg");
  const done = [];
  const client = await connectCreatingDatabase(pg, connection, done);
  try {
    const hasEvents = (await client.query("SELECT to_regclass('public.events') IS NOT NULL AS present")).rows[0].present;
    if (!hasEvents) {
      await client.query("BEGIN");
      try {
        for (const file of ["rds/00_roles.sql", "init/01_schema.sql", "init/02_security.sql", "init/03_reference_data.sql"]) {
          await client.query(sql(file));
        }
        await client.query("COMMIT");
      } catch (error) {
        await client.query("ROLLBACK").catch(() => {});
        throw error;
      }
      done.push("created the schema");
    } else {
      // Older databases: each migration is safe to run again; 004 only when its tables are missing.
      for (const file of ["001_events_near_date_index.sql", "002_ad_daily_stats.sql", "003_organization_plan.sql"]) {
        await client.query(stripPsqlCommands(sql(`migrations/${file}`)));
      }
      const has004 = (await client.query("SELECT to_regclass('public.event_join_links') IS NOT NULL AS present")).rows[0].present;
      if (!has004) {
        await client.query(stripPsqlCommands(sql("migrations/004_participants_billing.sql")));
        done.push("applied migrations 001-004");
      } else {
        done.push("checked migrations 001-004");
      }
    }
    await client.query(`ALTER ROLE rainready_app WITH LOGIN PASSWORD ${client.escapeLiteral(appPassword)}`);
    done.push("set the rainready_app password");
    return done.join(", ");
  } finally {
    await client.end().catch(() => {});
  }
}

/**
 * Starts the setup in the background and keeps a status for /health:
 * not_requested | waiting | running | done | failed.
 */
export function startDatabaseSetup(environment, sslFromEnvironment, { retryMs = 20_000, maxWaitMs = 60 * 60 * 1000, log = console } = {}) {
  const state = { status: "not_requested", message: "" };
  if (!setupRequested(environment)) return state;
  let config;
  try {
    config = setupConfigFromEnv(environment, sslFromEnvironment);
  } catch (error) {
    Object.assign(state, { status: "failed", message: error.message });
    log.error(`Database setup: ${error.message}`);
    return state;
  }
  const started = Date.now();
  const attempt = async () => {
    Object.assign(state, { status: "running", message: "Setting up the database" });
    try {
      const summary = await setupDatabase(config);
      Object.assign(state, { status: "done", message: `Database ready: ${summary}. Remove RAINREADY_DB_SETUP and RAINREADY_DB_ADMIN_PASSWORD from the service now.` });
      log.log(`Database setup: ${state.message}`);
    } catch (error) {
      const unreachable = CONNECTION_ERRORS.has(error.code) || /timeout|connect/i.test(String(error.message));
      if (unreachable && Date.now() - started < maxWaitMs) {
        Object.assign(state, { status: "waiting", message: `Cannot reach the database yet (${error.code ?? error.message}). Check that the database's security group allows the app on port 5432. Retrying every ${Math.round(retryMs / 1000)} seconds.` });
        log.error(`Database setup: ${state.message}`);
        setTimeout(attempt, retryMs).unref?.();
        return;
      }
      Object.assign(state, { status: "failed", message: `Database setup failed: ${String(error.message).slice(0, 300)}` });
      log.error(state.message);
    }
  };
  setTimeout(attempt, 0).unref?.();
  return state;
}
