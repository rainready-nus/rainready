/**
 * Developer-only demo tools (switch plan without paying, add synthetic participants, read the
 * email outbox). Off unless BOTH are set on the server:
 *
 *   RAINREADY_DEMO_TOOLS=true
 *   RAINREADY_DEVELOPER_USER_IDS=<user id>,<user id>   (Settings > Workspace shows your user ID)
 *
 * User IDs, not emails: sign-up does not verify email addresses yet, so anyone could register an
 * account with a developer's email. A user ID is created at sign-up and cannot be claimed by
 * someone else. For everyone else the /api/dev routes answer 404, as if they did not exist.
 */
export function developerConfigFromEnv(environment = process.env) {
  const enabled = String(environment.RAINREADY_DEMO_TOOLS ?? "").trim().toLowerCase() === "true";
  const userIds = new Set(String(environment.RAINREADY_DEVELOPER_USER_IDS ?? "").split(",").map((id) => id.trim()).filter(Boolean));
  return { enabled: enabled && userIds.size > 0, userIds };
}

export function isDeveloper(config, user) {
  return Boolean(config?.enabled && user?.id && config.userIds.has(user.id));
}
