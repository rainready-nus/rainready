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
import { AD_CONTEXTS, AD_PLACEMENTS, PLANS, createConfiguredAdService, isAdFreePlan, publicAd, singaporeDay } from "./ads.mjs";
import { ParticipantValidationError, consentText, demoParticipants, isToken, joinUrl, newToken, validateJoin } from "./participants.mjs";
import { NOTIFY_ACTIONS, composeDecisionEmail, createConfiguredMailer, notifyParticipants, publicUrlFromEnv, renderBody } from "./notifications.mjs";
import { BillingError, applyStripeEvent, billingConfigFromEnv, createStripeClient, currentPlanFromStripe, planCatalogue, planFromCheckoutSession, verifyStripeSignature } from "./billing.mjs";
import { developerConfigFromEnv, isDeveloper } from "./developer.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const frontendPath = path.join(root, "frontend", "index.html");
const participantPagePath = path.join(root, "frontend", "join.html");
assertLocalPrototypeSafeEnvironment();

/**
 * RAINREADY_DB_DRIVER selects the store: "sqlite" (default) or "postgres".
 * The PostgreSQL adapter (and the `pg` package) is only loaded when it is selected,
 * so the SQLite setup keeps working without any npm dependencies.
 */
export async function createConfiguredStore(environment = process.env) {
  const driver = (environment.RAINREADY_DB_DRIVER || "sqlite").toLowerCase();
  if (driver === "postgres") {
    const { createPgEventStore, pgConfigFromEnv } = await import("./event-store-pg.mjs");
    return createPgEventStore(pgConfigFromEnv(environment));
  }
  if (driver !== "sqlite") throw new Error(`RAINREADY_DB_DRIVER must be sqlite or postgres, not "${driver}"`);
  return createEventStore({
    databasePath: environment.RAINREADY_DB_FILE || path.join(root, "backend", "data", "rainready.sqlite"),
    legacyFilePath: environment.RAINREADY_LEGACY_DATA_FILE || path.join(root, "backend", "data", "events.json"),
  });
}
const eventStore = await createConfiguredStore();
// RAINREADY_ADS=house (default) or off. A broken ad catalogue stops start-up with a clear message.
const configuredAds = createConfiguredAdService();
// Participant emails (RAINREADY_MAILER=outbox|ses), Stripe test-mode billing and developer demo
// tools are configured from the environment; a bad setting stops start-up with a clear message.
const configuredMailer = createConfiguredMailer();
const configuredBilling = billingConfigFromEnv();
const configuredDeveloper = developerConfigFromEnv();

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

function parseEventDateTime(value) {
  if (value === null) return null;
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/.test(value)) {
    throw new RangeError("eventDateTime must use Singapore local time in YYYY-MM-DDTHH:mm format");
  }
  const [datePart, timePart] = value.split("T");
  const [year, month, day] = datePart.split("-").map(Number);
  const [hour, minute] = timePart.split(":").map(Number);
  const check = new Date(Date.UTC(year, month - 1, day, hour, minute));
  if (check.getUTCFullYear() !== year || check.getUTCMonth() !== month - 1 || check.getUTCDate() !== day || hour > 23 || minute > 59) {
    throw new RangeError("eventDateTime is not a valid calendar date and time");
  }
  return `${value}:00+08:00`;
}

async function readRawBody(request, limit = 65_536) {
  const chunks = [];
  let size = 0;
  for await (const chunk of request) {
    size += chunk.length;
    if (size > limit) throw new RangeError(`request body must be ${Math.round(limit / 1024)} KB or smaller`);
    chunks.push(chunk);
  }
  return Buffer.concat(chunks).toString("utf8");
}

const maskEmail = (email) => {
  const [local, domain] = String(email).split("@");
  return `${local.slice(0, 1)}${"•".repeat(Math.max(1, Math.min(6, local.length - 1)))}@${domain}`;
};

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

