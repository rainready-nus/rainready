# Frontend prototype

The dependency-free interface is served by the local RainReady backend at `http://127.0.0.1:8787`; do not open `index.html` directly. From the repository root, run `npm start`, create or sign in to an organisation workspace, then use the overview to create an event, check its live assessment and record an organiser decision.

The interface calls the same-origin backend for authentication, organisation-scoped event CRUD, OneMap venue search, NEA forecast/rainfall/lightning/PSI readings, explainable routine risk, the organiser-confirmed demo lightning override, decision history and test-notification previews. Browser local storage contains only organisation-specific UI preferences and the local activity log; authoritative event and decision records are stored by the backend in SQLite.

When `ONEMAP_ACCESS_TOKEN` is not configured, the event form offers clearly labelled predefined NUS demo venues so the complete prototype flow remains testable. These synthetic choices are for demonstration only and must be replaced by a verified OneMap result before real use.

See [`../docs/user-flow.md`](../docs/user-flow.md) for the four core demonstration views and screenshot checklist.
