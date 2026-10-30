import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { clientAddress, deploymentFromEnv, requestProtocol } from "./deployment.mjs";
import { createServer } from "./server.mjs";
import { createEventStore } from "./event-store.mjs";
import { createAdService } from "./ads.mjs";

const demoEnv = { RAINREADY_DEPLOYMENT: "course-demo", RAINREADY_HOST: "0.0.0.0", RAINREADY_DB_DRIVER: "postgres", RAINREADY_DB_SSL: "verify-full", RAINREADY_PUBLIC_URL: "https://rainready.ecs.ap-southeast-1.on.aws" };

test("local mode listens on this computer only", () => {
  assert.equal(deploymentFromEnv({}).host, "127.0.0.1");
  assert.equal(deploymentFromEnv({}).trustProxy, false);
  assert.throws(() => deploymentFromEnv({ RAINREADY_HOST: "0.0.0.0" }), /course-demo/);
  assert.throws(() => deploymentFromEnv({ RAINREADY_DEPLOYMENT: "production" }), /local or course-demo/);
});

test("course-demo mode needs PostgreSQL over verified TLS and an https public URL", () => {
  const config = deploymentFromEnv(demoEnv);
  assert.deepEqual([config.mode, config.host, config.trustProxy, config.secureCookies, config.requireOrigin], ["course-demo", "0.0.0.0", true, true, true]);
  assert.throws(() => deploymentFromEnv({ ...demoEnv, RAINREADY_DB_DRIVER: "sqlite" }), /postgres/);
  assert.throws(() => deploymentFromEnv({ ...demoEnv, RAINREADY_DB_SSL: "off" }), /verify-full/);
  assert.throws(() => deploymentFromEnv({ ...demoEnv, RAINREADY_PUBLIC_URL: "http://example.org" }), /https/);
  assert.equal(deploymentFromEnv({ ...demoEnv, RAINREADY_PUBLIC_URL: "" }).publicUrlSet, false);
});

test("forwarded headers are trusted only behind the load balancer", () => {
  const request = { headers: { "x-forwarded-proto": "https", "x-forwarded-for": "6.6.6.6, 203.0.113.9" }, socket: { remoteAddress: "10.0.1.20", encrypted: false } };
  const demo = deploymentFromEnv(demoEnv);
  assert.equal(requestProtocol(request, demo), "https:");
  assert.equal(clientAddress(request, demo), "203.0.113.9", "the address the balancer saw, not one the visitor typed");
  const local = deploymentFromEnv({});
  assert.equal(requestProtocol(request, local), "http:");
  assert.equal(clientAddress(request, local), "10.0.1.20");
});

async function withDemoServer(run) {
  const directory = await mkdtemp(path.join(os.tmpdir(), "rainready-deploy-"));
  const store = createEventStore({ databasePath: path.join(directory, "d.sqlite"), legacyFilePath: null });
  // The store is SQLite here only to test the HTTP behaviour; the real demo uses RDS.
  const server = createServer({ store, ads: createAdService({ mode: "off" }), stripe: null, deployment: { mode: "course-demo", host: "127.0.0.1", trustProxy: true, secureCookies: true, requireOrigin: true } });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  try {
    await run(`http://127.0.0.1:${server.address().port}`);
  } finally {
    await new Promise((resolve) => server.close(resolve));
    store.close();
    await rm(directory, { recursive: true, force: true });
  }
}

test("behind the load balancer: Secure cookies, https origin check, Origin required, per-visitor rate limits", async () => {
  await withDemoServer(async (base) => {
    const host = new URL(base).host;
    const register = (headers, email = `d-${Math.random().toString(36).slice(2)}@example.com`) => fetch(`${base}/api/auth/register`, {
      method: "POST", headers: { "content-type": "application/json", ...headers },
      body: JSON.stringify({ email, password: "correct horse battery staple", organizationName: "Demo Club" }),
    });
    const viaBalancer = { origin: `https://${host}`, "x-forwarded-proto": "https", "x-forwarded-for": "203.0.113.5" };
    const ok = await register(viaBalancer);
    assert.equal(ok.status, 201);
    assert.match(ok.headers.get("set-cookie"), /; Secure/);
    assert.equal((await register({ ...viaBalancer, origin: "https://evil.example", "x-forwarded-for": "192.0.2.1" })).status, 403);
    const noOrigin = { ...viaBalancer, "x-forwarded-for": "192.0.2.1" };
    delete noOrigin.origin;
    assert.equal((await register(noOrigin)).status, 403, "state changes need an Origin header");
    // Rate limits count each visitor separately (5 registrations per 15 minutes per address).
    for (let index = 0; index < 4; index += 1) assert.equal((await register(viaBalancer)).status, 201);
    assert.equal((await register(viaBalancer)).status, 429);
    assert.equal((await register({ ...viaBalancer, "x-forwarded-for": "198.51.100.7" })).status, 201, "another visitor is not blocked");
    const health = await (await fetch(`${base}/health`)).json();
    assert.equal(health.status, "ok");
  });
});

test("without RAINREADY_PUBLIC_URL, links use the address the visitor used through the load balancer", async () => {
  await withDemoServer(async (base) => {
    const host = new URL(base).host;
    const headers = { origin: `https://${host}`, "x-forwarded-proto": "https", "x-forwarded-for": "203.0.113.50", "content-type": "application/json" };
    const reg = await fetch(`${base}/api/auth/register`, { method: "POST", headers, body: JSON.stringify({ email: "links@example.com", password: "correct horse battery staple", organizationName: "Links Club" }) });
    const cookie = reg.headers.get("set-cookie").split(";")[0];
    const organizationId = (await reg.json()).organizations[0].id;
    const api = (route, body) => fetch(`${base}${route}`, { method: body ? "POST" : "GET", headers: { ...headers, cookie, "x-rainready-organization": organizationId }, body: body ? JSON.stringify(body) : undefined });
    const event = (await (await api("/api/events", { name: "Run", venue: "Park", latitude: 1.3, longitude: 103.8, date: "2026-12-01", time: "08:00", type: "Sports", sensitivity: "low" })).json()).event;
    const link = (await (await api(`/api/events/${event.id}/join-link`, {})).json()).joinLink.url;
    assert.ok(link.startsWith(`https://${host}/join/`), link);
  });
});
