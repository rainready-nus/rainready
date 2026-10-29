# RainReady PostgreSQL database

The PostgreSQL schema for RainReady, targeting **Amazon RDS for PostgreSQL 16**. It has the
same tables as the app's SQLite store (`backend/event-store.mjs`), plus the controls the
preliminary report calls for. The same SQL runs in two places:

- **Amazon RDS** (the target): applied with `rds/apply.sql` over a TLS connection.
- **Local Docker** (dev/test copy and on-premise baseline): applied automatically by `init/`
  on first start. The image (`postgis/postgis:16-3.4`) matches the RDS major version.

This folder sits outside `backend/` on purpose: the schema is applied to RDS by a person or a
migration step, not shipped inside the Node app, and `backend/data/` is ignored by Git. The
future PostgreSQL storage adapter (`event-store-pg.mjs`) does belong in `backend/`.

> **Status.** The app uses SQLite by default. Set `RAINREADY_DB_DRIVER=postgres` in the root
> `.env` to run it on this database instead (see "Connecting the backend" below).

## Files

| File | Purpose |
|---|---|
| `docker-compose.yml` | PostgreSQL 16 + PostGIS on `127.0.0.1` only |
| `.env.example` | Admin and app passwords, port (copy to `.env`) |
| `init/00_roles.sh` | Creates `rainready_app`, the least-privilege login for the backend |
| `init/01_schema.sql` | Tables mirroring SQLite + assessments, lightning alerts, data freshness, audit log, rules |
| `init/02_security.sql` | Row-level security per organisation + grants |
| `init/03_reference_data.sql` | Data sources with the freshness limits from `weather-data.mjs` |
| `rds/00_roles.sql` | RDS version of the role setup (the RDS master user is not a superuser) |
| `rds/apply.sql` | Applies roles + `init/*.sql` to RDS in one transaction |
| `scripts/export-sqlite.mjs` | Read-only export of your SQLite data to a PostgreSQL load script |
| `tests/tenant_isolation.sql` | 6 cross-tenant checks, run as the app role |
| `tests/safety_rules.sql` | 7 checks: lightning hold, append-only history, risk bands, audit |
| `tests/events_near.sql` | 6 checks: `events_near()` returns the right events by place, time and organisation |
| `tests/explain_events_near.sql` | Loads 20,000 synthetic events, prints the query plans, rolls back (report evidence) |
| `migrations/*.sql` | Updates for databases created before a schema change; run once, in number order (002 adds `ad_daily_stats`, 003 adds `organizations.plan`, 004 adds participants, participant notifications and billing) |

Files in `init/` run once, in name order, the first time the container starts with an empty volume.

## How SQLite maps to PostgreSQL

| SQLite (`event-store.mjs`) | PostgreSQL | Change |
|---|---|---|
| `organizations` | same columns, incl. `plan` | the app role may UPDATE only the `plan` column (`npm run plan`, later billing) |
| `users`, `organization_memberships`, `auth_sessions`, `auth_rate_limits`, `organization_invitations`, `legacy_imports` | same names and columns | text timestamps become `timestamptz`; email is `citext` (case-insensitive like `COLLATE NOCASE`) |
| `events` | same columns | `event_date` is `date`, `event_time` is `time`; new generated `location` (PostGIS) |
| `event_decisions` | same columns | + `organization_id`, optional `decided_by_user_id`, `assessment_id`; append-only |
| `notification_previews` | same columns | + `organization_id`; still `mode='test'`, `status='not_sent'`; append-only |
| — | `risk_assessments` | new: stores `/api/assessment` output; bands checked against `risk-engine.mjs` |
| — | `lightning_alerts` | new: organiser-confirmed alert / all-clear; `continue` is refused while an alert is in force |
| — | `data_sources`, `weather_snapshots`, `source_freshness` view | new: source time + retrieval time per fetch, current/stale/unavailable |
| — | `audit_log` | new: decisions, alerts and event deletions, append-only |
| `ad_daily_stats` | same columns | `day` is `date`; counts only, so no row-level security; app role has no DELETE |
| `event_join_links`, `event_participants`, `participant_notifications`, `notification_deliveries` | same columns | row-level security per organisation; email is `citext`; public join/unsubscribe pages go through the `join_link_target()` / `unsubscribe_target()` functions, which return one row for one exact token |
| `billing_subscriptions`, `billing_webhook_events` | same columns | not under row-level security (the payment webhook has no organisation context), like `organizations` |

Participant data stays a count only, matching the app's privacy scope.

## Apply to Amazon RDS (needs approval; creates billable resources)

