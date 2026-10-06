# Backend prototype

This is a dependency-free Node.js prototype. `weather-data.mjs` fetches and normalises NEA real-time feeds; `server.mjs` exposes them to the webpage over HTTP.

## Run locally

Requires Node.js 18 or later (built-in `fetch`). From the repository root:

```sh
node backend/server.mjs
```

Then open `http://127.0.0.1:8787`. Click **Check live weather** on an event. The backend listens on loopback only and needs no API key. Set `PORT` to use another local port.

## Tests

```sh
node --test backend/*.test.mjs
```

The frontend event records still use browser local storage. Authentication, durable storage, OneMap geocoding, automated refresh, email notifications, and cloud deployment are not included in this milestone. The API contract is in [`../docs/api-contract.md`](../docs/api-contract.md).

The initial weights and bands in `risk-engine.mjs` are project assumptions for testing and must be calibrated and reviewed. They are not official NEA risk thresholds or a safety guarantee. Live weather readings are currently displayed separately and do not yet feed that illustrative score. The NEA lightning observation feed is not treated as an official warning.

Before deploying, confirm that the course-provided AWS role permits the required services. Use the approved temporary sign-in flow; do not create or commit long-lived AWS access keys.
