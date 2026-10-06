# Initial API contract (proposal)

This is a coordination contract for the first implementation. It is not yet deployed. All timestamps should be ISO 8601 with an explicit timezone; Singapore events should use `Asia/Singapore`.

## `GET /health`

Returns service status and deployment version.

```json
{
  "status": "ok",
  "version": "0.1.0",
  "checkedAt": "2026-10-06T10:00:00+08:00"
}
```

## `GET /events`

Returns events visible to the current organiser. For the UI prototype, event data is local demo data; the API response is the intended shape.

## `POST /events`

Creates an event. Required fields: `name`, `venueName`, `latitude`, `longitude`, `startsAt`, `endsAt`, `activityType`, and `sensitivity` (`low`, `medium`, or `high`). Optional fields may include `backupVenue` and participant contact references. Do not store actual participant contact information until access control and data handling are agreed.

## `GET /events/{eventId}/assessment`

Returns the latest assessment, component explanations, source timestamps, and freshness state.

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

- An official lightning alert is a safety override, not an ordinary weighted risk input. Display the alert source and freshness, recommend stopping outdoor activity and seeking shelter according to the applicable institutional guidance, and require an explicit organiser action. Never auto-resume.
- The risk score and thresholds are prototype assumptions, not official NEA thresholds or guarantees of safety.
- Historical datasets are for later calibration/evaluation, not a substitute for current official alerts.
- API failures must be visible to users; retain the last valid reading only with its original timestamp and a stale-data label.
