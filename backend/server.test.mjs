import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createServer } from "./server.mjs";
import { createEventStore } from "./event-store.mjs";
import { GeocodingConfigurationError } from "./geocoding.mjs";

async function withServer(options, run) {
  const server = createServer(options);
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address();
  try {
    await run(`http://127.0.0.1:${port}`);
  } finally {
    await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  }
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

test("geocode endpoint validates search text and returns selectable locations", async () => {
  let received;
  const geocoder = async ({ query }) => {
    received = query;
    return [{ name: "UNIVERSITY TOWN", address: "NUS, 2 COLLEGE AVENUE WEST", latitude: 1.304, longitude: 103.773 }];
  };
  await withServer({ geocoder }, async (base) => {
    const invalid = await fetch(`${base}/api/geocode?query=UT`);
    assert.equal(invalid.status, 400);
    const response = await fetch(`${base}/api/geocode?query=${encodeURIComponent(" University Town ")}`);
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
    const response = await fetch(`${base}/api/geocode?query=${encodeURIComponent("NUS Kent Ridge")}`);
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
    const invalid = await fetch(`${base}/api/weather?latitude=abc&longitude=103.8`);
    assert.equal(invalid.status, 400);
    const response = await fetch(`${base}/api/weather?latitude=1.3&longitude=103.8`);
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
    },
  });
  await withServer({ snapshot }, async (base) => {
    const invalid = await fetch(`${base}/api/assessment?latitude=1.3&longitude=103.8&sensitivity=extreme`);
    assert.equal(invalid.status, 400);
    const response = await fetch(`${base}/api/assessment?latitude=1.3&longitude=103.8&sensitivity=medium`);
    const body = await response.json();
    assert.equal(response.status, 200);
    assert.equal(body.assessment.status, "current");
    assert.equal(body.assessment.inputs.sensitivity.level, "medium");
    assert.equal(body.assessment.inputs.historicalProbability, null);
    assert.ok(body.assessment.excludedComponents.some((item) => item.name === "historical_probability"));
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
      const createdResponse = await fetch(`${base}/api/events`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(payload),
      });
      assert.equal(createdResponse.status, 201);
      const { event } = await createdResponse.json();
      assert.equal(event.backupVenue.name, "Sports Hall");
      assert.equal(event.participantCount, 120);

      const list = await fetch(`${base}/api/events`);
      assert.deepEqual((await list.json()).events.map((item) => item.id), [event.id]);
      const updated = await fetch(`${base}/api/events/${event.id}`, {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ participantCount: 140 }),
      });
      assert.equal((await updated.json()).event.participantCount, 140);

      const invalid = await fetch(`${base}/api/events`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ ...payload, longitude: 200 }),
      });
      assert.equal(invalid.status, 400);

      const deleted = await fetch(`${base}/api/events/${event.id}`, { method: "DELETE" });
      assert.equal(deleted.status, 200);
      assert.deepEqual((await (await fetch(`${base}/api/events`)).json()).events, []);
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
      const create = await fetch(`${base}/api/events`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          name: "Decision Test", venue: "Test venue", latitude: 1.3, longitude: 103.8,
          backupVenue: { name: "Test hall", latitude: 1.31, longitude: 103.81 }, participantCount: 25,
          date: "2026-11-20", time: "16:00", type: "Sports", sensitivity: "high",
        }),
      });
      const { event } = await create.json();
      const invalid = await fetch(`${base}/api/events/${event.id}/decisions`, {
        method: "POST", headers: { "content-type": "application/json" },
        body: JSON.stringify({ action: "cancel", reason: " " }),
      });
      assert.equal(invalid.status, 400);

      const response = await fetch(`${base}/api/events/${event.id}/decisions`, {
        method: "POST", headers: { "content-type": "application/json" },
        body: JSON.stringify({ action: "relocate", reason: "Heavy showers near the venue." }),
      });
      const body = await response.json();
      assert.equal(response.status, 201);
      assert.equal(body.decision.reason, "Heavy showers near the venue.");
      assert.equal(body.decision.testNotification.status, "not_sent");
      assert.match(body.decision.testNotification.message, /Test hall/);
      assert.equal(body.event.decisions.length, 1);

      const history = await fetch(`${base}/api/events/${event.id}/decisions`);
      assert.deepEqual((await history.json()).decisions, [body.decision]);
    });
  } finally {
    store.close();
    await rm(directory, { recursive: true, force: true });
  }
});

