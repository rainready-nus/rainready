import { createServer as createHttpServer } from "node:http";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { getWeatherSnapshot } from "./weather-data.mjs";
import { buildRiskAssessment } from "./risk-assessment.mjs";
import { createEventStore } from "./event-store.mjs";
import { createEventService, EventValidationError } from "./event-service.mjs";
import { searchOneMap, GeocodingConfigurationError, GeocodingUpstreamError } from "./geocoding.mjs";
import { AuthError, createAuthService, clearedSessionCookie, hashToken, readSessionCookie, sessionCookie } from "./auth.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const frontendPath = path.join(root, "frontend", "index.html");
assertLocalPrototypeSafeEnvironment();
const eventStore = createEventStore({
  databasePath: process.env.RAINREADY_DB_FILE || path.join(root, "backend", "data", "rainready.sqlite"),
  legacyFilePath: process.env.RAINREADY_LEGACY_DATA_FILE || path.join(root, "backend", "data", "events.json"),
});

function sendJson(response, statusCode, body) {
  response.writeHead(statusCode, {
    "content-type": "application/json; charset=utf-8",
    "cache-control": "no-store",
  });
  response.end(JSON.stringify(body));
}

export function assertLocalPrototypeSafeEnvironment(environment = process.env) {
  if (environment.RAINREADY_PUBLIC_DEPLOYMENT === "true") {
    throw new Error("Public deployment is blocked: local prototype authentication is not approved. Integrate and verify managed identity, production storage, origin/TLS policy, rate limiting and monitoring first.");
  }
}

function parseCoordinate(value, name, min, max) {
  if (value === null || value.trim() === "") throw new RangeError(`${name} is required`);
  const number = Number(value);
  if (!Number.isFinite(number) || number < min || number > max) {
    throw new RangeError(`${name} must be between ${min} and ${max}`);
  }
  return number;
}

async function readJsonBody(request) {
  let body = "";
  for await (const chunk of request) {
    body += chunk;
    if (body.length > 32_768) throw new RangeError("request body must be 32 KB or smaller");
  }
  try {
    return JSON.parse(body);
  } catch {
    throw new EventValidationError("request body must contain valid JSON");
  }
}

