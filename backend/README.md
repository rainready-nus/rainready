# Backend — planned

The backend has not been implemented yet. Keep weather API credentials and future secrets on the server side; never place them in browser JavaScript.

The initial API contract is in [`../docs/api-contract.md`](../docs/api-contract.md). A suitable first backend milestone is an API Gateway + Lambda service with a `/health` endpoint and event CRUD endpoints, followed by DynamoDB persistence and weather adapters.

Before deploying, confirm that the course-provided AWS role permits the required services. Use the approved temporary sign-in flow; do not create or commit long-lived AWS access keys.
