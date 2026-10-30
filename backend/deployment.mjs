/**
 * Where the server runs, and what it may trust.
 *
 *   RAINREADY_DEPLOYMENT  local (default) | course-demo
 *   RAINREADY_HOST        address to listen on; default 127.0.0.1 (this computer only)
 *
 * local        The server listens on 127.0.0.1 only. Listening on any other address is refused.
 * course-demo  For the course's cloud demo behind an AWS load balancer (ECS Express Mode), which
 *              ends HTTPS and forwards plain HTTP. In this mode the server:
 *              - trusts the load balancer's X-Forwarded-Proto / X-Forwarded-For headers (so the
 *                origin check sees https and rate limits see the visitor's IP, not the balancer's);
 *              - always marks the session cookie Secure and rejects state changes without Origin;
 *              - refuses to start unless the database is PostgreSQL over verified TLS, and
 *                RAINREADY_PUBLIC_URL (when set) is https.
 *              It is still the course prototype's own sign-in (no Cognito, MFA or account
 *              recovery). RAINREADY_PUBLIC_DEPLOYMENT=true stays blocked for that reason.
 */
const LOOPBACK = new Set(["127.0.0.1", "::1", "localhost"]);
const MODES = new Set(["local", "course-demo"]);

export class DeploymentConfigurationError extends Error {
  constructor(message) {
    super(message);
    this.name = "DeploymentConfigurationError";
  }
}

export function deploymentFromEnv(environment = process.env) {
  const mode = String(environment.RAINREADY_DEPLOYMENT ?? "local").trim().toLowerCase() || "local";
  if (!MODES.has(mode)) throw new DeploymentConfigurationError(`RAINREADY_DEPLOYMENT must be local or course-demo, not "${mode}"`);
  const host = String(environment.RAINREADY_HOST ?? "").trim() || "127.0.0.1";
  if (mode === "local" && !LOOPBACK.has(host)) {
    throw new DeploymentConfigurationError(`RAINREADY_HOST=${host} would accept connections from other computers. Use 127.0.0.1, or set RAINREADY_DEPLOYMENT=course-demo for the AWS demo.`);
  }
  if (mode === "course-demo") {
    if ((environment.RAINREADY_DB_DRIVER || "sqlite").toLowerCase() !== "postgres") {
      throw new DeploymentConfigurationError("RAINREADY_DEPLOYMENT=course-demo needs RAINREADY_DB_DRIVER=postgres (Amazon RDS); a SQLite file inside a container is lost on every restart.");
    }
    if (!["verify-full", "verify-ca"].includes(String(environment.RAINREADY_DB_SSL ?? "").toLowerCase())) {
      throw new DeploymentConfigurationError("RAINREADY_DEPLOYMENT=course-demo needs RAINREADY_DB_SSL=verify-full (with RAINREADY_DB_SSL_CA) so the database connection is encrypted and verified.");
    }
    const publicUrl = String(environment.RAINREADY_PUBLIC_URL ?? "").trim();
    if (publicUrl && !publicUrl.startsWith("https://")) {
      throw new DeploymentConfigurationError("RAINREADY_PUBLIC_URL must start with https:// in course-demo mode.");
    }
  }
  const demo = mode === "course-demo";
  return {
    mode,
    host,
    trustProxy: demo,
    secureCookies: demo || environment.RAINREADY_COOKIE_SECURE === "true",
    requireOrigin: demo || environment.RAINREADY_REQUIRE_ORIGIN === "true",
    publicUrlSet: Boolean(String(environment.RAINREADY_PUBLIC_URL ?? "").trim()),
  };
}

const firstHeader = (value) => String(Array.isArray(value) ? value[0] : value ?? "").split(",")[0].trim();

/** "https:" or "http:" as the visitor used it (from the load balancer's header when trusted). */
export function requestProtocol(request, deployment) {
  if (deployment?.trustProxy) {
    const forwarded = firstHeader(request.headers["x-forwarded-proto"]).toLowerCase();
    if (forwarded === "https" || forwarded === "http") return `${forwarded}:`;
  }
  return request.socket.encrypted ? "https:" : "http:";
}

/**
 * The visitor's IP address. Behind one trusted load balancer it is the LAST address in
 * X-Forwarded-For (the balancer appends the address that connected to it; earlier entries can be
 * typed by anyone). Without a trusted proxy it is the socket address.
 */
export function clientAddress(request, deployment) {
  if (deployment?.trustProxy) {
    const header = request.headers["x-forwarded-for"];
    const parts = String(Array.isArray(header) ? header.join(",") : header ?? "").split(",").map((part) => part.trim()).filter(Boolean);
    if (parts.length) return parts.at(-1);
  }
  return request.socket.remoteAddress ?? "local";
}