export function createServer({ snapshot = getWeatherSnapshot, geocoder = searchOneMap, cache = new Map(), store = eventStore } = {}) {
  assertLocalPrototypeSafeEnvironment();
  const auth = createAuthService(store.auth);
  const allowedOrigins = (process.env.RAINREADY_ALLOWED_ORIGINS ?? "").split(",").map((origin) => origin.trim()).filter(Boolean);
  const currentSession = (request) => auth.resolveSession(readSessionCookie(request));
  const organizationContext = (request, session) => {
    const organizationId = request.headers["x-rainready-organization"];
    if (typeof organizationId !== "string" || !organizationId) {
      return { error: new AuthError(400, "organization_required", "Select an organization before using RainReady.") };
    }
    const organization = auth.membership(session.user.id, organizationId);
    if (!organization) return { error: new AuthError(403, "organization_access_denied", "You are not a member of this organization.") };
    return { organization };
  };
  const sameOriginMutation = (request) => {
    const origin = request.headers.origin;
    if (!origin) return process.env.RAINREADY_REQUIRE_ORIGIN !== "true";
    const protocol = request.socket.encrypted ? "https:" : "http:";
    try {
      const receivedOrigin = new URL(origin).origin;
      const sameOrigin = receivedOrigin === new URL(request.url ?? "/", `${protocol}//${request.headers.host}`).origin;
      return sameOrigin && (!allowedOrigins.length || allowedOrigins.includes(receivedOrigin));
    }
    catch { return false; }
  };
  return createHttpServer(async (request, response) => {
    const url = new URL(request.url ?? "/", "http://localhost");
    if (request.method === "GET" && url.pathname === "/health") {
      return sendJson(response, 200, {
        status: "ok",
        version: "0.5.0",
        checkedAt: new Date().toISOString(),
      });
    }

    if (request.method === "POST" && ["/api/auth/register", "/api/auth/login"].includes(url.pathname)) {
      const isRegister = url.pathname.endsWith("register");
      const bucket = `${isRegister ? "register" : "login"}:${request.socket.remoteAddress ?? "local"}`;
      const limit = store.auth.consumeRateLimit({
        keyHash: hashToken(bucket), now: Date.now(), windowMs: 15 * 60 * 1000, maxAttempts: isRegister ? 5 : 10,
      });
      if (!limit.allowed) {
        response.setHeader("retry-after", String(limit.retryAfterSeconds));
        return sendJson(response, 429, { error: "auth_rate_limited", message: "Too many authentication attempts. Wait 15 minutes and try again." });
      }
      if (!sameOriginMutation(request)) return sendJson(response, 403, { error: "cross_origin_request", message: "Cross-origin requests are not allowed." });
      try {
        const body = await readJsonBody(request);
        const result = isRegister ? auth.register(body) : auth.login(body);
        response.setHeader("set-cookie", sessionCookie(result.session.token, request));
        return sendJson(response, isRegister ? 201 : 200, {
          user: result.user,
          organizations: result.organizations,
          expiresAt: result.session.expiresAt,
        });
      } catch (error) {
        if (error instanceof AuthError) return sendJson(response, error.status, { error: error.code, message: error.message });
        if (error instanceof EventValidationError || error instanceof RangeError) return sendJson(response, 400, { error: "invalid_auth_request", message: error.message });
        return sendJson(response, 500, { error: "auth_error", message: "RainReady could not complete the authentication request." });
      }
    }

    if (url.pathname === "/api/auth/logout" && request.method === "POST") {
      if (!sameOriginMutation(request)) return sendJson(response, 403, { error: "cross_origin_request", message: "Cross-origin requests are not allowed." });
      auth.logout(readSessionCookie(request));
      response.writeHead(204, { "set-cookie": clearedSessionCookie(request), "cache-control": "no-store" });
      return response.end();
    }

    if (url.pathname === "/api/auth/logout-all" && request.method === "POST") {
      if (!sameOriginMutation(request)) return sendJson(response, 403, { error: "cross_origin_request", message: "Cross-origin requests are not allowed." });
      const session = currentSession(request);
      if (!session) return sendJson(response, 401, { error: "authentication_required", message: "Sign in to continue." });
      auth.logoutAll(session.user.id);
      response.writeHead(204, { "set-cookie": clearedSessionCookie(request), "cache-control": "no-store" });
      return response.end();
    }

    if (url.pathname === "/api/auth/me" && request.method === "GET") {
      const session = currentSession(request);
      if (!session) return sendJson(response, 401, { error: "authentication_required", message: "Sign in to continue." });
      return sendJson(response, 200, {
        user: session.user,
        organizations: store.auth.listMemberships(session.user.id),
        expiresAt: session.expiresAt,
      });
    }

    if (url.pathname === "/api/auth/invitations" && request.method === "POST") {
      if (!sameOriginMutation(request)) return sendJson(response, 403, { error: "cross_origin_request", message: "Cross-origin requests are not allowed." });
      const session = currentSession(request);
      if (!session) return sendJson(response, 401, { error: "authentication_required", message: "Sign in to continue." });
      const context = organizationContext(request, session);
      if (context.error) return sendJson(response, context.error.status, { error: context.error.code, message: context.error.message });
      try {
        const invitation = auth.createInvitation({ userId: session.user.id, organizationId: context.organization.id });
        return sendJson(response, 201, invitation);
      } catch (error) {
        if (error instanceof AuthError) return sendJson(response, error.status, { error: error.code, message: error.message });
        return sendJson(response, 500, { error: "invitation_error", message: "RainReady could not create an invitation." });
      }
    }

    if (url.pathname === "/api/auth/members" && request.method === "GET") {
      const session = currentSession(request);
      if (!session) return sendJson(response, 401, { error: "authentication_required", message: "Sign in to continue." });
      const context = organizationContext(request, session);
      if (context.error) return sendJson(response, context.error.status, { error: context.error.code, message: context.error.message });
      try {
        return sendJson(response, 200, { members: auth.listMembers({ userId: session.user.id, organizationId: context.organization.id }) });
      } catch (error) {
        if (error instanceof AuthError) return sendJson(response, error.status, { error: error.code, message: error.message });
        return sendJson(response, 500, { error: "member_list_error", message: "RainReady could not load organisation members." });
      }
    }

    const memberRoute = url.pathname.match(/^\/api\/auth\/members\/([^/]+)$/);
    if (memberRoute && request.method === "DELETE") {
      if (!sameOriginMutation(request)) return sendJson(response, 403, { error: "cross_origin_request", message: "Cross-origin requests are not allowed." });
      const session = currentSession(request);
      if (!session) return sendJson(response, 401, { error: "authentication_required", message: "Sign in to continue." });
      const context = organizationContext(request, session);
      if (context.error) return sendJson(response, context.error.status, { error: context.error.code, message: context.error.message });
      let targetUserId;
      try { targetUserId = decodeURIComponent(memberRoute[1]); }
      catch { return sendJson(response, 400, { error: "invalid_member", message: "Select a valid organisation member." }); }
      try {
        auth.removeMember({ userId: session.user.id, organizationId: context.organization.id, targetUserId });
        return sendJson(response, 200, { removed: true, sessionsRevoked: true });
      } catch (error) {
        if (error instanceof AuthError) return sendJson(response, error.status, { error: error.code, message: error.message });
        return sendJson(response, 500, { error: "member_remove_error", message: "RainReady could not remove this member." });
      }
    }

    let session = null;
    let activeOrganization = null;
    if (url.pathname.startsWith("/api/")) {
      session = currentSession(request);
      if (!session) return sendJson(response, 401, { error: "authentication_required", message: "Sign in to continue." });
      const context = organizationContext(request, session);
      if (context.error) return sendJson(response, context.error.status, { error: context.error.code, message: context.error.message });
      activeOrganization = context.organization;
      if (["POST", "PATCH", "PUT", "DELETE"].includes(request.method ?? "") && !sameOriginMutation(request)) {
        return sendJson(response, 403, { error: "cross_origin_request", message: "Cross-origin requests are not allowed." });
      }
    }
    const events = activeOrganization ? createEventService(store, { organizationId: activeOrganization.id }) : null;

    if (request.method === "GET" && url.pathname === "/api/geocode") {
      const query = (url.searchParams.get("query") ?? "").trim();
      if (query.length < 3 || query.length > 120) {
        return sendJson(response, 400, { error: "invalid_search_query", message: "Enter a place name or address between 3 and 120 characters." });
      }
      try {
        const results = await geocoder({ query });
        return sendJson(response, 200, { query, results });
      } catch (error) {
        if (error instanceof RangeError) {
          return sendJson(response, 400, { error: "invalid_search_query", message: error.message });
        }
        if (error instanceof GeocodingConfigurationError) {
          return sendJson(response, 503, { error: "geocoding_not_configured", message: "Address search is not configured. Add a OneMap access token to the backend environment; no credentials are sent to the browser." });
        }
        if (error instanceof GeocodingUpstreamError) {
          return sendJson(response, 502, { error: "geocoding_service_error", message: error.message });
        }
        return sendJson(response, 502, { error: "geocoding_service_error", message: "RainReady could not search this location. Please try again." });
      }
    }

    if (url.pathname === "/api/events" && request.method === "GET") {
      try {
        return sendJson(response, 200, { events: await events.list() });
      } catch (error) {
        return sendJson(response, 500, { error: "event_store_error", message: "RainReady could not load saved events.", detail: error.message });
      }
    }

    if (url.pathname === "/api/events" && request.method === "POST") {
      try {
        const event = await events.create(await readJsonBody(request));
        return sendJson(response, 201, { event });
      } catch (error) {
        const status = error instanceof EventValidationError || error instanceof RangeError ? 400 : 500;
        return sendJson(response, status, { error: status === 400 ? "invalid_event" : "event_store_error", message: error.message });
      }
    }

    const decisionsRoute = url.pathname.match(/^\/api\/events\/([^/]+)\/decisions$/);
    if (decisionsRoute) {
      let id;
      try {
        id = decodeURIComponent(decisionsRoute[1]);
      } catch {
        return sendJson(response, 400, { error: "invalid_event_id" });
      }
      if (request.method === "GET") {
        try {
          const decisions = await events.listDecisions(id);
          return decisions ? sendJson(response, 200, { decisions }) : sendJson(response, 404, { error: "event_not_found" });
        } catch (error) {
          return sendJson(response, 500, { error: "event_store_error", message: error.message });
        }
      }
      if (request.method === "POST") {
        try {
          const result = await events.recordDecision(id, await readJsonBody(request));
          return result
            ? sendJson(response, 201, { decision: result.decision, event: result.event })
            : sendJson(response, 404, { error: "event_not_found" });
        } catch (error) {
          const status = error instanceof EventValidationError || error instanceof RangeError ? 400 : 500;
          return sendJson(response, status, { error: status === 400 ? "invalid_decision" : "event_store_error", message: error.message });
        }
      }
    }

    const eventRoute = url.pathname.match(/^\/api\/events\/([^/]+)$/);
    if (eventRoute) {
      let id;
      try {
        id = decodeURIComponent(eventRoute[1]);
      } catch {
        return sendJson(response, 400, { error: "invalid_event_id" });
      }
      if (request.method === "GET") {
        try {
          const event = await events.get(id);
          return event ? sendJson(response, 200, { event }) : sendJson(response, 404, { error: "event_not_found" });
        } catch (error) {
          return sendJson(response, 500, { error: "event_store_error", message: error.message });
        }
      }
      if (request.method === "PATCH") {
        try {
          const event = await events.update(id, await readJsonBody(request));
          return event ? sendJson(response, 200, { event }) : sendJson(response, 404, { error: "event_not_found" });
        } catch (error) {
          const status = error instanceof EventValidationError || error instanceof RangeError ? 400 : 500;
          return sendJson(response, status, { error: status === 400 ? "invalid_event" : "event_store_error", message: error.message });
        }
      }
      if (request.method === "DELETE") {
        try {
          const deleted = await events.delete(id);
          return deleted ? sendJson(response, 200, { deleted: true, id }) : sendJson(response, 404, { error: "event_not_found" });
        } catch (error) {
          return sendJson(response, 500, { error: "event_store_error", message: error.message });
        }
      }
    }

    if (request.method === "GET" && url.pathname === "/api/weather") {
      let latitude;
      let longitude;
      try {
        latitude = parseCoordinate(url.searchParams.get("latitude"), "latitude", -90, 90);
        longitude = parseCoordinate(url.searchParams.get("longitude"), "longitude", -180, 180);
      } catch (error) {
        return sendJson(response, 400, { error: "invalid_location", message: error.message });
      }

      try {
        const result = await snapshot({ latitude, longitude, cache });
        return sendJson(response, 200, result);
      } catch (error) {
        return sendJson(response, 502, {
          error: "weather_service_error",
          message: "RainReady could not retrieve a weather snapshot.",
          detail: error.message,
        });
      }
    }

    if (request.method === "GET" && url.pathname === "/api/assessment") {
      let latitude;
      let longitude;
      const sensitivity = url.searchParams.get("sensitivity");
      const lightningStatus = url.searchParams.get("lightningStatus") ?? "none";
      try {
        latitude = parseCoordinate(url.searchParams.get("latitude"), "latitude", -90, 90);
        longitude = parseCoordinate(url.searchParams.get("longitude"), "longitude", -180, 180);
        if (!["low", "medium", "high"].includes(sensitivity)) {
          throw new RangeError("sensitivity must be low, medium, or high");
        }
        if (!["none", "confirmed_alert"].includes(lightningStatus)) {
          throw new RangeError("lightningStatus must be none or confirmed_alert");
        }
      } catch (error) {
        return sendJson(response, 400, { error: "invalid_assessment_input", message: error.message });
      }

      try {
        const snapshotResult = await snapshot({ latitude, longitude, cache });
        const assessment = buildRiskAssessment({ snapshot: snapshotResult, sensitivity, lightningStatus });
        return sendJson(response, 200, { ...snapshotResult, assessment });
      } catch (error) {
        return sendJson(response, 502, {
          error: "assessment_service_error",
          message: "RainReady could not produce a risk assessment.",
          detail: error.message,
        });
      }
    }

    if (request.method === "GET" && url.pathname === "/") {
      try {
        const html = await readFile(frontendPath);
        response.writeHead(200, { "content-type": "text/html; charset=utf-8" });
        return response.end(html);
      } catch {
        return sendJson(response, 500, { error: "frontend_unavailable" });
      }
    }

    return sendJson(response, 404, { error: "not_found" });
  });
}

const isMain = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  const port = Number(process.env.PORT ?? 8787);
  const server = createServer();
  server.listen(port, "127.0.0.1", () => {
    console.log(`RainReady is running at http://127.0.0.1:${port}`);
  });
}

