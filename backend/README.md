# Backend prototype

This is a dependency-free Node.js prototype. `weather-data.mjs` fetches and normalises NEA real-time feeds; `risk-assessment.mjs` maps current readings and organiser-selected activity sensitivity into an explainable prototype assessment; `server.mjs` exposes these to the webpage over HTTP.

## Run locally

Requires Node.js 18 or later (built-in `fetch`). From the repository root:

```sh
node backend/server.mjs
```

Then open `http://127.0.0.1:8787`. Click **Check live risk** on an event. The backend listens on loopback only and needs no API key. Set `PORT` to use another local port.

## Tests

```sh
node --test backend/*.test.mjs
```

The frontend event records still use browser local storage. Authentication, durable storage, OneMap geocoding, automated refresh, email notifications, and cloud deployment are not included in this milestone. The API contract is in [`../docs/api-contract.md`](../docs/api-contract.md).

The mappings and bands in `risk-assessment.mjs` and `risk-engine.mjs` are project assumptions for testing and must be calibrated and reviewed; they are not official NEA risk thresholds or a safety guarantee. The historical-probability component is excluded until a validated event-matched estimate exists, and the remaining available component weights are renormalised and disclosed in the response. Missing forecast data yields no score; missing rainfall is disclosed as a partial assessment. The NEA lightning observation feed is not treated as an official warning or all-clear and does not trigger the score override.

Before deploying, confirm that the course-provided AWS role permits the required services. Use the approved temporary sign-in flow; do not create or commit long-lived AWS access keys.
