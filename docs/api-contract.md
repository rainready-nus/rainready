# Local API contract (implemented prototype)

The dependency-free local Node.js server currently implements `GET /health` and `GET /api/weather`. Event records, authentication, persistence and automated risk assessments remain future work. All timestamps should be ISO 8601; displayed Singapore times use `Asia/Singapore`.

## `GET /health`

Returns service status and prototype version.

```json
{
  "status": "ok",
  "version": "0.1.0",
  "checkedAt": "2026-10-06T10:00:00+08:00"
}
```

## `GET /api/weather?latitude={lat}&longitude={lon}`

Fetches and normalises the NEA two-hour forecast, rainfall and lightning-observation feeds for the requested location. Latitude and longitude are required numeric query parameters. The local server caches the most recent successful response from each feed in memory and labels fallback data as stale.

The response contains `retrievedAt`, the requested `location`, and a `sources` object. Each source includes normalised `data`, `freshness` (`current`, `stale`, or `unavailable`), and an optional `error`. Forecast and rainfall include nearest-area/station distance; lightning includes observation locations and distances. A lightning feed with no returned observations does not prove there is no lightning.

Invalid/missing coordinates return HTTP 400. Unhandled upstream errors return HTTP 502. Individual source failures are isolated in a successful snapshot response, so the UI can display partial data.

The prototype frontend calls this same-origin endpoint when the organiser presses **Check live weather**. Venue coordinates are entered manually; OneMap geocoding is not implemented yet.

## Planned event endpoints (not implemented)

`GET /events`, `POST /events`, `GET /events/{eventId}/assessment`, and `POST /events/{eventId}/decisions` remain future work. Event records currently stay in browser local storage.

## `GET /events/{eventId}/assessment`

The eventual assessment endpoint should return component explanations, source timestamps, and freshness state.

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

## `POST /events/{eventId}/decisions`

Records an organiser decision (`continue`, `prepare`, `relocate`, `postpone`, `cancel`, or `stop_and_shelter`) with actor, timestamp, and optional note. The audit trail must preserve the decision and must not infer that an event has resumed after a lightning warning.

## Safety and data notes

- The current NEA lightning observation feed is observational context, not an official warning or all-clear. Do not use absence of returned observations to infer safety. Any future official warning integration should be a separate safety override, with explicit source attribution and no automatic resumption.
- The risk score and thresholds are prototype assumptions, not official NEA thresholds or guarantees of safety.
- Historical datasets are for later calibration/evaluation, not a substitute for current official alerts.
- API failures must be visible to users; retain the last valid reading only with its original timestamp and a stale-data label.
