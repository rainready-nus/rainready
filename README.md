# RainReady

RainReady is a course-project cloud-service prototype for helping organisers monitor weather risks across outdoor events, record decisions, and prepare participant updates.

## Current prototype

The browser interface calls a local Node.js backend. The backend retrieves NEA short-range and 24-hour forecasts, the four-day daily outlook, rainfall, lightning-observation and 24-hour PSI data. Near-term checks match the saved event start to a currently published precise forecast period. For events 2–4 days ahead without that coverage, RainReady provides a clearly labelled, rough daily planning estimate from the NEA forecast description, forecast high temperature and event sensitivity, with activity-aware preparation suggestions. It is not a venue/time-specific risk score or calibrated probability; current rainfall, historical probability and future PSI are excluded, numeric wind severity is not scored without a validated unit, and backup venues are not compared at this horizon. Beyond the four-day horizon, it says no official forecast is available yet. Primary and backup venues are compared only for the same current, precise forecast window. OneMap address search lets organisers find and explicitly select main and backup venue locations; coordinates are returned and stored by the backend flow, not typed by the organiser. Historical probability is excluded until validated.

The prototype supports:

- creating, viewing, editing and deleting events, including main/backup venue coordinates, date/time, activity sensitivity and participant count;
- persistent SQLite storage for events, organiser decisions and test-notification previews;
- email/password sign-in, organisation workspaces, and owner-generated one-time invitations for teammates;
- server-enforced organisation isolation for event lists, details, edits, decisions, deletes, weather checks and location search;
- recording a decision (continue, prepare, relocate, postpone or cancel), required reason and timestamp;
- generating a test-only notification preview marked `not_sent`—no email/SMS/push message is sent and no participant contact details are collected;
- retrieving an event-start forecast, displaying freshness, explaining the routine risk score, comparing main/backup venue weather scores only for the exact same current forecast window, and presenting a separate NEA-aligned PSI advisory;
- showing a provisional daily planning estimate for 2–4-day events from forecast description, forecast high temperature and event sensitivity, plus tailored preparation suggestions; clearly labels the Singapore-wide daily scope, excludes future PSI and live rainfall, does not score numeric wind without a validated unit, and does not compare venues;
- applying a backend stop-and-shelter override when an organiser explicitly confirms the local demo lightning alert, without treating the observation feed as an official warning or automatically resuming an activity;
- searching OneMap by Singapore place name/address, reviewing matching addresses and confirming a result before saving its coordinates;
- showing one clearly labelled sponsored message (ad) at the bottom of each workspace page for the Free plan, with aggregated impression and click counts for reporting (see below).

**Safety and scope:** the event-time forecast only covers the event's scheduled start, not its full duration. NEA's 24-hour forecast is regional and its venue-region assignment is an approximation using representative region points; the feed covers currently published periods, not arbitrary future dates. If a period does not cover the start, no score is returned. Primary/backup comparison is a weather-score heuristic only and does not validate access, capacity, shelter, suitability, availability, official safety instructions or full-duration conditions. Routine risk mappings and bands are experimental RainReady assumptions, not official NEA thresholds or a safety guarantee. Current rainfall and historical probability are excluded from event-time scoring; remaining forecast/sensitivity weights are renormalised. The air-quality path reports the nearest region's official 24-hour PSI and follows NEA health-advisory bands, but it is not medical advice and is not folded into the routine weather score. Lightning observations are not an official warning or all-clear; the separate organiser-confirmed alert is an explicit local demo input. Organisers remain responsible for decisions, and the system never auto-resumes an activity. OneMap search is an address-to-coordinate lookup only; organisers must verify the selected result. Authentication is a local course-prototype implementation, not production-hardened identity infrastructure; do not expose it publicly or deploy it to AWS. AWS Cognito, verified email/account recovery/MFA, distributed rate limiting, production monitoring, cloud storage controls and security review are not implemented.

## Run locally

Requires Node.js **24.15 or later** (the project uses the built-in `node:sqlite` module; use the same Node version across the team). No npm package dependencies are required.

```sh
npm start
npm test
```

