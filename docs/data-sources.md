# RainReady Data Source Register

This document records the candidate data sources for the MVP. Published refresh intervals below come from the source pages; they are not guarantees of end-to-end delivery latency. Before coding an adapter, inspect the current API specification and save a redacted sample response in the repository. Never commit API keys, AWS credentials, or participant contact details.

## Live and reference data

| Source | MVP use | Published update cadence | Fields to verify in the current response | Access and status |
|---|---|---|---|---|
| [NEA 2-hour Weather Forecast](https://data.gov.sg/datasets/d_3f9e064e25005b0e42969944ccaf2e7a/view) | Near-term event forecast | Every 30 minutes | Area/forecast label, issue or valid time, response timestamp | data.gov.sg API; inspect the linked API specification to confirm the exact endpoint and schema before implementation. |
| [NEA 24-hour Weather Forecast](https://data.gov.sg/datasets/d_ce2eb1e307bda31993c533285834ef2b/view) | Same-day planning | Every 6 hours; ad-hoc updates may occur | Periods, forecast text, issue/valid time | Later MVP enhancement; same endpoint/schema verification required. |
| [NEA 4-day Weather Forecast](https://data.gov.sg/datasets/d_f131f6e343bf8168e4057a04c4326a0a/view) | Advance contingency planning | Every 12 hours | Forecast date/period and forecast text | Optional for first working prototype; same endpoint/schema verification required. |
| [NEA Rainfall across Singapore](https://data.gov.sg/datasets/d_6580738cdd7db79374ed3152159fbd69/view) | Current rainfall near an event | Every 5 minutes | Station ID/name, coordinates, reading value/unit, observation/update time | data.gov.sg API. Match an event to a nearby station and show the station and observation time; readings can have gaps or local siting effects. |
| [NEA Lightning Observation](https://data.gov.sg/datasets/d_08238953fe0f6dd13f10714ebfbcb9f9/view) | Time- and location-stamped lightning observation for safety context | Page says data is displayed at 2-minute intervals; dataset metadata labels the cadence “Ad-hoc”; transmission may lag by a few minutes | Event time, coordinates, strike category/type (if supplied), source/update time | Prioritise after verifying the live API specification and sample response. This is an observation feed, **not an official stop-work warning or all-clear**. NEA notes location uncertainty, possible missed/false detections, and data gaps. Do not auto-resume an event. |
| [NEA Pollutant Standards Index](https://data.gov.sg/datasets?formats=API&agencies=National+Environment+Agency+%28NEA%29) | Nearest-region 24-hour PSI and air-quality health-planning advisory | Latest regional reading; the adapter allows 90 minutes before marking it stale | Region metadata, observation/update time, 24-hour PSI, 24-hour PM2.5 | Implemented through the public `api-open.data.gov.sg/v2/real-time/api/psi` endpoint. RainReady applies the published NEA PSI bands and keeps this advisory separate from the routine weather score. |
| [OneMap Search API](https://www.onemap.gov.sg/apidocs/search) | Search a Singapore venue name/address; organiser selects the matching result to save its coordinates | On demand | Search value, returned address/name, latitude, longitude, result count | Implemented through backend `GET /api/geocode`. A static server-side token can be supplied, or local credentials can generate and refresh an in-memory token. OneMap documents a 3-day token lifetime. Search failure is shown to the user; it does not silently guess coordinates. |
| [NEA Historical Rainfall across Singapore (2024)](https://data.gov.sg/datasets/d_a0b69d3e02576a1fd0ab673e71f83507/view) | Optional historical context/calibration, not live monitoring | Static 2024 file; last updated 6 May 2025 | Timestamp (SGT), station/location, reading value/unit and quality/missingness | CSV is about 1.1 GB / 6.4 million rows. Do not put it in Git. Download only if needed, process a small relevant subset locally or in object storage, and disclose the source's missing-data/no-climate-quality-control disclaimer. Defer if it threatens MVP delivery. |

The data.gov.sg pages state that these APIs can be tested without an API key; an API key offers higher rate limits and priority support. Start with public access. If a key is later needed, request it deliberately and store it only in backend/AWS secret configuration, never in frontend code or Git.

## Polling and freshness policy

Poll no faster than the source's published cadence unless the API specification explicitly recommends otherwise: 2-hour forecast 30 min; 24-hour forecast 6 h; 4-day forecast 12 h; rainfall 5 min. Retrieve PSI on demand and retain its observation/update time; RainReady marks it stale after 90 minutes as a prototype display assumption. For lightning, first confirm the API spec and response behavior; if polling is supported, use the documented 2-minute display cadence as a starting point, while clearly showing the observation/source timestamp and measured retrieval time. Do not imply that polling more often makes the upstream data fresher.

Store both the source observation/update time and RainReady's retrieval time. Show a visible freshness state (Current, Delayed, or Unavailable) based on a documented threshold. When a request fails, retain the last successful response with its original timestamp and mark it stale; never silently present cached information as live. If no valid cached response exists, show “data unavailable” and avoid generating a confident weather-based recommendation. Keep manual organiser decisions available and record them separately from automated assessments.

## Safety and interpretation

- Normal weather risk is decision support, not an official warning or a guarantee that an activity is safe.
- Use “lightning observed near this event” only if the live fields and an explicitly chosen radius/time window support it. State the radius, time window, feed timestamp, and uncertainty in the UI.
- A lightning observation must not be labelled an “official lightning warning.” Any mandatory stop/shelter instruction must be tied to a separately verified institutional safety policy or a manually confirmed official warning. A human organiser records pause/resume decisions; the system never automatically resumes an event.
- Keep alert thresholds configurable and document them as project assumptions, not NEA standards.

## Validation checklist before implementation

- [ ] Open each linked dataset's current API specification; record the exact endpoint, HTTP method, required headers/query parameters, response schema, and licence.
- [ ] Make one test request per chosen source; save a small redacted JSON example and note the retrieval time. Do not save secrets or personal data.
- [ ] Verify timestamps/time zone, field units, missing/null values, and geographic/station matching behavior.
- [ ] Measure actual retrieval latency and failure behavior over several checks; distinguish this from the provider's published update interval.
- [ ] Confirm OneMap token setup and test address-match quality and expired-token handling.
- [ ] Decide whether historical rainfall is worth the storage/processing effort after the live forecast, rainfall, and lightning paths work.

## Official source notes

The source pages identify NEA as the agency for the weather, rainfall, lightning, and historical-rainfall datasets. The rainfall page warns that observations may have technical gaps, may later be corrected, and may be affected by local conditions. The lightning page describes the feed as MSS Lightning Detection System data and explicitly notes transmission delay, location error, possible missed/false detections, and gaps. The historical rainfall page says its records may be missing and are not quality-controlled for official climate use. OneMap Search requires a valid authorization token; see the [Search API](https://www.onemap.gov.sg/apidocs/search) and [token authentication documentation](https://www.onemap.gov.sg/apidocs/authentication).
