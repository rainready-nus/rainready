# Backend and risk engine

The first backend milestone is the standalone, dependency-free risk rules module in `risk-engine.mjs`. It accepts normalised component scores and returns an explainable assessment. Run its tests with `node --test risk-engine.test.mjs`.

The HTTP API, persistence, authentication, and weather adapters are not implemented yet. The proposed API contract is in [`../docs/api-contract.md`](../docs/api-contract.md). A suitable next milestone is API Gateway + Lambda with `/health` and event endpoints, followed by DynamoDB persistence and server-side weather adapters.

The initial weights and bands are project assumptions for testing and must be calibrated and reviewed. They are not official NEA risk thresholds or a safety guarantee. Confirmed lightning status is handled as a separate override, not blended into the normal weighted score.