Open `http://127.0.0.1:8787`. The API binds to loopback for local development. On first launch, choose **Create account** and create a workspace; account passwords must be at least 12 characters. The workspace owner can privately share a one-time invitation code, view members, and remove a member (which revokes all that user's sessions). Any signed-in user can use **Sign out all devices** to revoke every session on their account. Members join through **Create account** using the invitation code. Accounts, sessions and rate-limit counters are stored in the local ignored SQLite database. To enable address search, copy `.env.example` to `.env`. Either set a current `ONEMAP_ACCESS_TOKEN`, or set both `ONEMAP_API_EMAIL` and `ONEMAP_API_PASSWORD` so the backend can generate a token and automatically refresh/retry once when OneMap rejects an expired token. Generated tokens are cached in server memory and are never returned to the browser. OneMap documents a three-day token lifetime. Keep all OneMap values only in the ignored local `.env` or a managed secret store, never in frontend code or GitHub. Without a token or credentials, event weather functions and predefined demo venues still work, while live address searches return a clear setup message. Do not add actual credentials to `.env.example`.

## Sponsored messages (ads)

The Free plan of the freemium model shows **one text-only sponsored message at the bottom of each workspace page** (Overview, Events, Decision history, Settings). It is designed not to get in the way:

- it sits below all page content and is never shown inside dialogs or forms, on the sign-in screen, or between events; nothing pops up, moves, auto-plays or covers the page;
- it is labelled **Sponsored**, names the sponsor, and shows the destination site; links open in a new tab with `rel="sponsored noopener noreferrer"`;
- it **pauses while a lightning alert is confirmed or any upcoming event is at critical risk**, so safety information always has the organiser's full attention;
- **only a paid plan removes ads.** Every organisation has a plan (`free`, `community` or `enterprise`; new organisations start on `free`). The server checks the selected organisation's plan on each ad request, so there is no browser setting or API call that hides ads; the **Remove ads** link in the slot explains the paid plans. Settings › Workspace shows the plan and ad status;
- no third-party ad script, cookie or tracking pixel is loaded. Ads come from the RainReady backend's own catalogue (`backend/ads-catalogue.json`). Selection is contextual only: the page, and whether an upcoming event needs a wet-weather plan.

The backend counts an **impression** when at least half of the slot has been visible for one second (once per ad and page per visit) and a **click** when the link is followed. Counts are stored per ad, placement and Singapore day in `ad_daily_stats`, with no user, organisation or event identifier. `npm run ads:report` prints impressions, clicks and click-through rate for the last 30 days (or `npm run ads:report -- 2026-11-01 2026-11-30`).

Settings: `RAINREADY_ADS=house` (default) or `off`; `RAINREADY_ADS_FILE` points to another catalogue. The demo catalogue uses fictional sponsors and `example.com` links only. Replace it with real, approved sponsor messages before any public launch, and check that each message meets the Singapore Code of Advertising Practice and PDPA requirements. `RAINREADY_ADS=off` is an operator switch for the whole server (for example a demo without ads), not a user setting.

**Changing a plan.** There is no payment integration yet, so an operator changes the plan from the command line, using the organisation ID shown in Settings › Workspace: `npm run plan -- <organizationId>` shows it and `npm run plan -- <organizationId> community` changes it (`free`, `community` or `enterprise`). Members see the change the next time they load the app. Later, a payment provider's webhook would call the same store method (`setOrganizationPlan`) after a successful payment. A PostgreSQL database created earlier needs `migrations/003_organization_plan.sql` once.

## Local data and migration

The default database is `backend/data/rainready.sqlite` and is ignored by Git. It stores local accounts, hashed sessions, organisation memberships, invitations, events, decisions, notification previews and aggregated ad counters. Every event row has an organisation ID; the backend verifies membership on each request before returning or changing it. On first start, the backend imports `backend/data/events.json` if it exists, records that the one-time import has completed, and leaves the JSON file untouched as a recovery copy. The first registered workspace takes ownership of imported legacy events. Set `RAINREADY_DB_FILE` and optionally `RAINREADY_LEGACY_DATA_FILE` to use other local paths. Back up the SQLite file before deleting or replacing local data.

SQLite here is for a single-machine prototype, not a hardened production database. It is not automatically encrypted or backed up. The app stores a participant **count only**, not names, emails, phone numbers or other participant personal data.

## PostgreSQL database (local baseline; app not switched yet)

[`database/postgres/`](database/postgres/README.md) holds a local PostgreSQL 16 + PostGIS database in Docker with the same tables as the SQLite store, plus row-level security per organisation, append-only decisions and previews, stored risk assessments, organiser-confirmed lightning alerts (no `continue` until an all-clear is recorded), data-source freshness and an audit log. `npm run db:export` copies existing SQLite data into a PostgreSQL load script without modifying the SQLite file. The backend still uses SQLite until a PostgreSQL storage adapter is added; the steps are listed in that folder's README. This is also the schema intended for RDS PostgreSQL later.

## Cloud deployment direction (not implemented; public mode is blocked)

The local app/database are not deployed. A likely AWS prototype architecture is a static frontend on S3 + CloudFront, an API on API Gateway + Lambda, and managed application storage on Amazon RDS for PostgreSQL. Production identity should move to Amazon Cognito (or another reviewed identity provider), with backend verification and server-side organisation membership checks. Scheduled ingestion/monitoring can be evaluated with EventBridge and CloudWatch. This is a future migration plan—not a claim that AWS resources or cloud persistence are already running. Confirm course-account permissions, quotas and cost before provisioning. The current local password/session implementation is not approved for public or AWS exposure. Setting `RAINREADY_PUBLIC_DEPLOYMENT=true` intentionally causes the local server to fail at startup; this is a guardrail, not a production mode switch.

Before any public release, the team must complete and verify all of these gates:

1. Integrate Cognito (or another approved managed identity provider); validate issuer, audience/client, signature, expiry and token use on every protected backend request. Move email verification, password reset and MFA policy to that provider; none is simulated by the local login screen.
2. Migrate SQLite to private RDS PostgreSQL. Put the database in private subnets, allow network access only from the application role/security group, require TLS, encrypt storage and snapshots with KMS, enable automated backups/point-in-time recovery, and perform a restore test. Define least-privilege application DB permissions.
3. Put the API behind API Gateway/WAF or an equivalent edge; configure exact HTTPS origins and secure cookies/headers, trusted-proxy handling, distributed throttling, request-size limits, alarms and redacted structured logs. The current database-backed throttle is only for one local process and is not a substitute for WAF/distributed limits.
4. Keep runtime credentials in Secrets Manager/approved parameter store and use least-privilege IAM roles. For CI/CD use GitHub OIDC with narrowly scoped roles; do not create long-lived AWS keys.
5. Review organization ownership, invitations, membership revocation, audit retention, privacy notice/data deletion, incident response, backup recovery, dependency/security scans and the complete user journey. Conduct a security review before enabling public traffic.

The local prototype now demonstrates owner-only member listing/invitations, member removal with session revocation, account-wide logout, strict optional origin allowlisting, and SQLite-persisted per-process login/register throttling. These do not make it production-ready. Email verification/recovery/MFA, Cognito, RDS, distributed rate limits/WAF, monitoring and recovery controls remain unimplemented and are release blockers.

Credential handling when deployment begins:

- Commit source code and placeholder configuration only. `.env`, local SQLite files, AWS credential files, keys and generated data are excluded by `.gitignore`.
- OneMap tokens and other runtime secrets belong in AWS Secrets Manager (or an approved parameter store) and should be retrieved by the backend using a narrowly scoped Lambda IAM execution role. Never put them in browser code, a GitHub commit, or a public issue.
- For GitHub Actions deployment, store only the specific CI/CD values as GitHub Actions Secrets/Variables, prefer short-lived AWS role federation (OIDC) over long-lived access keys, and scope permissions to the required deployment resources. Runtime application secrets should remain in AWS, not be copied into the workflow.
- Use the course-provided AWS IAM Identity Center sign-in/role flow for people; do not create, share, or commit personal passwords or long-lived AWS access keys.
- Do not upload real participant personal data. Keep prototype data synthetic and use only aggregate participant counts.

## Team workflow and status

Use short feature branches and Pull Requests; keep `main` runnable. Discuss API changes in [`docs/api-contract.md`](docs/api-contract.md) before frontend/backend work diverges. Event CRUD, SQLite local persistence, local login/organisation isolation, decisions, test previews and OneMap venue search are implemented. Cloud database migration, production identity integration, live notification delivery, full evaluation and AWS deployment remain future work.

For the current implementation status, local setup, verification steps and remaining-work boundaries, see [`docs/HANDOFF.md`](docs/HANDOFF.md).

