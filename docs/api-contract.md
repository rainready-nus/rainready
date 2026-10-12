# Local API contract (implemented prototype)

The dependency-free local Node.js server implements local authentication, organisation membership/invitations, `GET /health`, `GET /api/geocode`, `GET /api/weather`, `GET /api/assessment`, event CRUD, and organiser-decision endpoints. Event records, accounts, memberships, sessions, decisions and test-notification previews persist in local SQLite. This local identity implementation is for loopback course-prototype use only; production identity and managed cloud persistence remain future work. All timestamps should be ISO 8601; displayed Singapore times use `Asia/Singapore`.

## `GET /health`

Returns service status and prototype version.

```json
{
  "status": "ok",
  "version": "0.5.0",
  "checkedAt": "2026-10-06T10:00:00+08:00"
}
```

## Local authentication and organisations

- `POST /api/auth/register` accepts `{ "email", "password", "organizationName", "invitationCode?" }`. Passwords must contain 12–128 characters. With no invitation code, registration creates a new private organisation and the user is its owner. With a valid unexpired one-time invitation code, the user joins that organisation as a member; an organization name is then not required. Successful registration returns the user and memberships and sets a 12-hour `rainready_session` cookie.
- `POST /api/auth/login` accepts `{ "email", "password" }`. Credentials are checked with a generic failure response. Successful login rotates the session and sets the same cookie.
- `POST /api/auth/logout` deletes the current session and clears the cookie.
- `POST /api/auth/logout-all` revokes every active session for the signed-in account and clears the current cookie.
- `GET /api/auth/me` returns the current user and their organisation memberships, or HTTP 401.
- `POST /api/auth/invitations` requires a signed-in organisation owner and `X-RainReady-Organization`. It returns one invitation code, shown only once, which expires after seven days. Store only the SHA-256 hash of the code; the first successful registration consumes it.
- `GET /api/auth/members` requires an organisation owner and returns members of the selected organisation.
- `DELETE /api/auth/members/{userId}` removes a member from the selected organisation and revokes all of that member's sessions. Owners cannot be removed by this endpoint. If the member has no remaining organisation memberships, their account is deleted so they can later rejoin with a new invitation.

Passwords are salted scrypt hashes. Session tokens and invitation codes are high-entropy random values stored only as SHA-256 hashes. The session cookie is `HttpOnly; SameSite=Strict; Path=/` and receives `Secure` when the app is served over TLS or `RAINREADY_COOKIE_SECURE=true`. Authentication endpoints do not expose the password hash, session token or invitation hash. Login and registration attempts are tracked in SQLite and return `429` plus `Retry-After` when their per-source-IP limit is reached. The SQLite counter is only suitable for this single-process local prototype; it is not a distributed production rate limiter.

Every private API call must include the cookie and an `X-RainReady-Organization` header. The backend verifies that the cookie resolves to an unexpired session and that the user belongs to the selected organisation. A missing session returns HTTP 401; a missing organization returns HTTP 400; an organization the user does not belong to returns HTTP 403. Event lookups, updates, decision history and deletion are scoped in SQL by both event ID and organization ID; a cross-organisation event ID returns HTTP 404. The frontend's organization selector only chooses a requested context; it is not the security boundary.

`RAINREADY_ALLOWED_ORIGINS` can restrict state-changing browser requests to comma-separated exact origins; `RAINREADY_REQUIRE_ORIGIN=true` rejects mutation requests without an `Origin` header. Do not use wildcard origins. `RAINREADY_PUBLIC_DEPLOYMENT=true` deliberately makes `createServer()` fail closed while this local identity implementation is configured. The executable binds only to `127.0.0.1`.

This custom local authentication is **not production-ready**: there is no verified email, password reset/account recovery, MFA, Cognito or other managed identity, distributed rate limiting/WAF, security monitoring, trusted-proxy/TLS deployment configuration, or production cloud storage. Keep the server bound to loopback. Do not expose it to the internet or deploy it to AWS. Before cloud release, replace local account authentication with a managed identity provider (for example Cognito), verify access tokens in the backend, provision organisation membership securely, use private managed storage, and complete the release gates in the README and security review.

## `GET /api/geocode?query={place-or-address}`