export function createServer({
  snapshot = getWeatherSnapshot, geocoder = searchOneMap, cache = new Map(), store = eventStore, ads = configuredAds,
  mailer = configuredMailer, billing = configuredBilling, stripe = createStripeClient(billing), developer = configuredDeveloper,
} = {}) {
  assertLocalPrototypeSafeEnvironment();
  const publicUrl = mailer.publicUrl ?? publicUrlFromEnv();
  const auth = createAuthService(store.auth);
  const allowedOrigins = (process.env.RAINREADY_ALLOWED_ORIGINS ?? "").split(",").map((origin) => origin.trim()).filter(Boolean);
  const currentSession = async (request) => auth.resolveSession(readSessionCookie(request));
  const organizationContext = async (request, session) => {
    const organizationId = request.headers["x-rainready-organization"];
    if (typeof organizationId !== "string" || !organizationId) {
      return { error: new AuthError(400, "organization_required", "Select an organization before using RainReady.") };
    }
    const organization = await auth.membership(session.user.id, organizationId);
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
  const handleRequest = async (request, response) => {
    const url = new URL(request.url ?? "/", "http://localhost");
    if (request.method === "GET" && url.pathname === "/health") {
      return sendJson(response, 200, {
        status: "ok",
        version: "0.5.0",
        storage: store.driver || "sqlite",
        ads: ads.mode,
        checkedAt: new Date().toISOString(),
      });
    }


    // ---- Public participant pages (no account) ----------------------------------
    // A participant joins an event's email updates through the organiser's join link, and can
    // unsubscribe from any email. These pages know only a random token.
    const participantPage = url.pathname.match(/^\/(join|unsubscribe)\/([A-Za-z0-9_-]{20,64})$/);
    if (participantPage && request.method === "GET") {
      try {
        const html = await readFile(participantPagePath);
        response.writeHead(200, { "content-type": "text/html; charset=utf-8", "cache-control": "no-store", "referrer-policy": "no-referrer", "x-robots-tag": "noindex" });
        return response.end(html);
      } catch {
        return sendJson(response, 500, { error: "frontend_unavailable" });
      }
    }
    // One-click unsubscribe from the email's List-Unsubscribe header (RFC 8058): mail apps POST
    // here directly, so there is no same-origin check. It can only unsubscribe that one address.
    if (participantPage && participantPage[1] === "unsubscribe" && request.method === "POST") {
      await readRawBody(request, 4096).catch(() => "");
      await store.participants.unsubscribe(participantPage[2], new Date().toISOString());
      return sendJson(response, 200, { unsubscribed: true });
    }

    const publicRoute = url.pathname.match(/^\/api\/public\/(join|unsubscribe)\/([^/]+)$/);
    if (publicRoute) {
      const [, kind, token] = publicRoute;
      const limit = await store.auth.consumeRateLimit({
        // Separate counters for page loads and sign-ups. Generous enough for a shared campus or venue
        // network (one IP for many people). Behind a load balancer, the client IP must come from a
        // trusted proxy header instead of the socket address (not configured in this prototype).
        keyHash: hashToken(`public-${kind}-${request.method === "GET" ? "view" : "submit"}:${request.socket.remoteAddress ?? "local"}`),
        now: Date.now(), windowMs: 15 * 60 * 1000, maxAttempts: request.method === "GET" ? 300 : 60,
      });
      if (!limit.allowed) {
        response.setHeader("retry-after", String(limit.retryAfterSeconds));
        return sendJson(response, 429, { error: "rate_limited", message: "Too many attempts. Wait 15 minutes and try again." });
      }
      if (request.method === "POST" && !sameOriginMutation(request)) return sendJson(response, 403, { error: "cross_origin_request", message: "Cross-origin requests are not allowed." });
      if (!isToken(token)) return sendJson(response, 404, { error: "link_not_found", message: "This link is not valid. Ask the organiser for a new one." });
      if (kind === "join") {
        const target = await store.participants.findJoinTarget(token);
        if (!target) return sendJson(response, 404, { error: "link_not_found", message: "This join link is not valid any more. Ask the organiser for a new one." });
        if (request.method === "GET") {
          return sendJson(response, 200, { event: { name: target.name, date: target.date, time: target.time, venue: target.venue }, consentText: consentText(target.name) });
        }
        if (request.method === "POST") {
          try {
            const fields = validateJoin(await readJsonBody(request), target);
            const result = await store.participants.add(target.organizationId, target.eventId, { ...fields, unsubscribeToken: newToken(), now: new Date().toISOString() });
            if (result.error === "list_full") return sendJson(response, 409, { error: "list_full", message: "This event's update list is full. Contact the organiser." });
            if (result.error) return sendJson(response, 404, { error: "link_not_found", message: "This join link is not valid any more." });
            // Same answer whether the address was new or already on the list.
            return sendJson(response, 200, { joined: true, message: `You will get email updates about ${target.name}. Every email has an unsubscribe link.` });
          } catch (error) {
            if (error instanceof ParticipantValidationError || error instanceof EventValidationError || error instanceof RangeError) {
              return sendJson(response, 400, { error: "invalid_join", message: error.message });
            }
            throw error;
          }
        }
      }
      if (kind === "unsubscribe") {
        const target = await store.participants.findByUnsubscribeToken(token);
        if (!target) return sendJson(response, 404, { error: "link_not_found", message: "This unsubscribe link is not valid. You may already have been removed by the organiser." });
        if (request.method === "GET") return sendJson(response, 200, { eventName: target.eventName, email: maskEmail(target.email), unsubscribed: target.unsubscribed });
        if (request.method === "POST") {
          await store.participants.unsubscribe(token, new Date().toISOString());
          return sendJson(response, 200, { unsubscribed: true, eventName: target.eventName });
        }
      }
      return sendJson(response, 405, { error: "method_not_allowed" });
    }

    // ---- Stripe webhook (signed; no session) -------------------------------------
    if (url.pathname === "/api/billing/webhook" && request.method === "POST") {
      if (!billing.webhookSecret || !stripe) return sendJson(response, 404, { error: "not_found" });
      let raw;
      try { raw = await readRawBody(request); } catch { return sendJson(response, 413, { error: "payload_too_large" }); }
      if (!verifyStripeSignature(raw, request.headers["stripe-signature"], billing.webhookSecret)) {
        return sendJson(response, 400, { error: "invalid_signature" });
      }
      let event;
      try { event = JSON.parse(raw); } catch { return sendJson(response, 400, { error: "invalid_payload" }); }
      if (typeof event?.id !== "string" || typeof event?.type !== "string") return sendJson(response, 400, { error: "invalid_payload" });
      // The plan is taken from the subscription's CURRENT state in Stripe, so repeated, replayed or
      // out-of-order deliveries are harmless. Recorded after applying, so a failure makes Stripe retry.
      const outcome = await applyStripeEvent(store, stripe, event);
      const firstTime = await store.billing.recordWebhookEvent(event.id, event.type, new Date().toISOString());
      console.log(`Stripe webhook ${event.type}${firstTime ? "" : " (repeat)"}: ${outcome}`);
      return sendJson(response, 200, { received: true });
    }

    if (request.method === "POST" && ["/api/auth/register", "/api/auth/login"].includes(url.pathname)) {
      const isRegister = url.pathname.endsWith("register");
      const bucket = `${isRegister ? "register" : "login"}:${request.socket.remoteAddress ?? "local"}`;
      const limit = await store.auth.consumeRateLimit({
        keyHash: hashToken(bucket), now: Date.now(), windowMs: 15 * 60 * 1000, maxAttempts: isRegister ? 5 : 10,
      });
      if (!limit.allowed) {
        response.setHeader("retry-after", String(limit.retryAfterSeconds));
        return sendJson(response, 429, { error: "auth_rate_limited", message: "Too many authentication attempts. Wait 15 minutes and try again." });
      }
      if (!sameOriginMutation(request)) return sendJson(response, 403, { error: "cross_origin_request", message: "Cross-origin requests are not allowed." });
      try {
        const body = await readJsonBody(request);
        const result = isRegister ? await auth.register(body) : await auth.login(body);
        response.setHeader("set-cookie", sessionCookie(result.session.token, request));
        return sendJson(response, isRegister ? 201 : 200, {
          user: result.user,
          organizations: result.organizations,
          expiresAt: result.session.expiresAt,
          developer: isDeveloper(developer, result.user),
        });
      } catch (error) {
        if (error instanceof AuthError) return sendJson(response, error.status, { error: error.code, message: error.message });
        if (error instanceof EventValidationError || error instanceof RangeError) return sendJson(response, 400, { error: "invalid_auth_request", message: error.message });
        return sendJson(response, 500, { error: "auth_error", message: "RainReady could not complete the authentication request." });
      }
    }

    if (url.pathname === "/api/auth/logout" && request.method === "POST") {
      if (!sameOriginMutation(request)) return sendJson(response, 403, { error: "cross_origin_request", message: "Cross-origin requests are not allowed." });
      await auth.logout(readSessionCookie(request));
      response.writeHead(204, { "set-cookie": clearedSessionCookie(request), "cache-control": "no-store" });
      return response.end();
    }

    if (url.pathname === "/api/auth/logout-all" && request.method === "POST") {
      if (!sameOriginMutation(request)) return sendJson(response, 403, { error: "cross_origin_request", message: "Cross-origin requests are not allowed." });
      const session = await currentSession(request);
      if (!session) return sendJson(response, 401, { error: "authentication_required", message: "Sign in to continue." });
      await auth.logoutAll(session.user.id);
      response.writeHead(204, { "set-cookie": clearedSessionCookie(request), "cache-control": "no-store" });
      return response.end();
    }

    if (url.pathname === "/api/auth/me" && request.method === "GET") {
      const session = await currentSession(request);
      if (!session) return sendJson(response, 401, { error: "authentication_required", message: "Sign in to continue." });
      return sendJson(response, 200, {
        user: session.user,
        organizations: await store.auth.listMemberships(session.user.id),
        expiresAt: session.expiresAt,
        developer: isDeveloper(developer, session.user),
      });
    }

    if (url.pathname === "/api/auth/invitations" && request.method === "POST") {
      if (!sameOriginMutation(request)) return sendJson(response, 403, { error: "cross_origin_request", message: "Cross-origin requests are not allowed." });
      const session = await currentSession(request);
      if (!session) return sendJson(response, 401, { error: "authentication_required", message: "Sign in to continue." });
      const context = await organizationContext(request, session);
      if (context.error) return sendJson(response, context.error.status, { error: context.error.code, message: context.error.message });
      try {
        const invitation = await auth.createInvitation({ userId: session.user.id, organizationId: context.organization.id });
        return sendJson(response, 201, invitation);
      } catch (error) {
        if (error instanceof AuthError) return sendJson(response, error.status, { error: error.code, message: error.message });
        return sendJson(response, 500, { error: "invitation_error", message: "RainReady could not create an invitation." });
      }
    }

    if (url.pathname === "/api/auth/members" && request.method === "GET") {
      const session = await currentSession(request);
      if (!session) return sendJson(response, 401, { error: "authentication_required", message: "Sign in to continue." });
      const context = await organizationContext(request, session);
      if (context.error) return sendJson(response, context.error.status, { error: context.error.code, message: context.error.message });
      try {
        return sendJson(response, 200, { members: await auth.listMembers({ userId: session.user.id, organizationId: context.organization.id }) });
      } catch (error) {
        if (error instanceof AuthError) return sendJson(response, error.status, { error: error.code, message: error.message });
        return sendJson(response, 500, { error: "member_list_error", message: "RainReady could not load organisation members." });
      }
    }

    const memberRoute = url.pathname.match(/^\/api\/auth\/members\/([^/]+)$/);
    if (memberRoute && request.method === "DELETE") {
      if (!sameOriginMutation(request)) return sendJson(response, 403, { error: "cross_origin_request", message: "Cross-origin requests are not allowed." });
      const session = await currentSession(request);
      if (!session) return sendJson(response, 401, { error: "authentication_required", message: "Sign in to continue." });
      const context = await organizationContext(request, session);
      if (context.error) return sendJson(response, context.error.status, { error: context.error.code, message: context.error.message });
      let targetUserId;
      try { targetUserId = decodeURIComponent(memberRoute[1]); }
      catch { return sendJson(response, 400, { error: "invalid_member", message: "Select a valid organisation member." }); }
      try {
        await auth.removeMember({ userId: session.user.id, organizationId: context.organization.id, targetUserId });
        return sendJson(response, 200, { removed: true, sessionsRevoked: true });
      } catch (error) {
        if (error instanceof AuthError) return sendJson(response, error.status, { error: error.code, message: error.message });
        return sendJson(response, 500, { error: "member_remove_error", message: "RainReady could not remove this member." });
      }
    }

    // ---- Sponsored messages ---------------------------------------------------
    // Whether ads show depends on the selected organisation's plan, checked here on the server:
    // Free organisations always get ads, paid plans never do. The click link cannot send the
    // organisation header, so clicks need only a session. Counters never store who saw or clicked.
    if (url.pathname === "/api/ads" || url.pathname.startsWith("/api/ads/")) {
      const adSession = await currentSession(request);
      const adOrganization = async () => {
        const context = await organizationContext(request, adSession);
        return context.error ? { error: context.error } : { organization: context.organization };
      };
      const adRoute = url.pathname.match(/^\/api\/ads\/([a-z0-9-]{2,48})\/(impression|click)$/);
      const placement = url.searchParams.get("placement") ?? "";
      const countAdEvent = async (ad, kind, where) => {
        if (!adSession || !store.ads) return;
        try {
          const limit = await store.auth.consumeRateLimit({
            keyHash: hashToken(`ads:${adSession.user.id}`), now: Date.now(), windowMs: 15 * 60 * 1000, maxAttempts: 300,
          });
          if (limit.allowed) await store.ads.record({ adId: ad.id, placement: where, day: singaporeDay(), kind });
        } catch (error) {
          console.error("RainReady could not record an ad event:", error.message); // never block the page for an ad counter
        }
      };

      if (url.pathname === "/api/ads" && request.method === "GET") {
        if (!adSession) return sendJson(response, 401, { error: "authentication_required", message: "Sign in to continue." });
        const membership = await adOrganization();
        if (membership.error) return sendJson(response, membership.error.status, { error: membership.error.code, message: membership.error.message });
        const plan = membership.organization.plan ?? "free";
        const context = url.searchParams.get("context") ?? "general";
        if (!AD_PLACEMENTS.includes(placement) || !AD_CONTEXTS.includes(context)) {
          return sendJson(response, 400, { error: "invalid_ad_request", message: `placement must be ${AD_PLACEMENTS.join(", ")} and context must be ${AD_CONTEXTS.join(" or ")}` });
        }
        if (isAdFreePlan(plan)) return sendJson(response, 200, { enabled: false, reason: "subscribed", plan, ad: null });
        if (!ads.enabled) return sendJson(response, 200, { enabled: false, reason: "turned_off", plan, ad: null });
        const ad = ads.choose({ placement, context, excludeId: url.searchParams.get("exclude") });
        return sendJson(response, 200, { enabled: true, plan, ad: ad ? publicAd(ad, placement) : null });
      }

      if (adRoute && adRoute[2] === "impression" && request.method === "POST") {
        if (!adSession) return sendJson(response, 401, { error: "authentication_required", message: "Sign in to continue." });
        if (!sameOriginMutation(request)) return sendJson(response, 403, { error: "cross_origin_request", message: "Cross-origin requests are not allowed." });
        const membership = await adOrganization();
        if (membership.error) return sendJson(response, membership.error.status, { error: membership.error.code, message: membership.error.message });
        const ad = ads.find(adRoute[1]);
        let where;
        try { where = (await readJsonBody(request))?.placement; } catch { where = null; }
        if (!ad || !AD_PLACEMENTS.includes(where)) return sendJson(response, 404, { error: "ad_not_found" });
        // A paid organisation is never shown ads, so nothing it sends is counted.
        if (!isAdFreePlan(membership.organization.plan ?? "free")) await countAdEvent(ad, "impression", where);
        response.writeHead(204, { "cache-control": "no-store" });
        return response.end();
      }

      if (adRoute && adRoute[2] === "click" && request.method === "GET") {
        // Only destinations from the server's own catalogue are possible, so this is not an open redirect.
        const ad = ads.find(adRoute[1]);
        if (!ad || !AD_PLACEMENTS.includes(placement)) return sendJson(response, 404, { error: "ad_not_found" });
        await countAdEvent(ad, "click", placement);
        response.writeHead(302, { location: ad.url, "cache-control": "no-store", "referrer-policy": "no-referrer" });
        return response.end();
      }

      return sendJson(response, 404, { error: "not_found" });
    }

    let session = null;
    let activeOrganization = null;
    if (url.pathname.startsWith("/api/")) {
      session = await currentSession(request);
      if (!session) return sendJson(response, 401, { error: "authentication_required", message: "Sign in to continue." });
      const context = await organizationContext(request, session);
      if (context.error) return sendJson(response, context.error.status, { error: context.error.code, message: context.error.message });
      activeOrganization = context.organization;
      if (["POST", "PATCH", "PUT", "DELETE"].includes(request.method ?? "") && !sameOriginMutation(request)) {
        return sendJson(response, 403, { error: "cross_origin_request", message: "Cross-origin requests are not allowed." });
      }
    }
    const events = activeOrganization ? createEventService(store, { organizationId: activeOrganization.id }) : null;

    // ---- Participants (organiser side) ----------------------------------------
    if (url.pathname === "/api/participants/counts" && request.method === "GET") {
      return sendJson(response, 200, { counts: await store.participants.counts(activeOrganization.id) });
    }
    const participantsRoute = url.pathname.match(/^\/api\/events\/([^/]+)\/(participants|join-link)(?:\/([^/]+))?$/);
    if (participantsRoute) {
      let eventId;
      let participantId = null;
      try {
        eventId = decodeURIComponent(participantsRoute[1]);
        if (participantsRoute[3]) participantId = decodeURIComponent(participantsRoute[3]);
      } catch { return sendJson(response, 400, { error: "invalid_id" }); }
      const event = await events.get(eventId);
      if (!event) return sendJson(response, 404, { error: "event_not_found" });
      const joinLinkView = (link) => link ? { url: joinUrl(publicUrl, link.token), createdAt: link.createdAt } : null;
      if (participantsRoute[2] === "participants" && !participantId && request.method === "GET") {
        const [participants, link] = await Promise.all([store.participants.list(activeOrganization.id, eventId), store.participants.getJoinLink(activeOrganization.id, eventId)]);
        return sendJson(response, 200, {
          participants, joinLink: joinLinkView(link), consentText: consentText(event.name),
          notifyActions: NOTIFY_ACTIONS, mailer: mailer.name,
        });
      }
      if (participantsRoute[2] === "participants" && participantId && request.method === "DELETE") {
        const removed = await store.participants.remove(activeOrganization.id, eventId, participantId);
        return removed ? sendJson(response, 200, { removed: true }) : sendJson(response, 404, { error: "participant_not_found" });
      }
      if (participantsRoute[2] === "join-link" && !participantId && request.method === "POST") {
        const link = await store.participants.setJoinLink(activeOrganization.id, eventId, newToken(), new Date().toISOString());
        return link ? sendJson(response, 201, { joinLink: joinLinkView(link) }) : sendJson(response, 404, { error: "event_not_found" });
      }
      return sendJson(response, 405, { error: "method_not_allowed" });
    }
    const previewRoute = url.pathname.match(/^\/api\/events\/([^/]+)\/notification-preview$/);
    if (previewRoute && request.method === "GET") {
      let eventId;
      try { eventId = decodeURIComponent(previewRoute[1]); } catch { return sendJson(response, 400, { error: "invalid_id" }); }
      const action = url.searchParams.get("action");
      const event = await events.get(eventId);
      if (!event) return sendJson(response, 404, { error: "event_not_found" });
      if (!NOTIFY_ACTIONS.includes(action)) return sendJson(response, 200, { notifies: false, recipientCount: 0 });
      if (action === "relocate" && !event.backupVenue) return sendJson(response, 200, { notifies: false, recipientCount: 0 });
      const recipients = await store.participants.recipients(activeOrganization.id, eventId);
      const reason = (url.searchParams.get("reason") ?? "").slice(0, 1000) || "(the reason you enter)";
      const email = composeDecisionEmail({ event, decision: { action, reason }, organizationName: activeOrganization.name });
      return sendJson(response, 200, { notifies: true, recipientCount: recipients.length, mailer: mailer.name, subject: email.subject, body: renderBody(email.body, publicUrl, "UNSUBSCRIBE-LINK-PER-RECIPIENT").replace(/\/unsubscribe\/UNSUBSCRIBE-LINK-PER-RECIPIENT/, "/unsubscribe/…") });
    }
    if (url.pathname === "/api/notifications" && request.method === "GET") {
      return sendJson(response, 200, { notifications: await store.notifications.list(activeOrganization.id, { eventId: url.searchParams.get("eventId") || null, limit: 200 }) });
    }

    // ---- Plan and billing ------------------------------------------------------
    const billingView = async () => {
      const subscription = await store.billing.get(activeOrganization.id);
      const organization = await store.auth.getOrganization(activeOrganization.id);
      return {
        plan: organization?.plan ?? "free",
        subscription: subscription ? { provider: subscription.provider, plan: subscription.plan, status: subscription.status, updatedAt: subscription.updatedAt } : null,
        plans: planCatalogue(billing),
        stripeEnabled: Boolean(stripe),
        testMode: true,
        canManage: activeOrganization.role === "owner",
      };
    };
    if (url.pathname.startsWith("/api/billing")) {
      try {
        if (url.pathname === "/api/billing" && request.method === "GET") return sendJson(response, 200, await billingView());
        if (url.pathname === "/api/billing/confirm" && request.method === "POST") {
          // Any member returning from Stripe may confirm: the session must be paid AND belong to this organisation.
          if (!stripe) throw new BillingError(503, "payments_not_configured", "Payments are not configured on this server.");
          const sessionId = (await readJsonBody(request))?.sessionId;
          if (typeof sessionId !== "string" || !/^cs_test_[A-Za-z0-9]+$/.test(sessionId)) throw new BillingError(400, "invalid_session", "That payment session is not valid.");
          const change = planFromCheckoutSession(await stripe.retrieveCheckoutSession(sessionId), activeOrganization.id);
          if (!change) throw new BillingError(409, "payment_not_complete", "Stripe has not confirmed a payment for this organisation.");
          // A paid session stays "paid" for ever: grant the plan only if its subscription is active NOW.
          const current = await currentPlanFromStripe(stripe, change.subscriptionId);
          if (!current || current.plan !== "community" || (current.organizationId && current.organizationId !== activeOrganization.id)) {
            throw new BillingError(409, "subscription_not_active", "This payment's subscription is no longer active. Start a new upgrade.");
          }
          await store.billing.apply(activeOrganization.id, {
            provider: "stripe", plan: "community", status: current.status, subscriptionId: current.subscriptionId,
            customerId: current.customerId, checkoutSessionId: change.checkoutSessionId, now: new Date().toISOString(),
          });
          return sendJson(response, 200, await billingView());
        }
        if (activeOrganization.role !== "owner") throw new BillingError(403, "owner_required", "Only the organisation owner can change the plan.");
        if (url.pathname === "/api/billing/checkout" && request.method === "POST") {
          if (!stripe) throw new BillingError(503, "payments_not_configured", "Payments are not configured on this server.");
          if ((await store.auth.getOrganization(activeOrganization.id))?.plan !== "free") throw new BillingError(409, "already_subscribed", "This organisation is already on a paid plan.");
          const existing = await store.billing.get(activeOrganization.id);
          if (existing?.subscriptionId && (await currentPlanFromStripe(stripe, existing.subscriptionId))?.plan === "community") {
            throw new BillingError(409, "already_subscribed", "This organisation already has an active Stripe subscription. Reload the page.");
          }
          const checkout = await stripe.createCheckoutSession({ organizationId: activeOrganization.id, email: session.user.email, publicUrl });
          if (typeof checkout?.url !== "string" || !checkout.url.startsWith("https://checkout.stripe.com/")) throw new BillingError(502, "stripe_error", "Stripe did not return a checkout page.");
          return sendJson(response, 201, { url: checkout.url });
        }
        if (url.pathname === "/api/billing/cancel" && request.method === "POST") {
          const current = await store.billing.get(activeOrganization.id);
          if (current?.subscriptionId) {
            if (!stripe) throw new BillingError(503, "payments_not_configured", "Payments are not configured on this server.");
            // Already cancelled in Stripe (for example from the Stripe dashboard): just record it.
            const live = await currentPlanFromStripe(stripe, current.subscriptionId);
            if (live && live.status !== "canceled") await stripe.cancelSubscription(current.subscriptionId);
          }
          await store.billing.apply(activeOrganization.id, { provider: current?.provider ?? "stripe", plan: "free", status: "canceled", now: new Date().toISOString() });
          return sendJson(response, 200, await billingView());
        }
        return sendJson(response, 404, { error: "not_found" });
      } catch (error) {
        if (error instanceof BillingError) return sendJson(response, error.status, { error: error.code, message: error.message });
        throw error;
      }
    }

    // ---- Developer-only demo tools (404 for everyone else) -----------------------
    if (url.pathname.startsWith("/api/dev/")) {
      if (!isDeveloper(developer, session.user)) return sendJson(response, 404, { error: "not_found" });
      if (url.pathname === "/api/dev/status" && request.method === "GET") {
        return sendJson(response, 200, { mailer: mailer.name, publicUrl, stripeEnabled: Boolean(stripe), webhookConfigured: Boolean(billing.webhookSecret), plan: (await store.auth.getOrganization(activeOrganization.id))?.plan ?? "free" });
      }
      if (url.pathname === "/api/dev/plan" && request.method === "POST") {
        const plan = (await readJsonBody(request))?.plan;
        if (!PLANS.includes(plan)) return sendJson(response, 400, { error: "invalid_plan", message: `plan must be ${PLANS.join(", ")}` });
        await store.billing.apply(activeOrganization.id, { provider: "developer", plan, status: plan === "free" ? "canceled" : "demo", now: new Date().toISOString() });
        console.log(`Developer ${session.user.id} switched organisation ${activeOrganization.id} to ${plan} (demo, no payment)`);
        return sendJson(response, 200, { plan });
      }
      const demoRoute = url.pathname.match(/^\/api\/dev\/events\/([^/]+)\/demo-participants$/);
      if (demoRoute && request.method === "POST") {
        let eventId;
        try { eventId = decodeURIComponent(demoRoute[1]); } catch { return sendJson(response, 400, { error: "invalid_id" }); }
        const count = Number((await readJsonBody(request).catch(() => ({})))?.count ?? 3);
        const added = [];
        for (const person of demoParticipants(count)) {
          const result = await store.participants.add(activeOrganization.id, eventId, { ...person, unsubscribeToken: newToken(), now: new Date().toISOString() });
          if (result.error) return sendJson(response, 404, { error: "event_not_found" });
          added.push(result.participant);
        }
        return sendJson(response, 201, { added });
      }
      if (url.pathname === "/api/dev/outbox" && request.method === "GET") {
        // In outbox mode nothing was sent, so the link is shown for the demo. For emails that really
        // went out (SES), the participant's personal unsubscribe link is not shown to developers.
        const emails = (await store.notifications.outbox(activeOrganization.id, { limit: 100 })).map(({ unsubscribeToken, body, ...email }) => ({
          ...email, body: email.mailer === "outbox" && unsubscribeToken ? renderBody(body, publicUrl, unsubscribeToken) : body.split("{{unsubscribe_url}}").join(`${publicUrl}/unsubscribe/(personal link, hidden)`),
        }));
        return sendJson(response, 200, { mailer: mailer.name, emails });
      }
      return sendJson(response, 404, { error: "not_found" });
    }

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
          return sendJson(response, 503, { error: "geocoding_not_configured", message: "Address search is not configured. Set ONEMAP_ACCESS_TOKEN or both ONEMAP_API_EMAIL and ONEMAP_API_PASSWORD in the backend environment; no credentials are sent to the browser." });
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
          const body = await readJsonBody(request);
          const result = await events.recordDecision(id, body);
          if (!result) return sendJson(response, 404, { error: "event_not_found" });
          // Participants are emailed only when the organiser confirmed with "Email participants"
          // ticked, and only for relocate, postpone or cancel. The decision is saved either way.
          let notification = { status: "not_requested" };
          if (body?.notifyParticipants === true && NOTIFY_ACTIONS.includes(result.decision.action)) {
            try {
              const sent = await notifyParticipants({
                store, mailer, organizationId: activeOrganization.id, organizationName: activeOrganization.name,
                event: result.event, decision: result.decision, userId: session.user.id,
              });
              notification = sent.skipped
                ? { status: "skipped", reason: sent.skipped }
                : sent.duplicate
                  ? { status: "skipped", reason: "already_emailed_recently" }
                : { status: sent.notification.failedCount ? "partly_failed" : "sent", mailer: sent.notification.mailer, recipientCount: sent.notification.recipientCount, sentCount: sent.notification.sentCount, failedCount: sent.notification.failedCount };
            } catch (error) {
              console.error("RainReady could not notify participants:", error);
              notification = { status: "failed", reason: "notification_error" };
            }
          }
          return sendJson(response, 201, { decision: result.decision, event: result.event, notification });
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
      const activityType = url.searchParams.get("activityType") ?? "Other";
      const lightningStatus = url.searchParams.get("lightningStatus") ?? "none";
      let eventDateTime;
      try {
        latitude = parseCoordinate(url.searchParams.get("latitude"), "latitude", -90, 90);
        longitude = parseCoordinate(url.searchParams.get("longitude"), "longitude", -180, 180);
        if (!["low", "medium", "high"].includes(sensitivity)) {
          throw new RangeError("sensitivity must be low, medium, or high");
        }
        if (!["Sports", "Performance", "Community gathering", "Other"].includes(activityType)) {
          throw new RangeError("activityType must be a supported RainReady activity type");
        }
        if (!["none", "confirmed_alert"].includes(lightningStatus)) {
          throw new RangeError("lightningStatus must be none or confirmed_alert");
        }
        eventDateTime = parseEventDateTime(url.searchParams.get("eventDateTime"));
      } catch (error) {
        return sendJson(response, 400, { error: "invalid_assessment_input", message: error.message });
      }

      try {
        const snapshotResult = await snapshot({ latitude, longitude, cache });
        const assessment = buildRiskAssessment({ snapshot: snapshotResult, sensitivity, lightningStatus, eventDateTime, activityType });
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
  };
  // Any unexpected failure (for example the database being unreachable) becomes a 500
  // response instead of an unhandled promise rejection that would stop the server.
  return createHttpServer((request, response) => {
    handleRequest(request, response).catch((error) => {
      console.error("RainReady request failed:", error);
      if (!response.headersSent) sendJson(response, 500, { error: "internal_error", message: "RainReady could not complete the request." });
      else response.end();
    });
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

