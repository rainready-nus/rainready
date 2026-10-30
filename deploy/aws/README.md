# AWS files for the course demo

Used by Part C of the setup guide (ECS Express Mode + Amazon RDS). Replace the placeholders before use:

| File | Placeholders | Used for |
|---|---|---|
| `primary-container.json` | `ACCOUNT_ID`, `RDS_ENDPOINT`, `DB_APP_SECRET_ARN` | The container: image, settings, secrets. Used to create and to update the service. |
| `scaling-target.json` | none | 1 task normally, at most 2 |
| `trust-ecs-tasks.json` | none | Who may use the execution and task roles (ECS tasks) |
| `trust-ecs-infrastructure.json` | none | Who may use the infrastructure role (ECS) |
| `execution-role-read-secrets.json` | `ACCOUNT_ID` | Lets the container start with secrets named `rainready/...` |
| `task-role-send-email.json` | `SENDER_EMAIL` | Optional: lets the app send participant emails through Amazon SES from one address |

Never put passwords or keys in these files: they go in AWS Secrets Manager, and the files only name the secret.