Searches OneMap for a Singapore venue. `query` must contain 3–120 characters. The backend calls OneMap's Search API with `returnGeom=Y`, `getAddrDetails=Y`, and page 1, and returns up to eight usable matches as `{ name, address, latitude, longitude }`. The frontend displays each candidate and saves coordinates only after the organiser selects one. The same endpoint is used for a backup venue.

The server reads `ONEMAP_ACCESS_TOKEN` from its environment and forwards it in the upstream `Authorization` header. The credential never goes to the browser. `400` means invalid search text; `503 geocoding_not_configured` means the local token is absent; `502 geocoding_service_error` means OneMap did not return usable results or was unavailable. Empty results are returned as an empty array with HTTP 200. A OneMap token is required for Search API calls and expires after three days; operators must replace expired tokens. Do not log or return the token or raw upstream response.

Example response:

```json
{
  "query": "University Town",
  "results": [
    { "name": "UNIVERSITY TOWN", "address": "NUS, SINGAPORE", "latitude": 1.304, "longitude": 103.773 }
  ]
}
```

The UI requires selecting a returned candidate before creating or changing a venue. Existing saved coordinates are retained during edits unless the user starts a new search. This is address lookup, not an authoritative verification that an event is physically at the selected point; organisers must check the address and coordinates. See [OneMap Search API](https://www.onemap.gov.sg/apidocs/search) and [authentication](https://www.onemap.gov.sg/apidocs/authentication).

## `GET /api/weather?latitude={lat}&longitude={lon}`

Fetches and normalises the NEA two-hour forecast, rainfall, lightning-observation and 24-hour PSI feeds for the requested location. Latitude and longitude are required numeric query parameters. The local server caches the most recent successful response from each feed in memory and labels fallback data as stale.

The response contains `retrievedAt`, the requested `location`, and a `sources` object. Each source includes normalised `data`, `freshness` (`current`, `stale`, or `unavailable`), and an optional `error`. Forecast and rainfall include nearest-area/station distance; lightning includes observation locations and distances; air quality includes the nearest reporting region, 24-hour PSI and 24-hour PM2.5 reading. A lightning feed with no returned observations does not prove there is no lightning.

Invalid/missing coordinates return HTTP 400. Unhandled upstream errors return HTTP 502. Individual source failures are isolated in a successful snapshot response, so the UI can display partial data.

The prototype frontend calls this same-origin endpoint as part of **Check live risk**. Event venue coordinates are stored after manual review of a selected OneMap search result; weather requests still consume coordinates from the event record.

## `GET /api/assessment?latitude={lat}&longitude={lon}&sensitivity={low|medium|high}&lightningStatus={none|confirmed_alert}`

Fetches the same source snapshot and adds an `assessment` object. Forecast severity, the nearest station's latest five-minute total rainfall, and event sensitivity are mapped to 0–100 inputs. The [NEA rainfall dataset](https://data.gov.sg/datasets/d_6580738cdd7db79374ed3152159fbd69/view) describes precipitation at weather-station level and updates every five minutes; the score mapping is a RainReady assumption, not an NEA hazard threshold.

Base component weights are forecast 0.50, rainfall 0.20, historical probability 0.15, and sensitivity 0.15. Historical probability is currently `null` and excluded because no validated event-matched value is available. Missing inputs are excluded and remaining weights are renormalised; the response exposes the effective weights, component reasons, and `excludedComponents`. If the forecast is unavailable, no numeric score is returned and manual review is required. If rainfall is unavailable, the score is marked partial.

The response also includes a separate `airQuality` advisory derived from the nearest region's official 24-hour PSI. PSI is not added to the routine weather score. The advisory uses NEA bands: Good 0-50, Moderate 51-100, Unhealthy 101-200, Very Unhealthy 201-300 and Hazardous above 300, with separate advice for sensitive groups.

`lightningStatus` defaults to `none`. `confirmed_alert` is accepted only as an explicit organiser-confirmed local demo input and returns an `override` assessment with score 100 and `stop_and_shelter`. It does not infer an official alert from the NEA observation feed. Clearing the input never auto-resumes an activity; the organiser must reassess and record the decision.

The routine risk mapping is an experimental course-project heuristic, not a guarantee of safety or official NEA advice. Lightning observations remain separate context and are never interpreted as an official warning or all-clear.

## Event endpoints (implemented locally)

All event routes use the `/api` prefix and require a valid session plus `X-RainReady-Organization`. `GET /api/events` returns only the active organisation's `{ "events": [...] }`; `POST /api/events` validates and creates an event in that organisation, returning HTTP 201 and `{ "event": ... }`. `GET /api/events/{eventId}` retrieves one event only when it belongs to that organisation. `PATCH /api/events/{eventId}` validates and updates supplied fields while retaining omitted fields. `DELETE /api/events/{eventId}` deletes only within that organisation. Unknown or other-organisation event IDs return HTTP 404; invalid input returns HTTP 400.

An event contains `id`, `name`, `venue`, optional `venueAddress`, `latitude`, `longitude`, optional `backupVenue` (`name`, optional `address`, `latitude`, `longitude`), `participantCount`, `date` (`YYYY-MM-DD`), `time` (`HH:MM`), `type`, `sensitivity` (`low`, `medium`, or `high`), and ISO `createdAt` / `updatedAt` timestamps. Participant count must be a whole number from 0 to 100000; coordinates are range-checked. A backup venue must have both coordinates so that it can be assessed separately.

The default SQLite database is `backend/data/rainready.sqlite`; `RAINREADY_DB_FILE` can override its location. On first startup, if `backend/data/events.json` exists, it is imported once and preserved unchanged as a recovery copy. `RAINREADY_LEGACY_DATA_FILE` can select another legacy JSON source; point it to a non-existent path to disable import. The SQLite schema stores event data in `events`, organiser decision history in `event_decisions`, and test previews in `notification_previews`; foreign keys cascade decision/preview deletion with their event. `legacy_imports` records completed imports. The schema contains only participant count, not contact details or other participant personal data. This single-machine prototype database has no authentication, automatic encryption, or backup and is not for multi-instance production deployment. Cloud deployment should replace this adapter with secured managed storage such as the proposed RDS PostgreSQL option.

## Decision and notification-test endpoints

`POST /api/events/{eventId}/decisions` requires an `action` (`continue`, `prepare`, `relocate`, `postpone`, or `cancel`) and a non-empty `reason` of at most 1000 characters. A relocation decision is rejected unless the event has a backup venue. It saves the organiser decision, ISO timestamp, and a test-notification preview in the event's decision history, then returns HTTP 201 with `{ "decision", "event" }`. `GET /api/events/{eventId}/decisions` returns the saved `{ "decisions": [...] }`; event retrieval also includes its decision history.

Every preview is labelled `mode: "test"` and `status: "not_sent"`, with an intended participant count but no participant addresses. There is no email, SMS, push provider, or network-delivery code in this prototype. The interface states that the preview was not sent. A future live-notification feature must be designed and explicitly enabled separately.

## Local configuration and secret handling

The optional `.env.example` contains only placeholders and non-secret local defaults; copy it to the ignored `.env` file and set `ONEMAP_ACCESS_TOKEN` there to enable address search. `npm start` loads `.env`. Do not commit OneMap tokens, passwords, AWS credentials, private keys, or participant personal data. For a future AWS deployment, store runtime secrets in AWS Secrets Manager and grant the backend a least-privilege IAM execution role. For GitHub Actions deployment, prefer OIDC role federation and narrowly scoped GitHub Actions secrets/permissions rather than long-lived AWS keys.

## `GET /events/{eventId}/assessment`

The event-specific assessment endpoint is future work; the current assessment endpoint accepts venue coordinates directly. A future event-specific endpoint should return component explanations, source timestamps, and freshness state.

```json
{
  "eventId": "evt_demo_001",
  "riskScore": 62,
  "riskLevel": "high",
  "recommendedAction": "prepare_contingency",
  "reasons": ["Demo forecast indicates showers"],
  "sources": [{"name": "demo", "observedAt": "2026-10-06T10:00:00+08:00", "freshness": "demo"}],
  "lightningStatus": "none"
}
```

## Safety and data notes

- The current NEA lightning observation feed is observational context, not an official warning or all-clear. Do not use absence of returned observations to infer safety. Any future official warning integration should be a separate safety override, with explicit source attribution and no automatic resumption.
- The risk score and thresholds are prototype assumptions, not official NEA thresholds or guarantees of safety.
- Historical datasets are for later calibration/evaluation, not a substitute for current official alerts.
- API failures must be visible to users; retain the last valid reading only with its original timestamp and a stale-data label.

