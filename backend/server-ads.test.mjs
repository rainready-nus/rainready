import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createServer } from "./server.mjs";
import { createEventStore } from "./event-store.mjs";
import { createAdService, singaporeDay, validateCatalogue } from "./ads.mjs";

const catalogue = validateCatalogue([
  { id: "tent", sponsor: "Demo Tents", headline: "Tents", body: "Tents for rain.", url: "https://example.com/tents", contexts: ["wet"] },
  { id: "water", sponsor: "Demo Water", headline: "Water", body: "Water stations.", url: "https://example.com/water", contexts: ["general"] },
]);

async function withServer(ads, run) {
  const directory = await mkdtemp(path.join(os.tmpdir(), "rainready-server-ads-"));
  const store = createEventStore({ databasePath: path.join(directory, "events.sqlite"), legacyFilePath: null });
  const server = createServer({ store, ads });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  try {
    await run(base, store);
  } finally {
    await new Promise((resolve) => server.close(resolve));
    store.close();
    await rm(directory, { recursive: true, force: true });
  }
}

async function signUp(base) {
  const response = await fetch(`${base}/api/auth/register`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ email: `ads-${Math.random().toString(36).slice(2)}@example.com`, password: "correct horse battery staple", organizationName: "Ads Test Club" }),
  });
  assert.equal(response.status, 201);
  const body = await response.json();
  const cookie = response.headers.get("set-cookie").split(";")[0];
  const organizationId = body.organizations[0].id;
  assert.equal(body.organizations[0].plan, "free", "new organisations start on the Free plan");
  return { cookie, organizationId, headers: { cookie, "x-rainready-organization": organizationId } };
}

test("ad routes require a session and validate placement and context", async () => {
  await withServer(createAdService({ catalogue }), async (base) => {
    assert.equal((await fetch(`${base}/api/ads?placement=overview`)).status, 401);
    assert.equal((await fetch(`${base}/api/ads/tent/impression`, { method: "POST", body: "{}" })).status, 401);
    const { cookie, headers } = await signUp(base);
    // The plan belongs to the organisation, so the organisation header is required and checked.
    assert.equal((await fetch(`${base}/api/ads?placement=overview`, { headers: { cookie } })).status, 400);
    assert.equal((await fetch(`${base}/api/ads?placement=overview`, { headers: { cookie, "x-rainready-organization": "someone-else" } })).status, 403);
    const bad = await fetch(`${base}/api/ads?placement=login`, { headers });
    assert.equal(bad.status, 400);
    assert.equal((await fetch(`${base}/api/ads?placement=overview&context=storm`, { headers })).status, 400);
    const wet = await (await fetch(`${base}/api/ads?placement=overview&context=wet`, { headers })).json();
    assert.equal(wet.enabled, true);
    assert.equal(wet.plan, "free");
    assert.equal(wet.ad.id, "tent");
    assert.equal(wet.ad.url, undefined, "destination URL is not sent to the browser");
    const general = await (await fetch(`${base}/api/ads?placement=events`, { headers })).json();
    assert.equal(general.ad.id, "water");
    const health = await (await fetch(`${base}/health`)).json();
    assert.equal(health.ads, "house");
  });
});

test("impressions and clicks are counted per ad, placement and day, without user data", async () => {
  await withServer(createAdService({ catalogue }), async (base, store) => {
    const { cookie, headers: orgHeaders } = await signUp(base);
    const impression = (body, headers = {}) => fetch(`${base}/api/ads/tent/impression`, {
      method: "POST", headers: { ...orgHeaders, "content-type": "application/json", ...headers }, body: JSON.stringify(body),
    });
    assert.equal((await impression({ placement: "overview" })).status, 204);
    assert.equal((await impression({ placement: "overview" }, { origin: base })).status, 204);
    assert.equal((await impression({ placement: "overview" }, { origin: "https://evil.example" })).status, 403);
    assert.equal((await impression({ placement: "nowhere" })).status, 404);
    assert.equal((await fetch(`${base}/api/ads/unknown/impression`, { method: "POST", headers: orgHeaders, body: "{\"placement\":\"overview\"}" })).status, 404);

    const click = await fetch(`${base}/api/ads/tent/click?placement=events`, { headers: { cookie }, redirect: "manual" });
    assert.equal(click.status, 302);
    assert.equal(click.headers.get("location"), "https://example.com/tents");
    assert.equal(click.headers.get("referrer-policy"), "no-referrer");
    assert.equal((await fetch(`${base}/api/ads/unknown/click?placement=events`, { headers: { cookie }, redirect: "manual" })).status, 404);
    assert.equal((await fetch(`${base}/api/ads/tent/click?placement=elsewhere`, { headers: { cookie }, redirect: "manual" })).status, 404);

    // A signed-out click still reaches the sponsor but is not counted.
    const anonymous = await fetch(`${base}/api/ads/tent/click?placement=events`, { redirect: "manual" });
    assert.equal(anonymous.status, 302);

    const day = singaporeDay();
    assert.deepEqual(await store.ads.stats({ fromDay: day, toDay: day }), [
      { adId: "tent", placement: "events", day, impressions: 0, clicks: 1 },
      { adId: "tent", placement: "overview", day, impressions: 2, clicks: 0 },
    ]);
  });
});

