# RainReady backend prototype

`auth.mjs` creates local password hashes, HttpOnly sessions and one-time organisation invitations. `event-store.mjs` stores memberships, sessions and SQLite-backed local auth throttles, scopes every event query by organisation, and supports owner member management. Removing a member also invalidates their sessions. `event-service.mjs` requires an explicit organisation context before event operations. `weather-data.mjs` fetches and normalises NEA forecast, rainfall, lightning-observation and 24-hour PSI feeds. `geocoding.mjs` calls the OneMap Search API from the backend and normalises selectable venue matches. `risk-assessment.mjs` maps current readings and organiser-selected event sensitivity into an explainable routine score, emits a separate PSI advisory, and accepts an explicit organiser-confirmed demo lightning override. `server.mjs` exposes these through HTTP and intentionally refuses startup when `RAINREADY_PUBLIC_DEPLOYMENT=true`.

## Run and test

Requires Node.js 24.15 or later for built-in `node:sqlite`. From the repository root:

```sh
npm start
npm test
```

The local server listens on `127.0.0.1:8787` by default. Set `PORT` to use another port. New accounts require passwords of at least 12 characters. Registration creates a private organisation; an owner can invite members with one-time codes that expire after seven days. The server returns `401` without a valid session and checks the requested `X-RainReady-Organization` against that user's membership on every private API request. Organisation-scoped event operations return `404` for records in another organisation. No NEA API key is required by this local prototype. To enable `GET /api/geocode`, copy `.env.example` to `.env` and configure either `ONEMAP_ACCESS_TOKEN` or both `ONEMAP_API_EMAIL` and `ONEMAP_API_PASSWORD`. With credentials, the backend obtains a token on demand, caches it in memory, and refreshes/retries once when a search reports an expired token. OneMap secrets are never sent to the browser. Without either configuration, the rest of the service and predefined demo venues remain available, while geocoding returns HTTP 503.

## Persistence and data scope

Events, decisions and test-notification previews are stored in `backend/data/rainready.sqlite` by default. Existing `backend/data/events.json` is imported once at startup if present and left unchanged as a recovery copy. `RAINREADY_DB_FILE` selects another SQLite path; `RAINREADY_LEGACY_DATA_FILE` selects the legacy import source (set it to an empty/non-existent path to disable import). Database files and WAL sidecars are ignored by Git.

The schema separates users, organisations, memberships, sessions, invitations, events, decisions and notification previews. Session tokens and invitation codes are stored as SHA-256 hashes; passwords are stored as scrypt hashes; session cookies are `HttpOnly` and `SameSite=Strict`. A notification preview is constrained to `mode=test` and `status=not_sent`. The prototype stores only a participant count and does not store participant contact data. SQLite is for a single-machine, single-process course prototype; it is not encrypted, backed up, or ready for multi-instance production deployment.

## Secrets and cloud migration

Commit code and placeholder configuration only. Keep `.env`, OneMap tokens, passwords, AWS credentials, private keys, SQLite files and real participant personal data out of GitHub. The local auth implementation has no account recovery, email verification, MFA, production TLS configuration, distributed rate limiting, or external-identity integration; it must remain on loopback and must not be exposed publicly or deployed to AWS. `RAINREADY_ALLOWED_ORIGINS` accepts a comma-separated exact-origin allowlist for local tests; `RAINREADY_REQUIRE_ORIGIN=true` rejects state-changing requests without an Origin header. Before a cloud deployment, use a managed identity provider such as Cognito, verify access tokens in the backend, provision organisation memberships, put the API behind a managed edge/WAF, use private RDS PostgreSQL with encryption/backups/restore testing, add monitoring and complete a security review. Use AWS Secrets Manager for runtime tokens, accessed by a least-privilege application role. For CI/CD, prefer GitHub Actions OIDC role federation and narrowly scoped permissions rather than long-lived access keys. Authenticate team members through the course AWS IAM Identity Center flow. These cloud integrations are not implemented yet.

The future cloud storage option is Amazon RDS for PostgreSQL, to be evaluated when deployment begins. The current local SQLite store is behind a small storage interface so the service layer can be retained while replacing the persistence adapter. See [`../docs/api-contract.md`](../docs/api-contract.md).

Risk mappings and bands are experimental project assumptions, not official NEA thresholds. Historical probability is excluded until validated. Lightning observations are context only, not an official warning or all-clear.


## PostgreSQL storage (optional)

`event-store-pg.mjs` implements the same storage interface against PostgreSQL (schema in `database/postgres/`). Set `RAINREADY_DB_DRIVER=postgres` and the `RAINREADY_DB_*` connection settings in `.env` (see `.env.example`), then `npm start`. The adapter connects as the least-privilege `rainready_app` role and runs every event query in a transaction that sets `app.organization_id`, so PostgreSQL row-level security enforces the organisation boundary as well as the application checks. `auth.mjs` and `server.mjs` await every store call, so both the synchronous SQLite store and the asynchronous PostgreSQL store work. The `pg` package is loaded only when the PostgreSQL driver is selected; the default SQLite setup still has no npm dependencies at runtime. `npm test` runs the usual suite and skips the PostgreSQL tests; `npm run test:pg` runs `event-store-pg.test.mjs` against the configured database. The PostgreSQL store does not import `backend/data/events.json`; use `npm run db:export` to copy SQLite data across.
