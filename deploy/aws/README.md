# AWS files for the course demo

Part C of the setup guide does everything in the AWS website (console); these files are for the optional command-line route and for the policy you paste into IAM. Replace the placeholders before use:

| File | Placeholders | Used for |
|---|---|---|
| `primary-container.json` | `ACCOUNT_ID`, `RDS_ENDPOINT`, `DB_APP_SECRET_ARN`, `DB_ADMIN_SECRET_ARN` | The container: image, settings, secrets. Used to create and to update the service. |
| `scaling-target.json` | none | 1 task normally, at most 2 |
| `trust-ecs-tasks.json` | none | Who may use the execution and task roles (ECS tasks) |
| `trust-ecs-infrastructure.json` | none | Who may use the infrastructure role (ECS) |
| `execution-role-read-secrets.json` | none | Lets the container read secrets named `rainready/...` and the RDS-managed admin secret (`rds!...`) |
| `task-role-send-email.json` | `SENDER_EMAIL` | Optional: lets the app send participant emails through Amazon SES from one address |

Never put passwords or keys in these files: they go in AWS Secrets Manager, and the files only name the secret.

After the first start, `/health` shows `"databaseSetup":"done"`. Then remove `RAINREADY_DB_SETUP` and `RAINREADY_DB_ADMIN_PASSWORD` from the service, so the running app no longer holds the admin password.
