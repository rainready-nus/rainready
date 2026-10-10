import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { assertLocalPrototypeSafeEnvironment, createServer } from "./server.mjs";
import { createEventStore } from "./event-store.mjs";
import { GeocodingConfigurationError } from "./geocoding.mjs";

async function withServer(options, run) {
  const ownsStore = !options.store;
  const directory = ownsStore ? await mkdtemp(path.join(os.tmpdir(), "rainready-server-test-")) : null;
  const store = options.store ?? createEventStore({ databasePath: path.join(directory, "events.sqlite"), legacyFilePath: null });
  const server = createServer({ ...options, store });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address();
  try {
    await run(`http://127.0.0.1:${port}`);
  } finally {
    await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    if (ownsStore) {
      store.close();
      await rm(directory, { recursive: true, force: true });
    }
  }
}

async function signUp(base, email, organizationName, invitationCode = "") {
  const response = await fetch(`${base}/api/auth/register`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ email, password: "correct horse battery staple", organizationName, invitationCode }),
  });
  const body = await response.json();
  assert.equal(response.status, 201, JSON.stringify(body));
  return { cookie: response.headers.get("set-cookie").split(";")[0], user: body.user, organization: body.organizations[0] };
}

function apiFetch(base, client, path, options = {}, organizationId = client.organization.id) {
  return fetch(`${base}${path}`, {
    ...options,
    headers: {
      ...(options.headers ?? {}),
      cookie: client.cookie,
      "x-rainready-organization": organizationId,
    },
  });
}

test("health endpoint returns service status", async () => {
  await withServer({}, async (base) => {
    const response = await fetch(`${base}/health`);
    assert.equal(response.status, 200);
    const body = await response.json();
    assert.equal(body.status, "ok");
    assert.equal(body.version, "0.5.0");
  });
});

test("authentication issues HttpOnly sessions, invites members, and logs out", async () => {
  await withServer({}, async (base) => {
    const privateResponse = await fetch(`${base}/api/events`);
    assert.equal(privateResponse.status, 401);

    const owner = await signUp(base, "owner@example.com", "RainReady Club");
    assert.match(owner.cookie, /^rainready_session=/);
    const session = await fetch(`${base}/api/auth/me`, { headers: { cookie: owner.cookie } });
    assert.equal(session.status, 200);
    assert.equal((await session.json()).organizations[0].role, "owner");

    const invitationResponse = await apiFetch(base, owner, "/api/auth/invitations", { method: "POST", body: "{}" });
    assert.equal(invitationResponse.status, 201);
    const invitation = await invitationResponse.json();
    assert.ok(invitation.code);
    assert.equal(invitation.organizationName, "RainReady Club");

    const member = await signUp(base, "member@example.com", "", invitation.code);
    assert.equal(member.organization.id, owner.organization.id);
    assert.equal(member.organization.role, "member");
    const deniedInvite = await apiFetch(base, member, "/api/auth/invitations", { method: "POST", body: "{}" });
    assert.equal(deniedInvite.status, 403);

    const wrongPassword = await fetch(`${base}/api/auth/login`, {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ email: "owner@example.com", password: "wrong password" }),
    });
    assert.equal(wrongPassword.status, 401);
    const login = await fetch(`${base}/api/auth/login`, {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ email: "OWNER@example.com", password: "correct horse battery staple" }),
    });
    assert.equal(login.status, 200);
    assert.match(login.headers.get("set-cookie"), /HttpOnly; SameSite=Strict/);

    const logout = await apiFetch(base, owner, "/api/auth/logout", { method: "POST", body: "{}" });
    assert.equal(logout.status, 204);
    const expired = await fetch(`${base}/api/auth/me`, { headers: { cookie: owner.cookie } });
    assert.equal(expired.status, 401);
  });
});

