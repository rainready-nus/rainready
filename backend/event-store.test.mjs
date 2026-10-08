import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createEventStore } from "./event-store.mjs";
import { createEventService, EventValidationError } from "./event-service.mjs";

const sample = {
  name: "Campus Sports Day",
  venue: "University Town Green",
  venueAddress: "NUS, Singapore",
  latitude: 1.304,
  longitude: 103.773,
  backupVenue: { name: "Sports Hall", address: "NUS, Singapore", latitude: 1.296, longitude: 103.78 },
  participantCount: 120,
  date: "2026-11-18",
  time: "16:00",
  type: "Sports",
  sensitivity: "high",
};

async function withStore(run) {
  const directory = await mkdtemp(path.join(os.tmpdir(), "rainready-events-"));
  const databasePath = path.join(directory, "events.sqlite");
  const store = createEventStore({ databasePath, legacyFilePath: null });
  try {
    await run(store, databasePath, directory);
  } finally {
    store.close();
    await rm(directory, { recursive: true, force: true });
  }
}

test("persists complete event data and reloads it from a fresh SQLite connection", async () => {
  await withStore(async (store, databasePath) => {
    const event = await createEventService(store).create(sample);
    assert.equal(event.name, sample.name);
    assert.equal(event.backupVenue.name, "Sports Hall");
    assert.equal(event.participantCount, 120);
    store.close();
    const reloaded = createEventStore({ databasePath, legacyFilePath: null });
    try {
      assert.deepEqual(await reloaded.get(event.id), event);
      assert.equal((await reloaded.list()).length, 1);
    } finally { reloaded.close(); }
  });
});

test("serialises concurrent writes without losing events", async () => {
  await withStore(async (store) => {
    const service = createEventService(store);
    const created = await Promise.all(Array.from({ length: 6 }, (_, index) => service.create({ ...sample, name: `Event ${index}` })));
    assert.equal((await service.list()).length, 6);
    assert.equal(new Set(created.map((event) => event.id)).size, 6);
  });
});

test("validates coordinates, participant count, sensitivity, and paired backup coordinates", async () => {
  await withStore(async (store) => {
    const service = createEventService(store);
    assert.throws(() => service.create({ ...sample, latitude: "" }), EventValidationError);
    assert.throws(() => service.create({ ...sample, latitude: 120 }), EventValidationError);
    assert.throws(() => service.create({ ...sample, participantCount: 2.5 }), EventValidationError);
    assert.throws(() => service.create({ ...sample, sensitivity: "extreme" }), EventValidationError);
    assert.throws(() => service.create({ ...sample, backupVenue: { name: "Hall", latitude: 1.2 } }), EventValidationError);
    assert.throws(() => service.create({ ...sample, backupVenue: { name: "Hall" } }), EventValidationError);
    assert.throws(() => service.create({ ...sample, date: "2026-02-30" }), EventValidationError);
  });
});

test("updates and deletes persisted events", async () => {
  await withStore(async (store) => {
    const service = createEventService(store);
    const event = await service.create(sample);
    const updated = await service.update(event.id, { participantCount: 140, backupVenue: null });
    assert.equal(updated.participantCount, 140);
    assert.equal(updated.backupVenue, null);
    assert.ok(updated.updatedAt >= event.updatedAt);
    assert.equal(await service.delete(event.id), true);
    assert.equal(await service.get(event.id), null);
    assert.equal(await service.delete(event.id), false);
  });
});

test("records a timestamped decision and test preview and reloads them from SQLite", async () => {
  await withStore(async (store, databasePath) => {
    const service = createEventService(store);
    const event = await service.create(sample);
    const result = await service.recordDecision(event.id, { action: "relocate", reason: "Heavy showers are forecast." });
    assert.equal(result.decision.action, "relocate");
    assert.equal(result.decision.reason, "Heavy showers are forecast.");
    assert.ok(Number.isFinite(Date.parse(result.decision.decidedAt)));
    assert.equal(result.decision.testNotification.mode, "test");
    assert.equal(result.decision.testNotification.status, "not_sent");
    assert.equal(result.decision.testNotification.intendedRecipientCount, sample.participantCount);
    assert.match(result.decision.testNotification.message, /TEST MODE — this preview was not sent/);
    store.close();
    const reloaded = createEventStore({ databasePath, legacyFilePath: null });
    try {
      assert.deepEqual(await reloaded.listDecisions(event.id), [result.decision]);
      assert.deepEqual((await reloaded.get(event.id)).decisions, [result.decision]);
    } finally { reloaded.close(); }
  });
});

test("rejects invalid actions, blank reasons, and relocation without a backup venue", async () => {
  await withStore(async (store) => {
    const service = createEventService(store);
    const event = await service.create(sample);
    await assert.rejects(service.recordDecision(event.id, { action: "maybe", reason: "Because" }), EventValidationError);
    await assert.rejects(service.recordDecision(event.id, { action: "cancel", reason: "  " }), EventValidationError);
    const noBackup = await service.create({ ...sample, name: "No backup event", backupVenue: null });
    await assert.rejects(service.recordDecision(noBackup.id, { action: "relocate", reason: "Move the event." }), EventValidationError);
  });
});

test("imports legacy JSON once and leaves the source file intact", async () => {
  await withStore(async (_store, databasePath, directory) => {
    const legacyFilePath = path.join(directory, "events.json");
    const legacyEvent = {
      id: "legacy-demo-id", ...sample, createdAt: "2026-10-01T00:00:00.000Z",
      updatedAt: "2026-10-01T00:00:00.000Z", decisions: [],
    };
    await writeFile(legacyFilePath, JSON.stringify([legacyEvent]));
    const imported = createEventStore({ databasePath, legacyFilePath });
    try {
      assert.equal((await imported.list()).length, 1);
      assert.equal((await imported.get(legacyEvent.id)).name, sample.name);
    } finally { imported.close(); }
    const reopened = createEventStore({ databasePath, legacyFilePath });
    try { assert.equal((await reopened.list()).length, 1); } finally { reopened.close(); }
    assert.deepEqual(JSON.parse(await (await import("node:fs/promises")).readFile(legacyFilePath, "utf8")), [legacyEvent]);
  });
});

