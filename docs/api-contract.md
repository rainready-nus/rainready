# Local API contract (implemented prototype)

The dependency-free local Node.js server currently implements `GET /health`, `GET /api/geocode`, `GET /api/weather`, `GET /api/assessment`, event CRUD, and organiser-decision endpoints. Event records, decisions and test-notification previews persist in local SQLite; authentication and managed cloud persistence remain future work. All timestamps should be ISO 8601; displayed Singapore times use `Asia/Singapore`.

## `GET /health`

Returns service status and prototype version.

```json
{
  "status": "ok",
  "version": "0.5.0",
  "checkedAt": "2026-10-06T10:00:00+08:00"
}
```

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

Fetches and normalises the NEA two-hour forecast, rainfall and lightning-observation feeds for the requested location. Latitude and longitude are required numeric query parameters. The local server caches the most recent successful response from each feed in memory and labels fallback data as stale.

The response contains `retrievedAt`, the requested `location`, and a `sources` object. Each source includes normalised `data`, `freshness` (`current`, `stale`, or `unavailable`), and an optional `error`. Forecast and rainfall include nearest-area/station distance; lightning includes observation locations and distances. A lightning feed with no returned observations does not prove there is no lightning.

Invalid/missing coordinates return HTTP 400. Unhandled upstream errors return HTTP 502. Individual source failures are isolated in a successful snapshot response, so the UI can display partial data.

The prototype frontend calls this same-origin endpoint as part of **Check live risk**. Event venue coordinates are stored after manual review of a selected OneMap search result; weather requests still consume coordinates from the event record.

## `GET /api/assessment?latitude={lat}&longitude={lon}&sensitivity={low|medium|high}`

Fetches the same source snapshot and adds an `assessment` object. Forecast severity, the nearest station's latest five-minute total rainfall, and event sensitivity are mapped to 0–100 inputs. The [NEA rainfall dataset](https://data.gov.sg/datasets/d_6580738cdd7db79374ed3152159fbd69/view) describes precipitation at weather-station level and updates every five minutes; the score mapping is a RainReady assumption, not an NEA hazard threshold.

Base component weights are forecast 0.50, rainfall 0.20, historical probability 0.15, and sensitivity 0.15. Historical probability is currently `null` and excluded because no validated event-matched value is available. Missing inputs are excluded and remaining weights are renormalised; the response exposes the effective weights, component reasons, and `excludedComponents`. If the forecast is unavailable, no numeric score is returned and manual review is required. If rainfall is unavailable, the score is marked partial.

This risk mapping is an experimental course-project heuristic, not a guarantee of safety or official NEA advice. Lightning observations remain separate context and are never interpreted as an official warning or all-clear.

## Event endpoints (implemented locally)

All event routes use the `/api` prefix. `GET /api/events` returns `{ "events": [...] }`; `POST /api/events` validates and creates an event, returning HTTP 201 and `{ "event": ... }`. `GET /api/events/{eventId}` retrieves one event. `PATCH /api/events/{eventId}` validates and updates supplied fields while retaining omitted fields. `DELETE /api/events/{eventId}` deletes it. Unknown event IDs return HTTP 404; invalid input returns HTTP 400.

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

