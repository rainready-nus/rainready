import test from "node:test";
import assert from "node:assert/strict";
import { createServer } from "./server.mjs";

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
    assert.equal((await response.json()).status, "ok");
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
