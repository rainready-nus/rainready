# RainReady implementation handoff

Last updated: 10 October 2026

## Purpose

This document hands over the current local RainReady prototype, with emphasis on the work assigned to Member 1 (frontend) and Member 3 (weather data and risk algorithm). It describes what is implemented, how to run and verify it, and what remains outside the current milestone.

## Current status

The repository contains a runnable local web application with a browser frontend and a Node.js backend. The core organiser journey is implemented:

1. Create an account or sign in to an organisation workspace.
2. Create or edit an outdoor event.
3. Search and select a Singapore venue through OneMap, or use a visibly labelled demo venue when OneMap is unavailable.
4. Retrieve live NEA weather, rainfall, lightning-observation and 24-hour PSI data.
5. Review an explainable routine weather score and a separate air-quality advisory.
6. Confirm the demo lightning-alert override when demonstrating the stop-and-shelter path.
7. Record an organiser decision and generate a test-only notification preview.

Local event, decision, account and organisation data are stored in an ignored SQLite database. This is a course prototype and is intentionally bound to `127.0.0.1`; it is not production-ready or deployed to AWS.

## Member 1 — frontend delivery

Implemented in `frontend/index.html`:

- responsive single-page organiser dashboard;
- sign-in, account creation and organisation context;
- overview cards and event list;
- create/edit event form with validation;
- OneMap place/address search and explicit result selection;
- main and backup venue coordinates saved through the backend;
- labelled demo-venue fallback;
- live-risk result display with source freshness and component explanations;
- separate PSI advisory display;
- demo lightning-alert confirmation control;
- organiser decision form, history and test notification preview;
- loading, empty and error states needed for the core flow.

The demonstration sequence and recommended screenshots are documented in `docs/user-flow.md`.

## Member 3 — data and risk delivery

Implemented across `backend/weather-data.mjs`, `backend/risk-engine.mjs` and `backend/risk-assessment.mjs`:

- retrieval and normalisation of NEA forecast, rainfall, lightning-observation and 24-hour PSI feeds;
- freshness metadata and graceful handling of unavailable readings;
- routine weather component mappings for forecast, precipitation and event sensitivity;
- exclusion of historical probability until suitable event-matched data exist;
- renormalisation across the available routine components rather than treating missing data as zero risk;
- risk bands and an explainable component breakdown;
- separate nearest-region 24-hour PSI advisory following the documented prototype mapping;
- separate organiser-confirmed lightning override that returns a stop-and-shelter result;
- no automatic event resumption after an alert is cleared.

The preliminary formula was `R = 0.50F + 0.20P + 0.15H + 0.15S`. Because validated historical probability `H` is not available, the implemented routine score excludes `H` and renormalises the remaining available weights. The exact request/response contract and assumptions are in `docs/api-contract.md` and `docs/data-sources.md`.

## OneMap integration and automatic token renewal

`backend/geocoding.mjs` performs OneMap search on the server, so credentials and tokens are never returned to the browser.

Create a local `.env` from `.env.example` and configure one of these options:

```dotenv
# Preferred for automatic renewal
ONEMAP_API_EMAIL=your_registered_email
ONEMAP_API_PASSWORD=your_password

# Optional alternative: a manually obtained current token
ONEMAP_ACCESS_TOKEN=
```

When email and password are configured, the backend obtains a token on demand, caches it in server memory, and refreshes it before use when expiry metadata is available. If OneMap rejects a search for authentication, the backend invalidates the cached token, obtains a new one and retries the search once.

Never commit `.env`, credentials, access tokens, local SQLite files or screenshots containing secrets. These paths are ignored by Git. If the OneMap password changes, update the local `.env` and restart the server.

## Run locally

Requirements: Node.js 24.15 or later. The project has no npm package dependencies.

```sh
git clone https://github.com/rainready-nus/rainready.git
cd rainready
copy .env.example .env
npm start
```

Open `http://127.0.0.1:8787`. On first use, select **Create account**. Passwords must contain at least 12 characters.

Run the automated suite with:

```sh
npm test
```

At handoff, all 49 automated tests pass. The OneMap credential-based authentication path was also checked against the live service and returned search matches. Because external data changes over time, repeat the live check before a assessed demonstration.

## Manual acceptance check

Use synthetic data and do not expose real credentials in screenshots.

1. Start the app and create or sign in to a local account.
2. Select **Add event**.
3. Search for a Singapore location and select one OneMap result; verify that its address and coordinates appear in the form.
4. Complete all required event fields and save; verify that the event appears on the dashboard.
5. Select **Check live risk**; verify that routine components, source timestamps and the separate PSI advisory are shown.
6. Select **Confirm demo alert**, check risk again, and verify the stop-and-shelter override.
7. Record a decision with a reason; verify it appears in history and that the notification preview is labelled `TEST MODE` and `NOT SENT`.
8. Run `npm test` and confirm the suite passes.

## Important safety and scope boundaries

- Routine score mappings and bands are project assumptions, not official NEA thresholds or a safety guarantee.
- The PSI result is a separate planning advisory and is not included in the routine weather score or presented as medical advice.
- Lightning observations are context only, not an official warning or all-clear.
- The lightning override requires an explicit organiser-confirmed demo alert.
- Organisers remain responsible for decisions; the application never automatically resumes an activity.
- OneMap results must be reviewed by the organiser before coordinates are saved.
- Authentication and SQLite persistence are suitable only for a loopback-bound course prototype.
- No real participant contact data are stored; only an aggregate participant count is used.

## Remaining work

The following items are future work and must not be described as completed:

- AWS deployment and an accessible cloud URL;
- Amazon Cognito or another production identity provider;
- RDS PostgreSQL migration, encryption, backups and restore testing;
- API Gateway/WAF, distributed throttling and production monitoring;
- live email, SMS or push delivery;
- validated historical event-probability data for component `H`;
- production security, privacy and operational review;
- formal user evaluation and final report evidence.

The repository intentionally rejects `RAINREADY_PUBLIC_DEPLOYMENT=true` because the required production controls are not yet implemented.

## File map

- `frontend/index.html` — complete browser interface and frontend behaviour.
- `backend/server.mjs` — local HTTP API and static-file entry point.
- `backend/geocoding.mjs` — OneMap search and automatic authentication/token refresh.
- `backend/weather-data.mjs` — NEA data retrieval and normalisation.
- `backend/risk-engine.mjs` — routine score calculations and risk bands.
- `backend/risk-assessment.mjs` — assessment composition, PSI advisory and lightning override.
- `backend/*.test.mjs` — automated unit and integration tests.
- `docs/api-contract.md` — API endpoints, payloads and behaviour.
- `docs/data-sources.md` — data-source and algorithm assumptions.
- `docs/user-flow.md` — demonstration and screenshot sequence.
- `.env.example` — placeholder-only local configuration template.

## Handoff checklist

- [ ] Pull the handoff branch and run `npm test`.
- [ ] Create a private local `.env`; do not share it in chat or commit it.
- [ ] Verify OneMap search shortly before the demonstration.
- [ ] Capture screenshots using synthetic event data.
- [ ] Keep all prototype/safety qualifications in the report and presentation.
- [ ] Review the remaining-work list before assigning the next milestone.
