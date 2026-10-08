# RainReady backend prototype

`weather-data.mjs` fetches and normalises NEA real-time feeds. `risk-assessment.mjs` maps current readings and organiser-selected event sensitivity into an explainable prototype assessment. `server.mjs` exposes these through HTTP. `event-service.mjs` owns input validation and event/decision rules; `event-store.mjs` is the SQLite persistence adapter.

## Run and test

Requires Node.js 24.15 or later for built-in `node:sqlite`. From the repository root:

```sh
npm start
npm test
```

The local server listens on `127.0.0.1:8787` by default. Set `PORT` to use another port. No NEA API key is required by this local prototype.

## Persistence and data scope

Events, decisions and test-notification previews are stored in `backend/data/rainready.sqlite` by default. Existing `backend/data/events.json` is imported once at startup if present and left unchanged as a recovery copy. `RAINREADY_DB_FILE` selects another SQLite path; `RAINREADY_LEGACY_DATA_FILE` selects the legacy import source (set it to an empty/non-existent path to disable import). Database files and WAL sidecars are ignored by Git.

The schema separates events, decisions and notification previews with foreign keys and cascading deletion. A notification preview is constrained to `mode=test` and `status=not_sent`. The prototype stores only a participant count and does not store participant contact data. SQLite is for a single-machine, single-process course prototype; it is not encrypted, backed up, or ready for multi-instance production deployment.

## Secrets and cloud migration

Commit code and placeholder configuration only. Keep `.env`, OneMap tokens, passwords, AWS credentials, private keys, SQLite files and real participant personal data out of GitHub. Use AWS Secrets Manager for runtime tokens, accessed by a least-privilege Lambda execution role. For CI/CD, prefer GitHub Actions OIDC role federation and narrowly scoped permissions rather than long-lived access keys. Authenticate team members through the course AWS IAM Identity Center flow. These cloud integrations are not implemented yet.

The future cloud storage option is Amazon RDS for PostgreSQL, to be evaluated when deployment begins. The current local SQLite store is behind a small storage interface so the service layer can be retained while replacing the persistence adapter. See [`../docs/api-contract.md`](../docs/api-contract.md).

Risk mappings and bands are experimental project assumptions, not official NEA thresholds. Historical probability is excluded until validated. Lightning observations are context only, not an official warning or all-clear.

