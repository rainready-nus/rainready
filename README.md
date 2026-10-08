# RainReady

RainReady is a course-project cloud-service prototype for helping organisers monitor weather risks across outdoor events, record decisions, and prepare participant updates.

## Current prototype

The browser interface calls a local Node.js backend. The backend retrieves NEA forecast, rainfall and lightning-observation data and calculates an explainable prototype assessment for an event's coordinates and sensitivity. OneMap address search lets organisers find and explicitly select main and backup venue locations; coordinates are returned and stored by the backend flow, not typed by the organiser. Historical probability is excluded until validated.

The prototype supports:

- creating, viewing, editing and deleting events, including main/backup venue coordinates, date/time, activity sensitivity and participant count;
- persistent SQLite storage for events, organiser decisions and test-notification previews;
- recording a decision (continue, prepare, relocate, postpone or cancel), required reason and timestamp;
- generating a test-only notification preview marked `not_sent`—no email/SMS/push message is sent and no participant contact details are collected;
- retrieving current weather source readings, displaying freshness and explaining the risk assessment.
- searching OneMap by Singapore place name/address, reviewing matching addresses and confirming a result before saving its coordinates.

**Safety and scope:** risk mappings and bands are experimental RainReady assumptions, not official NEA thresholds or a safety guarantee. Historical probability is excluded. Lightning observations are not an official warning or all-clear; the separate alert simulation is not connected to NEA. Organisers remain responsible for decisions, and the system never auto-resumes an activity. OneMap search is an address-to-coordinate lookup only; organisers must verify the selected result. Authentication, real notifications and AWS deployment are not implemented yet.

## Run locally

Requires Node.js **24.15 or later** (the project uses the built-in `node:sqlite` module; use the same Node version across the team). No npm package dependencies are required.

```sh
npm start
npm test
```

Open `http://127.0.0.1:8787`. The API binds to loopback for local development. To enable address search, copy `.env.example` to `.env`, add your OneMap access token as `ONEMAP_ACCESS_TOKEN`, then run `npm start`; Node loads the local `.env` file. Register/sign in at [OneMap API](https://www.onemap.gov.sg/apidocs/) to obtain a token. OneMap documents a three-day token lifetime, so replace it after expiry; keep it only in the ignored local `.env` or a managed secret store, never in frontend code or GitHub. Without a token, event weather functions still work for saved locations, but new address searches return a clear setup message. Do not add actual credentials to `.env.example`.

## Local data and migration

The default database is `backend/data/rainready.sqlite` and is ignored by Git. On first start, the backend imports `backend/data/events.json` if it exists, records that the one-time import has completed, and leaves the JSON file untouched as a recovery copy. Set `RAINREADY_DB_FILE` and optionally `RAINREADY_LEGACY_DATA_FILE` to use other local paths. Back up the SQLite file before deleting or replacing local data.

SQLite here is for a single-machine prototype, not a hardened production database. It is not automatically encrypted or backed up. The app stores a participant **count only**, not names, emails, phone numbers or other participant personal data.

## Cloud deployment direction (not implemented)

The local app/database are not yet deployed. A likely AWS prototype architecture is a static frontend on S3 + CloudFront, an API on API Gateway + Lambda, and managed application storage on Amazon RDS for PostgreSQL. Scheduled ingestion/monitoring can be evaluated with EventBridge and CloudWatch. This is a future migration plan—not a claim that AWS resources or cloud persistence are already running. Confirm course-account permissions, quotas and cost before provisioning.

Credential handling when deployment begins:

- Commit source code and placeholder configuration only. `.env`, local SQLite files, AWS credential files, keys and generated data are excluded by `.gitignore`.
- OneMap tokens and other runtime secrets belong in AWS Secrets Manager (or an approved parameter store) and should be retrieved by the backend using a narrowly scoped Lambda IAM execution role. Never put them in browser code, a GitHub commit, or a public issue.
- For GitHub Actions deployment, store only the specific CI/CD values as GitHub Actions Secrets/Variables, prefer short-lived AWS role federation (OIDC) over long-lived access keys, and scope permissions to the required deployment resources. Runtime application secrets should remain in AWS, not be copied into the workflow.
- Use the course-provided AWS IAM Identity Center sign-in/role flow for people; do not create, share, or commit personal passwords or long-lived AWS access keys.
- Do not upload real participant personal data. Keep prototype data synthetic and use only aggregate participant counts.

## Team workflow and status

Use short feature branches and Pull Requests; keep `main` runnable. Discuss API changes in [`docs/api-contract.md`](docs/api-contract.md) before frontend/backend work diverges. Event CRUD, SQLite local persistence, decisions, test previews and OneMap venue search are implemented locally. Cloud database migration, authentication, live notification delivery, full evaluation and AWS deployment remain future work.