test("a failing ad counter never blocks the click-through", async () => {
  await withServer(createAdService({ catalogue }), async (base, store) => {
    const { cookie, headers } = await signUp(base);
    store.ads.record = async () => { throw new Error("database unavailable"); };
    const originalError = console.error;
    console.error = () => {};
    try {
      const click = await fetch(`${base}/api/ads/water/click?placement=settings`, { headers: { cookie }, redirect: "manual" });
      assert.equal(click.status, 302);
      const impression = await fetch(`${base}/api/ads/water/impression`, { method: "POST", headers, body: "{\"placement\":\"settings\"}" });
      assert.equal(impression.status, 204);
    } finally {
      console.error = originalError;
    }
  });
});

test("RAINREADY_ADS=off returns no ads and no click-throughs", async () => {
  await withServer(createAdService({ mode: "off" }), async (base) => {
    const { cookie, headers } = await signUp(base);
    const body = await (await fetch(`${base}/api/ads?placement=overview`, { headers })).json();
    assert.deepEqual(body, { enabled: false, reason: "turned_off", plan: "free", ad: null });
    assert.equal((await fetch(`${base}/api/ads/tent/click?placement=overview`, { headers: { cookie }, redirect: "manual" })).status, 404);
    assert.equal((await (await fetch(`${base}/health`)).json()).ads, "off");
  });
});

test("only a paid plan removes ads, and the plan is per organisation", async () => {
  await withServer(createAdService({ catalogue }), async (base, store) => {
    const free = await signUp(base);
    const paid = await signUp(base);
    assert.equal(await store.auth.setOrganizationPlan(paid.organizationId, "community"), true);

    const freeAds = await (await fetch(`${base}/api/ads?placement=overview`, { headers: free.headers })).json();
    assert.equal(freeAds.enabled, true);
    assert.ok(freeAds.ad);

    const paidAds = await (await fetch(`${base}/api/ads?placement=overview`, { headers: paid.headers })).json();
    assert.deepEqual(paidAds, { enabled: false, reason: "subscribed", plan: "community", ad: null });
    const me = await (await fetch(`${base}/api/auth/me`, { headers: { cookie: paid.cookie } })).json();
    assert.equal(me.organizations[0].plan, "community");

    // Nothing a paid organisation sends is counted as an impression.
    const sent = await fetch(`${base}/api/ads/tent/impression`, { method: "POST", headers: paid.headers, body: "{\"placement\":\"overview\"}" });
    assert.equal(sent.status, 204);
    assert.deepEqual(await store.ads.stats(), []);

    // There is no route that lets a user change the plan.
    for (const [method, path] of [["PATCH", "/api/organization"], ["POST", "/api/organization/plan"], ["PATCH", "/api/ads"], ["POST", "/api/ads/off"]]) {
      const response = await fetch(`${base}${path}`, { method, headers: { ...free.headers, "content-type": "application/json" }, body: "{\"plan\":\"community\"}" });
      assert.equal(response.status, 404, `${method} ${path}`);
    }
    assert.equal((await store.auth.getOrganization(free.organizationId)).plan, "free");

    // Downgrading brings ads back.
    await store.auth.setOrganizationPlan(paid.organizationId, "free");
    assert.equal((await (await fetch(`${base}/api/ads?placement=overview`, { headers: paid.headers })).json()).enabled, true);
    assert.throws(() => store.auth.setOrganizationPlan(free.organizationId, "platinum"));
  });
});