test("organisation membership scopes event list, retrieval, updates and decisions", async () => {
  await withServer({}, async (base) => {
    const alpha = await signUp(base, "alpha@example.com", "Alpha Club");
    const beta = await signUp(base, "beta@example.com", "Beta Club");
    const payload = {
      name: "Alpha-only event", venue: "University Town", latitude: 1.304, longitude: 103.773,
      backupVenue: { name: "Sports Hall", latitude: 1.296, longitude: 103.78 }, participantCount: 12,
      date: "2026-11-18", time: "16:00", type: "Sports", sensitivity: "medium",
    };
    const created = await apiFetch(base, alpha, "/api/events", { method: "POST", body: JSON.stringify(payload) });
    assert.equal(created.status, 201);
    const event = (await created.json()).event;

    assert.deepEqual((await (await apiFetch(base, beta, "/api/events")).json()).events, []);
    assert.equal((await apiFetch(base, beta, `/api/events/${event.id}`)).status, 404);
    assert.equal((await apiFetch(base, beta, `/api/events/${event.id}`, { method: "PATCH", body: JSON.stringify({ participantCount: 999 }) })).status, 404);
    assert.equal((await apiFetch(base, beta, `/api/events/${event.id}/decisions`)).status, 404);
    assert.equal((await apiFetch(base, beta, `/api/events/${event.id}`, { method: "DELETE" })).status, 404);
    assert.equal((await apiFetch(base, beta, "/api/events", {}, alpha.organization.id)).status, 403);
    assert.equal((await apiFetch(base, alpha, "/api/events", {}, "")).status, 400);
  });
});

test("state-changing requests reject a foreign browser origin", async () => {
  await withServer({}, async (base) => {
    const client = await signUp(base, "origin@example.com", "Origin Club");
    const response = await apiFetch(base, client, "/api/events", {
      method: "POST",
      headers: { origin: "https://attacker.example", "content-type": "application/json" },
      body: "{}",
    });
    assert.equal(response.status, 403);
    assert.equal((await response.json()).error, "cross_origin_request");
  });
});

test("strict origin mode rejects mutation requests without an Origin header", async () => {
  const previous = process.env.RAINREADY_REQUIRE_ORIGIN;
  await withServer({}, async (base) => {
    const client = await signUp(base, "strict-origin@example.com", "Strict Origin Club");
    process.env.RAINREADY_REQUIRE_ORIGIN = "true";
    try {
      const response = await apiFetch(base, client, "/api/auth/logout", { method: "POST", body: "{}" });
      assert.equal(response.status, 403);
      assert.equal((await response.json()).error, "cross_origin_request");
    } finally {
      if (previous === undefined) delete process.env.RAINREADY_REQUIRE_ORIGIN;
      else process.env.RAINREADY_REQUIRE_ORIGIN = previous;
    }
  });
});

test("public deployment mode fails closed while local prototype authentication is configured", () => {
  assert.throws(() => assertLocalPrototypeSafeEnvironment({ RAINREADY_PUBLIC_DEPLOYMENT: "true" }), /Public deployment is blocked/);
  assert.doesNotThrow(() => assertLocalPrototypeSafeEnvironment({ RAINREADY_PUBLIC_DEPLOYMENT: "false" }));
});

test("owners can view and remove organisation members, which revokes all their sessions", async () => {
  await withServer({}, async (base) => {
    const owner = await signUp(base, "owner@example.com", "Member Admin Club");
    const invitationResponse = await apiFetch(base, owner, "/api/auth/invitations", { method: "POST", body: "{}" });
    const invite = await invitationResponse.json();
    const member = await signUp(base, "member@example.com", "", invite.code);

    const members = await apiFetch(base, owner, "/api/auth/members");
    assert.equal(members.status, 200);
    assert.deepEqual((await members.json()).members.map(({ email, role }) => ({ email, role })), [
      { email: "owner@example.com", role: "owner" }, { email: "member@example.com", role: "member" },
    ]);
    assert.equal((await apiFetch(base, member, "/api/auth/members")).status, 403);

    const removed = await apiFetch(base, owner, `/api/auth/members/${encodeURIComponent(member.user.id)}`, { method: "DELETE" });
    assert.equal(removed.status, 200);
    assert.equal((await removed.json()).sessionsRevoked, true);
    assert.equal((await fetch(`${base}/api/auth/me`, { headers: { cookie: member.cookie } })).status, 401);
    assert.equal((await apiFetch(base, owner, "/api/auth/members").then((response) => response.json())).members.length, 1);
  });
});

test("account-wide logout invalidates every session", async () => {
  await withServer({}, async (base) => {
    const client = await signUp(base, "logout-all@example.com", "Session Club");
    const secondLogin = await fetch(`${base}/api/auth/login`, {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ email: "logout-all@example.com", password: "correct horse battery staple" }),
    });
    const secondCookie = secondLogin.headers.get("set-cookie").split(";")[0];
    const logout = await apiFetch(base, client, "/api/auth/logout-all", { method: "POST", body: "{}" });
    assert.equal(logout.status, 204);
    assert.equal((await fetch(`${base}/api/auth/me`, { headers: { cookie: client.cookie } })).status, 401);
    assert.equal((await fetch(`${base}/api/auth/me`, { headers: { cookie: secondCookie } })).status, 401);
  });
});

