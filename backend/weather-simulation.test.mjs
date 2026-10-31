import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createServer } from "./server.mjs";
import { createEventStore } from "./event-store.mjs";
import { createAdService } from "./ads.mjs";
import { createMailer } from "./notifications.mjs";
import { billingConfigFromEnv } from "./billing.mjs";
import { buildRiskAssessment } from "./risk-assessment.mjs";
import { SIMULATIONS, isSimulation, labelSimulatedAssessment, simulateSnapshot } from "./weather-simulation.mjs";

// A quiet day: no NEA data at all, so anything alarming must come from the simulation.
const quietSnapshot = () => ({ retrievedAt: new Date().toISOString(), location: { latitude: 1.304, longitude: 103.773 }, sources: {} });
const eventStart = "2026-12-20T16:00:00+08:00"; // weeks ahead: beyond any real forecast

function assessed(scenario, sensitivity = "medium") {
  const snapshot = simulateSnapshot(quietSnapshot(), scenario, eventStart);
  const assessment = buildRiskAssessment({ snapshot, sensitivity, lightningStatus: scenario === "lightning" ? "confirmed_alert" : "none", eventDateTime: eventStart, activityType: "Sports" });
  return labelSimulatedAssessment(assessment, scenario);
}

test("each scenario produces the matching alert through the normal risk rules, labelled SIMULATED", () => {
  assert.deepEqual(Object.keys(SIMULATIONS), ["lightning", "thunderstorm", "haze"]);
  assert.equal(isSimulation("lightning"), true);
  assert.equal(isSimulation("toString"), false);
  assert.throws(() => simulateSnapshot(quietSnapshot(), "tornado", eventStart), RangeError);

  const lightning = assessed("lightning");
  assert.equal(lightning.riskLevel, "critical");
  assert.equal(lightning.recommendedAction, "stop_and_shelter");
  assert.equal(lightning.lightningOverride.active, true);
  assert.equal(lightning.lightningOverride.source, "developer simulation");

  const storm = assessed("thunderstorm");
  assert.equal(storm.window.mode, "scheduled_event_start", "a far-off event still gets an event-time result");
  assert.equal(storm.inputs.forecast.text, "Heavy Thundery Showers");
  assert.equal(storm.riskLevel, "critical");

  const haze = assessed("haze");
  assert.equal(haze.airQuality.psi, 180);
  assert.equal(haze.airQuality.level, "unhealthy");

  for (const result of [lightning, storm, haze]) {
    assert.match(result.reasons[0], /^SIMULATED \(developer demo\)/);
    assert.match(result.simulation.note, /not real weather/);
  }
});

test("the simulation keeps the real nearest area and region names", () => {
  const real = quietSnapshot();
  real.sources.forecast = { data: { nearestArea: { name: "Clementi", distanceKm: 1.2, forecast: "Fair" } }, freshness: { status: "current" } };
  real.sources.airQuality = { data: { nearestRegion: { name: "west", psiTwentyFourHourly: 40 } }, freshness: { status: "current" } };
  const simulated = simulateSnapshot(real, "haze", eventStart);
  assert.equal(simulated.sources.forecast.data.nearestArea.name, "Clementi");
  assert.equal(simulated.sources.airQuality.data.nearestRegion.name, "west");
  assert.equal(simulated.sources.airQuality.data.nearestRegion.psiTwentyFourHourly, 180);
  assert.equal(real.sources.airQuality.data.nearestRegion.psiTwentyFourHourly, 40, "the real snapshot is not changed");
  assert.equal(simulated.sources.forecast.data.validPeriod.start, "2026-12-20T15:00:00+08:00");
});