Create a private RDS for PostgreSQL 16 instance with initial database `rainready` and master
user `rainready_admin`, then connect through a tunnel (the team setup guide has every click).
With the PostgreSQL 16 client tools on your PATH, in PowerShell:

```powershell
$env:PGHOST = "localhost"; $env:PGPORT = "15432"            # SSM port-forwarding tunnel
$env:PGUSER = "rainready_admin"; $env:PGDATABASE = "rainready"
$env:PGSSLMODE = "verify-ca"; $env:PGSSLROOTCERT = "$HOME\.rds\global-bundle.pem"
cd database\postgres
psql -f rds/apply.sql
psql -c "\password rainready_app"
psql -f tests/tenant_isolation.sql
psql -f tests/safety_rules.sql
psql -f tests/events_near.sql
```

## Run it locally (needs approval)

From the repository root in PowerShell, with Docker Desktop running:

```powershell
cd database\postgres
Copy-Item .env.example .env        # then edit both passwords
docker compose up -d
docker compose logs -f db          # wait for "database system is ready to accept connections", Ctrl+C
docker compose exec db psql -U rainready_admin -d rainready -f /tests/tenant_isolation.sql
docker compose exec db psql -U rainready_admin -d rainready -f /tests/safety_rules.sql
docker compose exec db psql -U rainready_admin -d rainready -f /tests/events_near.sql
```

Copy existing SQLite data across (stop `npm start` first):

```powershell
cd ..\..                            # repository root
npm run db:export                   # writes backend\data\postgres-import.sql (git-ignored)
cd database\postgres
docker compose cp ..\..\backend\data\postgres-import.sql db:/tmp/import.sql
docker compose exec db psql -U rainready_admin -d rainready -f /tmp/import.sql
docker compose exec db rm /tmp/import.sql
```

The export opens SQLite read-only and the load is one transaction, so a failure leaves PostgreSQL unchanged.

## Finding affected events without scanning

When a new observation arrives (a rainfall reading or a lightning strike), `events_near(lat, lon,
radius_m, from, lookahead)` returns only the upcoming events within `radius_m` of it, starting
between 6 hours before `from` and `lookahead` after it (24 hours by default). Both conditions can
use an index, so PostgreSQL does not read every stored event:

| Condition | Index |
|---|---|
| Within the radius (`ST_DWithin` on `events.location`) | GiST `idx_events_location` |
| Event date in the window | B-tree `idx_events_date` |
| Organisation (row-level security) | `idx_events_organization_created` |

The exact start time is then checked on the few rows that remain. To see the plans:

```powershell
docker compose exec db psql -U rainready_admin -d rainready -f /tests/explain_events_near.sql
```

## Schema updates (migrations)

`init/` runs only on a brand-new database. When the schema changes later, the change is also
added as a numbered file in `migrations/` so existing databases can be updated without losing data.
Run each new file once, in number order:

```powershell
docker compose up -d     # once, so the container sees the migrations folder
docker compose exec db psql -U rainready_admin -d rainready -f /migrations/001_events_near_date_index.sql
docker compose exec db psql -U rainready_admin -d rainready -f /migrations/002_ad_daily_stats.sql
docker compose exec db psql -U rainready_admin -d rainready -f /migrations/003_organization_plan.sql
docker compose exec db psql -U rainready_admin -d rainready -f /migrations/004_participants_billing.sql
```

For RDS: run `migrations/001_events_near_date_index.sql`, `002_ad_daily_stats.sql`, `003_organization_plan.sql` and `004_participants_billing.sql` with `psql -f`, in that order, with the connection settings above.

## Connecting the backend

`backend/event-store-pg.mjs` is the PostgreSQL storage adapter. It has the same interface as
the SQLite store, connects as `rainready_app`, and runs each event query in a transaction that
sets `app.organization_id`, so row-level security applies. To use it:

1. `npm install pg` in the repository root.
2. In the root `.env`: `RAINREADY_DB_DRIVER=postgres` and the `RAINREADY_DB_*` settings from
   `.env.example` (`RAINREADY_DB_PASSWORD` = `APP_DB_PASSWORD` from this folder's `.env`).
3. `npm test` (normal suite; PostgreSQL tests skipped), then `npm run test:pg`.
4. `npm start` and use the app; data now goes to PostgreSQL.

For RDS, point `RAINREADY_DB_HOST`/`RAINREADY_DB_PORT` at the tunnel and set
`RAINREADY_DB_SSL=verify-ca` with `RAINREADY_DB_SSL_CA` set to the RDS certificate bundle.