test("login attempts are persistently rate limited with Retry-After", async () => {
  await withServer({}, async (base) => {
    for (let attempt = 0; attempt < 10; attempt += 1) {
      const response = await fetch(`${base}/api/auth/login`, {
        method: "POST", headers: { "content-type": "application/json" },
        body: JSON.stringify({ email: "nobody@example.com", password: "wrong password" }),
      });
      assert.equal(response.status, 401);
    }
    const limited = await fetch(`${base}/api/auth/login`, {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ email: "nobody@example.com", password: "wrong password" }),
    });
    assert.equal(limited.status, 429);
    assert.ok(Number(limited.headers.get("retry-after")) > 0);
  });
});

test("geocode endpoint validates search text and returns selectable locations", async () => {
  let received;
  const geocoder = async ({ query }) => {
    received = query;
    return [{ name: "UNIVERSITY TOWN", address: "NUS, 2 COLLEGE AVENUE WEST", latitude: 1.304, longitude: 103.773 }];
  };
  await withServer({ geocoder }, async (base) => {
    const client = await signUp(base, "organizer@example.com", "Test Club");
    const invalid = await apiFetch(base, client, "/api/geocode?query=UT");
    assert.equal(invalid.status, 400);
    const response = await apiFetch(base, client, `/api/geocode?query=${encodeURIComponent(" University Town ")}`);
    assert.equal(response.status, 200);
    assert.equal(received, "University Town");
    assert.deepEqual(await response.json(), {
      query: "University Town",
      results: [{ name: "UNIVERSITY TOWN", address: "NUS, 2 COLLEGE AVENUE WEST", latitude: 1.304, longitude: 103.773 }],
    });
  });
});

test("geocode endpoint explains when OneMap credentials are not configured", async () => {
  await withServer({ geocoder: async () => { throw new GeocodingConfigurationError(); } }, async (base) => {
    const client = await signUp(base, "organizer@example.com", "Test Club");
    const response = await apiFetch(base, client, `/api/geocode?query=${encodeURIComponent("NUS Kent Ridge")}`);
    assert.equal(response.status, 503);
    const body = await response.json();
    assert.equal(body.error, "geocoding_not_configured");
    assert.match(body.message, /backend environment/);
  });
});

test("weather endpoint validates coordinates and returns snapshot", async () => {
  let received;
  const snapshot = async (input) => {
    received = input;
    return { location: { latitude: input.latitude, longitude: input.longitude }, sources: {} };
  };
  await withServer({ snapshot }, async (base) => {
    const client = await signUp(base, "organizer@example.com", "Test Club");
    const invalid = await apiFetch(base, client, "/api/weather?latitude=abc&longitude=103.8");
    assert.equal(invalid.status, 400);
    const response = await apiFetch(base, client, "/api/weather?latitude=1.3&longitude=103.8");
    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), { location: { latitude: 1.3, longitude: 103.8 }, sources: {} });
    assert.equal(received.latitude, 1.3);
    assert.equal(received.longitude, 103.8);
    assert.ok(received.cache instanceof Map);
  });
});

test("assessment endpoint combines source snapshot with requested sensitivity", async () => {
  const snapshot = async ({ latitude, longitude }) => ({
    retrievedAt: "2026-10-06T10:00:00.000Z",
    location: { latitude, longitude },
    sources: {
      forecast: { data: { nearestArea: { forecast: "Cloudy" } }, freshness: { status: "current" } },
      rainfall: { data: { unit: "mm", nearestStation: { value: 0, name: "Test station", distanceKm: 1 } }, freshness: { status: "current" } },
      lightning: { data: { observations: [], interpretation: "observations only" }, freshness: { status: "current" } },
      airQuality: { data: { observedAt: "2026-10-06T09:00:00.000Z", nearestRegion: { name: "central", psiTwentyFourHourly: 72 } }, freshness: { status: "current" } },
    },
  });
  await withServer({ snapshot }, async (base) => {
    const client = await signUp(base, "organizer@example.com", "Test Club");
    const invalid = await apiFetch(base, client, "/api/assessment?latitude=1.3&longitude=103.8&sensitivity=extreme");
    assert.equal(invalid.status, 400);
    const response = await apiFetch(base, client, "/api/assessment?latitude=1.3&longitude=103.8&sensitivity=medium");
    const body = await response.json();
    assert.equal(response.status, 200);
    assert.equal(body.assessment.status, "current");
    assert.equal(body.assessment.inputs.sensitivity.level, "medium");
    assert.equal(body.assessment.inputs.historicalProbability, null);
    assert.ok(body.assessment.excludedComponents.some((item) => item.name === "historical_probability"));
    assert.equal(body.assessment.airQuality.level, "moderate");

    const badLightning = await apiFetch(base, client, "/api/assessment?latitude=1.3&longitude=103.8&sensitivity=medium&lightningStatus=observed");
    assert.equal(badLightning.status, 400);
    const override = await apiFetch(base, client, "/api/assessment?latitude=1.3&longitude=103.8&sensitivity=medium&lightningStatus=confirmed_alert");
    const overrideBody = await override.json();
    assert.equal(override.status, 200);
    assert.equal(overrideBody.assessment.status, "override");
    assert.equal(overrideBody.assessment.recommendedAction, "stop_and_shelter");
  });
});

