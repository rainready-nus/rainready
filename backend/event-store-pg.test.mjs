/**
 * PostgreSQL store tests. They run only when the RAINREADY_DB_* settings are present:
 *   npm run test:pg        (reads them from the root .env file)
 * With plain `npm test` (no database settings) every test here is skipped, so the normal
 * suite still passes without PostgreSQL or the `pg` package.
 *
 * Tests connect as rainready_app, so row-level security is active. Each run creates its own
 * organisations with random ids and leaves them in the database (decision history is
 * append-only). Reset a local Docker database with `docker compose down -v` when needed.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { createAuthService } from "./auth.mjs";
import { createEventService } from "./event-service.mjs";

const skip = process.env.RAINREADY_DB_PASSWORD
  ? false
  : "PostgreSQL settings not found: run `npm run test:pg` with RAINREADY_DB_* in .env";

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
const PASSWORD = "correct horse battery staple";
const unique = () => randomUUID().slice(0, 8);

let pgModule;
async function openStore() {
  pgModule ??= await import("./event-store-pg.mjs");
  return pgModule.createPgEventStore(pgModule.pgConfigFromEnv(process.env));
}

async function withStore(run) {
  const store = await openStore();
  try {
    await run(store);
  } finally {
    await store.close();
  }
}

/** A fresh organisation (and owner) so each test starts from an empty workspace. */
async function newOrganization(store) {
  const suffix = unique();
  const account = await store.auth.createAccount({
    userId: `pg-test-user-${suffix}`, email: `pg-test-${suffix}@example.com`, passwordHash: "test-hash",
    organizationId: `pg-test-org-${suffix}`, organizationName: `PG Test ${suffix}`, invitationTokenHash: null,
    now: new Date().toISOString(),
  });
  return account.organizationId;
}

test("PostgreSQL: persists an event and reloads it through a new connection pool", { skip }, async () => {
  let organizationId;
  let event;
  await withStore(async (store) => {
    organizationId = await newOrganization(store);
    event = await createEventService(store, { organizationId }).create(sample);
    assert.equal(event.name, sample.name);
    assert.equal(event.date, "2026-11-18");
    assert.equal(event.time, "16:00");
    assert.equal(event.backupVenue.name, "Sports Hall");
    assert.equal(event.participantCount, 120);
  });
  await withStore(async (store) => {
    assert.deepEqual(await store.get(organizationId, event.id), event);
    assert.equal((await store.list(organizationId)).length, 1);
  });
});

test("PostgreSQL: concurrent creates keep every event", { skip }, async () => {
  await withStore(async (store) => {
    const organizationId = await newOrganization(store);
    const service = createEventService(store, { organizationId });
    const created = await Promise.all(Array.from({ length: 6 }, (_, index) => service.create({ ...sample, name: `Event ${index}` })));
    assert.equal((await service.list()).length, 6);
    assert.equal(new Set(created.map((event) => event.id)).size, 6);
  });
});

test("PostgreSQL: updates and deletes events", { skip }, async () => {
  await withStore(async (store) => {
    const organizationId = await newOrganization(store);
    const service = createEventService(store, { organizationId });
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

test("PostgreSQL: records a decision with its test preview and reads it back unchanged", { skip }, async () => {
  let organizationId;
  let result;
  await withStore(async (store) => {
    organizationId = await newOrganization(store);
    const service = createEventService(store, { organizationId });
    const event = await service.create(sample);
    result = await service.recordDecision(event.id, { action: "relocate", reason: "Heavy showers are forecast." });
    assert.equal(result.decision.testNotification.status, "not_sent");
    assert.match(result.decision.testNotification.message, /TEST MODE — this preview was not sent/);
    assert.equal(result.event.decisions.length, 1);
  });
  await withStore(async (store) => {
    assert.deepEqual(await store.listDecisions(organizationId, result.event.id), [result.decision]);
    assert.deepEqual((await store.get(organizationId, result.event.id)).decisions, [result.decision]);
  });
});

test("PostgreSQL: another organisation cannot see or change events", { skip }, async () => {
  await withStore(async (store) => {
    const alpha = await newOrganization(store);
    const beta = await newOrganization(store);
    const event = await createEventService(store, { organizationId: alpha }).create(sample);
    const betaService = createEventService(store, { organizationId: beta });
    assert.deepEqual(await betaService.list(), []);
    assert.equal(await betaService.get(event.id), null);
    assert.equal(await betaService.update(event.id, { participantCount: 999 }), null);
    assert.equal(await betaService.listDecisions(event.id), null);
    assert.equal(await betaService.recordDecision(event.id, { action: "cancel", reason: "Not ours" }), null);
    assert.equal(await betaService.delete(event.id), false);
    assert.equal((await store.get(alpha, event.id)).participantCount, sample.participantCount);
  });
});

test("PostgreSQL: sign-up, login, invitations, member removal and logout", { skip }, async () => {
  await withStore(async (store) => {
    const auth = createAuthService(store.auth);
    const suffix = unique();
    const owner = await auth.register({ email: `owner-${suffix}@example.com`, password: PASSWORD, organizationName: `PG Club ${suffix}` });
    const organizationId = owner.organizations[0].id;
    assert.equal(owner.organizations[0].role, "owner");

    const login = await auth.login({ email: `OWNER-${suffix}@example.com`, password: PASSWORD });
    assert.equal(login.user.id, owner.user.id);
    await assert.rejects(auth.login({ email: `owner-${suffix}@example.com`, password: "wrong password!" }), { code: "invalid_credentials" });
    assert.equal((await auth.resolveSession(owner.session.token)).user.id, owner.user.id);

    const invitation = await auth.createInvitation({ userId: owner.user.id, organizationId });
    const member = await auth.register({ email: `member-${suffix}@example.com`, password: PASSWORD, invitationCode: invitation.code });
    assert.deepEqual(member.organizations.map(({ id, role }) => ({ id, role })), [{ id: organizationId, role: "member" }]);
    await assert.rejects(
      auth.register({ email: `again-${suffix}@example.com`, password: PASSWORD, invitationCode: invitation.code }),
      { code: "invalid_invitation" });
    await assert.rejects(
      auth.register({ email: `owner-${suffix}@example.com`, password: PASSWORD, organizationName: "Duplicate" }),
      { code: "email_exists" });
    await assert.rejects(auth.createInvitation({ userId: member.user.id, organizationId }), { code: "owner_required" });

    const members = await auth.listMembers({ userId: owner.user.id, organizationId });
    assert.deepEqual(members.map(({ role }) => role), ["owner", "member"]);

    await auth.removeMember({ userId: owner.user.id, organizationId, targetUserId: member.user.id });
    assert.equal(await auth.resolveSession(member.session.token), null);

    await auth.logoutAll(owner.user.id);
    assert.equal(await auth.resolveSession(owner.session.token), null);
    assert.equal(await auth.resolveSession(login.session.token), null);
  });
});

test("PostgreSQL: rate limit blocks after the allowed attempts", { skip }, async () => {
  await withStore(async (store) => {
    const keyHash = `pg-test-limit-${unique()}`;
    const attempt = () => store.auth.consumeRateLimit({ keyHash, now: Date.now(), windowMs: 60_000, maxAttempts: 3 });
    for (let index = 0; index < 3; index += 1) assert.equal((await attempt()).allowed, true);
    const blocked = await attempt();
    assert.equal(blocked.allowed, false);
    assert.ok(blocked.retryAfterSeconds > 0);
  });
});