async function withServer(developer, run) {
  const directory = await mkdtemp(path.join(os.tmpdir(), "rainready-simulation-"));
  const store = createEventStore({ databasePath: path.join(directory, "events.sqlite"), legacyFilePath: null });
  const server = createServer({
    store, ads: createAdService({ mode: "off" }), mailer: createMailer({ mode: "outbox", publicUrl: "https://rainready.example.org" }),
    billing: billingConfigFromEnv({}), stripe: null, developer, snapshot: async () => quietSnapshot(),
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  try {
    await run(`http://127.0.0.1:${server.address().port}`);
  } finally {
    await new Promise((resolve) => server.close(resolve));
    store.close();
    await rm(directory, { recursive: true, force: true });
  }
}

async function signUp(base) {
  const response = await fetch(`${base}/api/auth/register`, {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ email: `s-${Math.random().toString(36).slice(2)}@example.com`, password: "correct horse battery staple", organizationName: "Outdoor Club" }),
  });
  const body = await response.json();
  const cookie = response.headers.get("set-cookie").split(";")[0];
  const organizationId = body.organizations[0].id;
  const api = (route, { method = "GET", body: payload } = {}) => fetch(`${base}${route}`, {
    method, headers: { cookie, "x-rainready-organization": organizationId, ...(payload === undefined ? {} : { "content-type": "application/json" }) },
    body: payload === undefined ? undefined : JSON.stringify(payload),
  });
  return { user: body.user, api };
}

const assessmentQuery = (extra = {}) => `/api/assessment?${new URLSearchParams({ latitude: "1.304", longitude: "103.773", sensitivity: "high", activityType: "Sports", eventDateTime: "2026-12-20T16:00", ...extra })}`;

test("only developers can simulate; decisions made under a simulation send emails marked DEMO", async () => {
  const developer = { enabled: true, userIds: new Set() };
  await withServer(developer, async (base) => {
    const dev = await signUp(base);
    developer.userIds.add(dev.user.id);
    const other = await signUp(base);

    // Everyone else: the parameter does not exist; the ordinary check still works.
    assert.equal((await other.api(assessmentQuery({ simulate: "lightning" }))).status, 404);
    const plain = await (await other.api(assessmentQuery())).json();
    assert.equal(plain.assessment.simulation, undefined);
    assert.notEqual(plain.assessment.riskLevel, "critical");

    assert.equal((await dev.api(assessmentQuery({ simulate: "tornado" }))).status, 400);
    const simulated = await (await dev.api(assessmentQuery({ simulate: "lightning" }))).json();
    assert.equal(simulated.assessment.riskLevel, "critical");
    assert.equal(simulated.assessment.simulation.scenario, "lightning");
    assert.equal(simulated.simulation.label, "Lightning alert");
    assert.equal((await (await dev.api("/api/dev/status")).json()).simulations.length, 3);

    // Decision + emails under the simulation.
    const event = (await (await dev.api("/api/events", { method: "POST", body: { name: "Campus Sports Day", venue: "Town Green", latitude: 1.304, longitude: 103.773, date: "2026-12-20", time: "16:00", type: "Sports", sensitivity: "high", participantCount: 50 } })).json()).event;
    await dev.api(`/api/dev/events/${event.id}/demo-participants`, { method: "POST", body: { count: 2 } });
    const preview = await (await dev.api(`/api/events/${event.id}/notification-preview?action=postpone&reason=Lightning&simulation=lightning`)).json();
    assert.match(preview.subject, /^\[RainReady DEMO\]/);
    const decided = await (await dev.api(`/api/events/${event.id}/decisions`, { method: "POST", body: { action: "postpone", reason: "Lightning alert (simulated)", notifyParticipants: true, simulation: "lightning" } })).json();
    assert.equal(decided.notification.sentCount, 2);
    const { emails } = await (await dev.api("/api/dev/outbox")).json();
    assert.equal(emails.length, 2);
    for (const email of emails) {
      assert.match(email.subject, /^\[RainReady DEMO\] Campus Sports Day: postponed/);
      assert.match(email.body, /^DEMONSTRATION ONLY/);
    }

    // Other organisations cannot see the event; a non-developer's simulation flag is ignored.
    const foreign = await (await other.api(`/api/events/${event.id}/notification-preview?action=postpone&simulation=lightning`)).json();
    assert.equal(foreign.error, "event_not_found");
    const own = (await (await other.api("/api/events", { method: "POST", body: { name: "Picnic", venue: "Park", latitude: 1.3, longitude: 103.8, date: "2026-12-21", time: "10:00", type: "Other", sensitivity: "low", participantCount: 5 } })).json()).event;
    const ownPreview = await (await other.api(`/api/events/${own.id}/notification-preview?action=postpone&simulation=lightning`)).json();
    assert.match(ownPreview.subject, /^\[RainReady\] Picnic: postponed/);
    assert.doesNotMatch(ownPreview.body, /DEMONSTRATION/);
  });
});
