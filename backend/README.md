# RainReady backend prototype

`auth.mjs` creates local password hashes, HttpOnly sessions and one-time organisation invitations. `event-store.mjs` stores memberships and session metadata, and scopes all event queries by organisation. `event-service.mjs` requires an explicit organisation context before event operations. `weather-data.mjs` fetches and normalises NEA real-time feeds. `geocoding.mjs` calls the OneMap Search API from the backend and normalises selectable venue matches. `risk-assessment.mjs` maps current readings and organiser-selected event sensitivity into an explainable prototype assessment. `server.mjs` exposes these through HTTP.

## Run and test

Requires Node.js 24.15 or later for built-in `node:sqlite`. From the repository root:

```sh
npm start
npm test
```

The local server listens on `127.0.0.1:8787` by default. Set `PORT` to use another port. New accounts require passwords of at least 12 characters. Registration creates a private organisation; an owner can invite members with one-time codes that expire after seven days. The server returns `401` without a valid session and checks the requested `X-RainReady-Organization` against that user's membership on every private API request. Organisation-scoped event operations return `404` for records in another organisation. No NEA API key is required by this local prototype. To enable `GET /api/geocode`, copy `.env.example` to `.env` and set `ONEMAP_ACCESS_TOKEN`. The search token is sent only from the backend to OneMap and expires after three days; update it when expired. Without the token, the rest of the service remains available and geocoding returns HTTP 503.

## Persistence and data scope

Events, decisions and test-notification previews are stored in `backend/data/rainready.sqlite` by default. Existing `backend/data/events.json` is imported once at startup if present and left unchanged as a recovery copy. `RAINREADY_DB_FILE` selects another SQLite path; `RAINREADY_LEGACY_DATA_FILE` selects the legacy import source (set it to an empty/non-existent path to disable import). Database files and WAL sidecars are ignored by Git.

The schema separates users, organisations, memberships, sessions, invitations, events, decisions and notification previews. Session tokens and invitation codes are stored as SHA-256 hashes; passwords are stored as scrypt hashes; session cookies are `HttpOnly` and `SameSite=Strict`. A notification preview is constrained to `mode=test` and `status=not_sent`. The prototype stores only a participant count and does not store participant contact data. SQLite is for a single-machine, single-process course prototype; it is not encrypted, backed up, or ready for multi-instance production deployment.

## Secrets and cloud migration

Commit code and placeholder configuration only. Keep `.env`, OneMap tokens, passwords, AWS credentials, private keys, SQLite files and real participant personal data out of GitHub. The local auth implementation has no account recovery, email verification, MFA, production TLS configuration, or external-identity integration; it must remain on loopback and must not be exposed publicly or deployed to AWS. Before a cloud deployment, use a managed identity provider such as Cognito, verify access tokens in the backend, provision organisation memberships, add account recovery/MFA as required, and complete a security review. Use AWS Secrets Manager for runtime tokens, accessed by a least-privilege Lambda execution role. For CI/CD, prefer GitHub Actions OIDC role federation and narrowly scoped permissions rather than long-lived access keys. Authenticate team members through the course AWS IAM Identity Center flow. These cloud integrations are not implemented yet.

The future cloud storage option is Amazon RDS for PostgreSQL, to be evaluated when deployment begins. The current local SQLite store is behind a small storage interface so the service layer can be retained while replacing the persistence adapter. See [`../docs/api-contract.md`](../docs/api-contract.md).

Risk mappings and bands are experimental project assumptions, not official NEA thresholds. Historical probability is excluded until validated. Lightning observations are context only, not an official warning or all-clear.