test("unknown route returns 404", async () => {
  await withServer({}, async (base) => {
    const response = await fetch(`${base}/missing`);
    assert.equal(response.status, 404);
  });
});

test("event API creates, lists, updates, and deletes an event with persisted data", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "rainready-api-events-"));
  const store = createEventStore({ databasePath: path.join(directory, "events.sqlite"), legacyFilePath: null });
  try {
    await withServer({ store }, async (base) => {
      const client = await signUp(base, "organizer@example.com", "Test Club");
      const payload = {
        name: "Campus Sports Day",
        venue: "University Town Green",
        venueAddress: "NUS",
        latitude: 1.304,
        longitude: 103.773,
        backupVenue: { name: "Sports Hall", latitude: 1.296, longitude: 103.78 },
        participantCount: 120,
        date: "2026-11-18",
        time: "16:00",
        type: "Sports",
        sensitivity: "high",
      };
      const createdResponse = await apiFetch(base, client, "/api/events", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(payload),
      });
      assert.equal(createdResponse.status, 201);
      const { event } = await createdResponse.json();
      assert.equal(event.backupVenue.name, "Sports Hall");
      assert.equal(event.participantCount, 120);

      const list = await apiFetch(base, client, "/api/events");
      assert.deepEqual((await list.json()).events.map((item) => item.id), [event.id]);
      const updated = await apiFetch(base, client, `/api/events/${event.id}`, {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ participantCount: 140 }),
      });
      assert.equal((await updated.json()).event.participantCount, 140);

      const invalid = await apiFetch(base, client, "/api/events", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ ...payload, longitude: 200 }),
      });
      assert.equal(invalid.status, 400);

      const deleted = await apiFetch(base, client, `/api/events/${event.id}`, { method: "DELETE" });
      assert.equal(deleted.status, 200);
      assert.deepEqual((await (await apiFetch(base, client, "/api/events")).json()).events, []);
    });
  } finally {
    store.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test("decision API stores the organiser reason and returns a preview that was not sent", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "rainready-decision-api-"));
  const store = createEventStore({ databasePath: path.join(directory, "events.sqlite"), legacyFilePath: null });
  try {
    await withServer({ store }, async (base) => {
      const client = await signUp(base, "organizer@example.com", "Test Club");
      const create = await apiFetch(base, client, "/api/events", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          name: "Decision Test", venue: "Test venue", latitude: 1.3, longitude: 103.8,
          backupVenue: { name: "Test hall", latitude: 1.31, longitude: 103.81 }, participantCount: 25,
          date: "2026-11-20", time: "16:00", type: "Sports", sensitivity: "high",
        }),
      });
      const { event } = await create.json();
      const invalid = await apiFetch(base, client, `/api/events/${event.id}/decisions`, {
        method: "POST", headers: { "content-type": "application/json" },
        body: JSON.stringify({ action: "cancel", reason: " " }),
      });
      assert.equal(invalid.status, 400);

      const response = await apiFetch(base, client, `/api/events/${event.id}/decisions`, {
        method: "POST", headers: { "content-type": "application/json" },
        body: JSON.stringify({ action: "relocate", reason: "Heavy showers near the venue." }),
      });
      const body = await response.json();
      assert.equal(response.status, 201);
      assert.equal(body.decision.reason, "Heavy showers near the venue.");
      assert.equal(body.decision.testNotification.status, "not_sent");
      assert.match(body.decision.testNotification.message, /Test hall/);
      assert.equal(body.event.decisions.length, 1);

      const history = await apiFetch(base, client, `/api/events/${event.id}/decisions`);
      assert.deepEqual((await history.json()).decisions, [body.decision]);
    });
  } finally {
    store.close();
    await rm(directory, { recursive: true, force: true });
  }
});

