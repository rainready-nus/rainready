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

test("unknown route returns 404", async () => {
  await withServer({}, async (base) => {
    const response = await fetch(`${base}/missing`);
    assert.equal(response.status, 404);
  });
});
