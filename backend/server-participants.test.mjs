import test from "node:test";
import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createServer } from "./server.mjs";
import { createEventStore } from "./event-store.mjs";
import { createAdService } from "./ads.mjs";
import { createMailer, composeDecisionEmail, mailerConfigFromEnv } from "./notifications.mjs";
import { billingConfigFromEnv, verifyStripeSignature } from "./billing.mjs";
import { developerConfigFromEnv } from "./developer.mjs";

const PUBLIC_URL = "https://rainready.example.org";
const outbox = () => createMailer({ mode: "outbox", publicUrl: PUBLIC_URL });

async function withServer(options, run) {
  const directory = await mkdtemp(path.join(os.tmpdir(), "rainready-participants-"));
  const store = createEventStore({ databasePath: path.join(directory, "events.sqlite"), legacyFilePath: null });
  const server = createServer({ store, ads: createAdService({ mode: "off" }), mailer: outbox(), billing: billingConfigFromEnv({}), stripe: null, developer: developerConfigFromEnv({}), ...options });
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

async function signUp(base, invitationCode = "") {
  const response = await fetch(`${base}/api/auth/register`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ email: `p-${Math.random().toString(36).slice(2)}@example.com`, password: "correct horse battery staple", organizationName: "Outdoor Club", invitationCode }),
  });
  const body = await response.json();
  assert.equal(response.status, 201, JSON.stringify(body));
  const cookie = response.headers.get("set-cookie").split(";")[0];
  const organizationId = body.organizations[0].id;
  const api = (route, { method = "GET", body: payload, headers = {} } = {}) => fetch(`${base}${route}`, {
    method,
    headers: { cookie, "x-rainready-organization": organizationId, ...(payload === undefined ? {} : { "content-type": "application/json" }), ...headers },
    body: payload === undefined ? undefined : JSON.stringify(payload),
  });
  return { cookie, organizationId, user: body.user, api, developer: body.developer };
}

const sampleEvent = { name: "Campus Sports Day", venue: "University Town Green", latitude: 1.304, longitude: 103.773, date: "2026-11-18", time: "16:00", type: "Sports", sensitivity: "high", participantCount: 120, backupVenue: { name: "NUS Sports Hall", address: "2 Sports Drive", latitude: 1.3006, longitude: 103.7753 } };

async function createEvent(owner, fields = {}) {
  const response = await owner.api("/api/events", { method: "POST", body: { ...sampleEvent, ...fields } });
  assert.equal(response.status, 201);
  return (await response.json()).event;
}

async function joinLink(owner, eventId) {
  const response = await owner.api(`/api/events/${eventId}/join-link`, { method: "POST", body: {} });
  assert.equal(response.status, 201);
  const { joinLink: link } = await response.json();
  assert.ok(link.url.startsWith(`${PUBLIC_URL}/join/`));
  return link.url.split("/join/")[1];
}

const join = (base, token, body, headers = {}) => fetch(`${base}/api/public/join/${token}`, { method: "POST", headers: { "content-type": "application/json", ...headers }, body: JSON.stringify(body) });

test("participants join through the event link with consent; organisers see and remove them", async () => {
  await withServer({}, async (base, store) => {
    const owner = await signUp(base);
    const event = await createEvent(owner);
    const token = await joinLink(owner, event.id);

    const page = await fetch(`${base}/join/${token}`);
    assert.equal(page.status, 200);
    assert.equal(page.headers.get("x-robots-tag"), "noindex");
    const info = await (await fetch(`${base}/api/public/join/${token}`)).json();
    assert.deepEqual(info.event, { name: "Campus Sports Day", date: "2026-11-18", time: "16:00", venue: "University Town Green" });
    assert.match(info.consentText, /Campus Sports Day/);
    assert.equal(JSON.stringify(info).includes(owner.organizationId), false, "no organisation id on the public page");

    assert.equal((await join(base, token, { email: "ana@example.com" })).status, 400, "consent is required");
    assert.equal((await join(base, token, { email: "not-an-email", consent: true })).status, 400);
    assert.equal((await join(base, token, { email: "ana@example.com", consent: true }, { origin: "https://evil.example" })).status, 403);
    assert.equal((await join(base, "x".repeat(32), { email: "ana@example.com", consent: true })).status, 404);
    const first = await join(base, token, { email: " Ana@Example.com ", name: "Ana <b>", consent: true });
    assert.equal(first.status, 200);
    const again = await join(base, token, { email: "ana@example.com", consent: true });
    assert.deepEqual(await again.json(), await first.json(), "same answer for a repeat sign-up");
    await join(base, token, { email: "ben@example.com", consent: true });

    const list = await (await owner.api(`/api/events/${event.id}/participants`)).json();
    assert.deepEqual(list.participants.map((p) => [p.email, p.name, p.consentSource]), [["ana@example.com", "Ana b", "join_link"], ["ben@example.com", "", "join_link"]]);
    assert.ok(list.joinLink.url.endsWith(token));
    assert.deepEqual((await (await owner.api("/api/participants/counts")).json()).counts, { [event.id]: 2 });

    // Another organisation cannot see or change them.
    const stranger = await signUp(base);
    assert.equal((await stranger.api(`/api/events/${event.id}/participants`)).status, 404);
    assert.equal((await stranger.api(`/api/events/${event.id}/join-link`, { method: "POST", body: {} })).status, 404);

    // A new link replaces the old one.
    const newToken = await joinLink(owner, event.id);
    assert.notEqual(newToken, token);
    assert.equal((await fetch(`${base}/api/public/join/${token}`)).status, 404);

    const ben = list.participants.find((p) => p.email === "ben@example.com");
    assert.equal((await owner.api(`/api/events/${event.id}/participants/${ben.id}`, { method: "DELETE" })).status, 200);
    assert.deepEqual((await store.participants.recipients(owner.organizationId, event.id)).map((r) => r.email), ["ana@example.com"]);
  });
});

test("confirming relocate with 'Email participants' emails subscribed participants once", async () => {
  await withServer({}, async (base, store) => {
    const owner = await signUp(base);
    const event = await createEvent(owner);
    const token = await joinLink(owner, event.id);
    for (const email of ["ana@example.com", "ben@example.com", "cat@example.com"]) await join(base, token, { email, consent: true });

    // Ben unsubscribes from the page; Cat with one click from her mail app.
    const benToken = (await store.participants.recipients(owner.organizationId, event.id)).find((r) => r.email === "ben@example.com").unsubscribeToken;
    const unsub = await (await fetch(`${base}/api/public/unsubscribe/${benToken}`)).json();
    assert.deepEqual(unsub, { eventName: "Campus Sports Day", email: "b••@example.com", unsubscribed: false });
    assert.equal((await fetch(`${base}/api/public/unsubscribe/${benToken}`, { method: "POST" })).status, 200);
    const catToken = (await store.participants.recipients(owner.organizationId, event.id)).find((r) => r.email === "cat@example.com").unsubscribeToken;
    const oneClick = await fetch(`${base}/unsubscribe/${catToken}`, { method: "POST", headers: { origin: "https://mail.example.net", "content-type": "application/x-www-form-urlencoded" }, body: "List-Unsubscribe=One-Click" });
    assert.equal(oneClick.status, 200);

    const preview = await (await owner.api(`/api/events/${event.id}/notification-preview?action=relocate&reason=Thunderstorms`)).json();
    assert.equal(preview.recipientCount, 1);
    assert.match(preview.subject, /moved to NUS Sports Hall/);

    // Without the flag, or for "continue", nobody is emailed.
    const quiet = await (await owner.api(`/api/events/${event.id}/decisions`, { method: "POST", body: { action: "prepare", reason: "Rain likely", notifyParticipants: true } })).json();
    assert.deepEqual(quiet.notification, { status: "not_requested" });
    const noFlag = await (await owner.api(`/api/events/${event.id}/decisions`, { method: "POST", body: { action: "postpone", reason: "Storm" } })).json();
    assert.deepEqual(noFlag.notification, { status: "not_requested" });

    const response = await owner.api(`/api/events/${event.id}/decisions`, { method: "POST", body: { action: "relocate", reason: "Thunderstorms forecast at 4 pm", notifyParticipants: true } });
    assert.equal(response.status, 201);
    const result = await response.json();
    assert.deepEqual(result.notification, { status: "sent", mailer: "outbox", recipientCount: 1, sentCount: 1, failedCount: 0 });

    const history = await (await owner.api("/api/notifications")).json();
    assert.equal(history.notifications.length, 1);
    assert.equal(history.notifications[0].decisionId, result.decision.id);
    assert.equal(history.notifications[0].eventName, "Campus Sports Day");

    const sentEmails = await store.notifications.outbox(owner.organizationId);
    assert.deepEqual(sentEmails.map((e) => [e.email, e.status]), [["ana@example.com", "sent"]]);
    assert.match(sentEmails[0].body, /New venue: NUS Sports Hall, 2 Sports Drive/);
    assert.match(sentEmails[0].body, /Thunderstorms forecast at 4 pm/);

    // The same decision is never notified twice.
    const { notifyParticipants } = await import("./notifications.mjs");
    const repeat = await notifyParticipants({ store, mailer: outbox(), organizationId: owner.organizationId, organizationName: "Outdoor Club", event: result.event, decision: result.decision });
    assert.equal(repeat.duplicate, true);
    assert.equal((await store.notifications.outbox(owner.organizationId)).length, 1);

    // No participants -> skipped, decision still saved. (A second event needs a paid plan.)
    await store.auth.setOrganizationPlan(owner.organizationId, "community");
    const empty = await createEvent(owner, { name: "Empty Event" });
    const skipped = await (await owner.api(`/api/events/${empty.id}/decisions`, { method: "POST", body: { action: "cancel", reason: "Haze", notifyParticipants: true } })).json();
    assert.deepEqual(skipped.notification, { status: "skipped", reason: "no_participants" });
    assert.equal(skipped.decision.action, "cancel");
  });
});

test("decision emails are plain text, mention the unsubscribe link, and keep headers on one line", () => {
  const email = composeDecisionEmail({
    event: { ...sampleEvent, name: "Fun Run\r\nBcc: victim@example.com" },
    decision: { action: "cancel", reason: "Line one\nLine two" },
    organizationName: "Club",
  });
  assert.equal(email.subject.includes("\n"), false);
  assert.equal(email.subject.includes("\r"), false);
  assert.match(email.body, /Unsubscribe: \{\{unsubscribe_url\}\}/);
  assert.match(email.body, /is cancelled/);
});

test("the SES mailer sends one message per recipient with one-click unsubscribe headers; failures are recorded", async () => {
  const sent = [];
  let fail = false;
  const sesClient = { async send(command) { if (fail) throw new Error("MessageRejected: Email address is not verified."); sent.push(command.input); return { MessageId: `m-${sent.length}` }; } };
  const mailer = createMailer({ mode: "ses", from: "RainReady <alerts@example.org>", region: "ap-southeast-1", publicUrl: PUBLIC_URL }, { sesClient });
  await withServer({ mailer }, async (base, store) => {
    const owner = await signUp(base);
    const event = await createEvent(owner);
    const token = await joinLink(owner, event.id);
    await join(base, token, { email: "ana@example.com", consent: true });
    const ok = await (await owner.api(`/api/events/${event.id}/decisions`, { method: "POST", body: { action: "postpone", reason: "Storm", notifyParticipants: true } })).json();
    assert.equal(ok.notification.status, "sent");
    assert.equal(sent.length, 1);
    assert.deepEqual(sent[0].Destination, { ToAddresses: ["ana@example.com"] });
    assert.equal(sent[0].FromEmailAddress, "RainReady <alerts@example.org>");
    const headers = Object.fromEntries(sent[0].Content.Simple.Headers.map((h) => [h.Name, h.Value]));
    assert.match(headers["List-Unsubscribe"], /^<https:\/\/rainready\.example\.org\/unsubscribe\/[A-Za-z0-9_-]+>$/);
    assert.equal(headers["List-Unsubscribe-Post"], "List-Unsubscribe=One-Click");
    assert.match(sent[0].Content.Simple.Body.Text.Data, /https:\/\/rainready\.example\.org\/unsubscribe\//);

    fail = true;
    const originalError = console.error;
    console.error = () => {};
    try {
      const failed = await (await owner.api(`/api/events/${event.id}/decisions`, { method: "POST", body: { action: "cancel", reason: "Storm", notifyParticipants: true } })).json();
      assert.equal(failed.notification.status, "partly_failed");
      assert.equal(failed.notification.failedCount, 1);
    } finally {
      console.error = originalError;
    }
    assert.match((await store.notifications.outbox(owner.organizationId))[0].error, /not verified/);
  });
});

test("mailer and billing configuration refuse unsafe settings", () => {
  assert.throws(() => mailerConfigFromEnv({ RAINREADY_MAILER: "smtp" }), /outbox or ses/);
  assert.throws(() => mailerConfigFromEnv({ RAINREADY_MAILER: "ses" }), /RAINREADY_MAIL_FROM/);
  assert.throws(() => mailerConfigFromEnv({ RAINREADY_PUBLIC_URL: "https://user:pw@example.org" }), /plain/);
  assert.equal(mailerConfigFromEnv({}).mode, "outbox");
  assert.throws(() => billingConfigFromEnv({ RAINREADY_STRIPE_SECRET_KEY: "sk_live_abc", RAINREADY_STRIPE_PRICE_COMMUNITY: "price_1" }), /test\) key/);
  assert.throws(() => billingConfigFromEnv({ RAINREADY_STRIPE_SECRET_KEY: "rk_live_abc", RAINREADY_STRIPE_PRICE_COMMUNITY: "price_1" }), /test\) key/);
  assert.equal(billingConfigFromEnv({ RAINREADY_STRIPE_SECRET_KEY: "rk_test_abc", RAINREADY_STRIPE_PRICE_COMMUNITY: "price_1" }).stripeEnabled, true);
  assert.throws(() => billingConfigFromEnv({ RAINREADY_STRIPE_SECRET_KEY: "sk_test_abc" }), /PRICE_COMMUNITY/);
  assert.equal(billingConfigFromEnv({}).stripeEnabled, false);
  assert.equal(developerConfigFromEnv({ RAINREADY_DEMO_TOOLS: "true" }).enabled, false, "needs developer user ids too");
});

// ---- Billing ---------------------------------------------------------------------

function fakeStripe() {
  const calls = [];
  const sessions = new Map();
  const subscriptions = new Map();
  return {
    calls,
    sessions,
    subscriptions,
    async createCheckoutSession(input) {
      calls.push(["create", input]);
      return { id: "cs_test_new", url: "https://checkout.stripe.com/c/pay/cs_test_new" };
    },
    async retrieveCheckoutSession(id) {
      calls.push(["retrieve", id]);
      return sessions.get(id) ?? null;
    },
    async retrieveSubscription(id) {
      return subscriptions.get(id) ?? null;
    },
    async cancelSubscription(id) {
      calls.push(["cancel", id]);
      const subscription = subscriptions.get(id);
      if (subscription) subscription.status = "canceled";
      return { id, status: "canceled" };
    },
  };
}
const paidSession = (organizationId, id = "cs_test_paid", subscription = "sub_123") => ({
  object: "checkout.session", id, client_reference_id: organizationId, metadata: { organization_id: organizationId, plan: "community" },
  status: "complete", payment_status: "paid", subscription, customer: "cus_123",
});
const liveSubscription = (organizationId, id = "sub_123", status = "active") => ({ id, status, customer: "cus_123", metadata: { organization_id: organizationId } });

test("Stripe checkout upgrades only after Stripe confirms a paid session for this organisation", async () => {
  const stripe = fakeStripe();
  const billing = billingConfigFromEnv({ RAINREADY_STRIPE_SECRET_KEY: "sk_test_x", RAINREADY_STRIPE_PRICE_COMMUNITY: "price_123" });
  await withServer({ stripe, billing, ads: createAdService({ catalogue: [{ id: "a1", sponsor: "S", headline: "H", body: "B", url: "https://example.com/a", contexts: ["general"], placements: ["overview", "events", "decisions", "settings"], weight: 1, active: true }] }) }, async (base, store) => {
    const owner = await signUp(base);
    const view = await (await owner.api("/api/billing")).json();
    assert.equal(view.plan, "free");
    assert.equal(view.stripeEnabled, true);
    assert.deepEqual(view.plans.map((p) => p.id), ["free", "community", "enterprise"]);

    const checkout = await owner.api("/api/billing/checkout", { method: "POST", body: { plan: "community" } });
    assert.equal(checkout.status, 201);
    assert.equal((await checkout.json()).url, "https://checkout.stripe.com/c/pay/cs_test_new");
    assert.equal(stripe.calls[0][1].organizationId, owner.organizationId);
    assert.equal(stripe.calls[0][1].publicUrl, PUBLIC_URL);

    // Unpaid, other organisation's, or unknown sessions change nothing.
    stripe.sessions.set("cs_test_unpaid", { ...paidSession(owner.organizationId, "cs_test_unpaid"), payment_status: "unpaid", status: "open" });
    stripe.sessions.set("cs_test_other", paidSession("someone-else", "cs_test_other"));
    for (const sessionId of ["cs_test_unpaid", "cs_test_other", "cs_test_missing"]) {
      assert.equal((await owner.api("/api/billing/confirm", { method: "POST", body: { sessionId } })).status, 409, sessionId);
    }
    assert.equal((await owner.api("/api/billing/confirm", { method: "POST", body: { sessionId: "../../v1/customers" } })).status, 400);
    assert.equal((await store.auth.getOrganization(owner.organizationId)).plan, "free");

    stripe.sessions.set("cs_test_paid", paidSession(owner.organizationId));
    stripe.subscriptions.set("sub_123", liveSubscription(owner.organizationId));
    const confirmed = await (await owner.api("/api/billing/confirm", { method: "POST", body: { sessionId: "cs_test_paid" } })).json();
    assert.equal(confirmed.plan, "community");
    assert.equal(confirmed.subscription.provider, "stripe");
    assert.equal((await (await owner.api("/api/ads?placement=overview")).json()).reason, "subscribed");
    assert.equal((await owner.api("/api/billing/checkout", { method: "POST", body: {} })).status, 409, "already subscribed");

    const cancelled = await (await owner.api("/api/billing/cancel", { method: "POST", body: {} })).json();
    assert.equal(cancelled.plan, "free");
    assert.deepEqual(stripe.calls.at(-1), ["cancel", "sub_123"]);

    // Review finding 1: replaying the old paid session after cancelling must not restore the plan.
    const replay = await owner.api("/api/billing/confirm", { method: "POST", body: { sessionId: "cs_test_paid" } });
    assert.equal(replay.status, 409);
    assert.equal((await store.auth.getOrganization(owner.organizationId)).plan, "free");
    // Cancelling again when Stripe already shows it cancelled does not call Stripe and does not fail.
    const callsBefore = stripe.calls.length;
    assert.equal((await owner.api("/api/billing/cancel", { method: "POST", body: {} })).status, 200);
    assert.equal(stripe.calls.length, callsBefore);
  });
});

test("checkout is refused while an active Stripe subscription exists, even if the plan says Free", async () => {
  const stripe = fakeStripe();
  const billing = billingConfigFromEnv({ RAINREADY_STRIPE_SECRET_KEY: "sk_test_x", RAINREADY_STRIPE_PRICE_COMMUNITY: "price_123" });
  await withServer({ stripe, billing }, async (base, store) => {
    const owner = await signUp(base);
    stripe.subscriptions.set("sub_live", liveSubscription(owner.organizationId, "sub_live"));
    await store.billing.apply(owner.organizationId, { provider: "stripe", plan: "community", status: "active", subscriptionId: "sub_live", now: new Date().toISOString() });
    // A developer demo switch to Free keeps the link to the Stripe subscription (review finding 7).
    await store.billing.apply(owner.organizationId, { provider: "developer", plan: "free", status: "canceled", now: new Date().toISOString() });
    assert.equal((await store.billing.get(owner.organizationId)).subscriptionId, "sub_live");
    assert.equal((await owner.api("/api/billing/checkout", { method: "POST", body: {} })).status, 409);
  });
});

test("only the owner can start or cancel a subscription", async () => {
  const stripe = fakeStripe();
  const billing = billingConfigFromEnv({ RAINREADY_STRIPE_SECRET_KEY: "sk_test_x", RAINREADY_STRIPE_PRICE_COMMUNITY: "price_123" });
  await withServer({ stripe, billing }, async (base) => {
    const owner = await signUp(base);
    const invite = await (await owner.api("/api/auth/invitations", { method: "POST", body: {} })).json();
    const member = await signUp(base, invite.code);
    assert.equal(member.organizationId, owner.organizationId);
    assert.equal((await member.api("/api/billing/checkout", { method: "POST", body: {} })).status, 403);
    assert.equal((await member.api("/api/billing/cancel", { method: "POST", body: {} })).status, 403);
    assert.equal((await (await member.api("/api/billing")).json()).canManage, false);
  });
});

test("without Stripe keys there is no payment, and the webhook route does not exist", async () => {
  await withServer({}, async (base) => {
    const owner = await signUp(base);
    assert.equal((await (await owner.api("/api/billing")).json()).stripeEnabled, false);
    assert.equal((await owner.api("/api/billing/checkout", { method: "POST", body: {} })).status, 503);
    assert.equal((await fetch(`${base}/api/billing/webhook`, { method: "POST", body: "{}" })).status, 404);
  });
});

test("signed Stripe webhooks follow the subscription's current state; unsigned, stale or replayed ones cannot grant a plan", async () => {
  const secret = "whsec_testsecret";
  const stripe = fakeStripe();
  const billing = billingConfigFromEnv({ RAINREADY_STRIPE_SECRET_KEY: "sk_test_x", RAINREADY_STRIPE_PRICE_COMMUNITY: "price_123", RAINREADY_STRIPE_WEBHOOK_SECRET: secret });
  const sign = (body, t = Math.floor(Date.now() / 1000)) => `t=${t},v1=${createHmac("sha256", secret).update(`${t}.${body}`).digest("hex")}`;
  await withServer({ stripe, billing }, async (base, store) => {
    const owner = await signUp(base);
    const plan = async () => (await store.auth.getOrganization(owner.organizationId)).plan;
    const post = (event, signature) => fetch(`${base}/api/billing/webhook`, { method: "POST", headers: { "stripe-signature": signature, "content-type": "application/json" }, body: event });
    const subscription = liveSubscription(owner.organizationId);
    stripe.subscriptions.set("sub_123", subscription);
    const completed = JSON.stringify({ id: "evt_1", type: "checkout.session.completed", data: { object: paidSession(owner.organizationId) } });
    const updated = (id) => JSON.stringify({ id, type: "customer.subscription.updated", data: { object: { id: "sub_123", status: subscription.status } } });
    assert.equal((await post(completed, "t=1,v1=00")).status, 400);
    assert.equal((await post(completed, sign(completed, Math.floor(Date.now() / 1000) - 3600))).status, 400, "older than 5 minutes");
    assert.equal((await post(completed.replace("paid", "unpaid"), sign(completed))).status, 400, "body changed after signing");
    const originalLog = console.log;
    console.log = () => {};
    try {
      assert.equal((await post(completed, sign(completed))).status, 200);
      assert.equal(await plan(), "community");

      // Review finding 3: a payment hiccup and recovery keeps the subscription linked.
      subscription.status = "incomplete";
      await post(updated("evt_2"), sign(updated("evt_2")));
      assert.equal(await plan(), "free");
      subscription.status = "active";
      await post(updated("evt_3"), sign(updated("evt_3")));
      assert.equal(await plan(), "community");

      // Cancelled in Stripe.
      subscription.status = "canceled";
      const deleted = JSON.stringify({ id: "evt_4", type: "customer.subscription.deleted", data: { object: { id: "sub_123", status: "canceled" } } });
      assert.equal((await post(deleted, sign(deleted))).status, 200);
      assert.equal(await plan(), "free");

      // Review finding 2: a late or replayed "completed" event after the cancellation does not restore the plan.
      assert.equal((await post(completed, sign(completed))).status, 200);
      assert.equal(await plan(), "free");
      // An out-of-order "updated: active" from before the cancellation is also harmless.
      const stale = JSON.stringify({ id: "evt_0", type: "customer.subscription.updated", data: { object: { id: "sub_123", status: "active" } } });
      await post(stale, sign(stale));
      assert.equal(await plan(), "free");
    } finally {
      console.log = originalLog;
    }
  });
  assert.equal(verifyStripeSignature("{}", "garbage", secret), false);
});

test("review fixes: no re-subscribe through the join link, no double emails, removal erases the address, room for a shared network", async () => {
  await withServer({}, async (base, store) => {
    const owner = await signUp(base);
    const event = await createEvent(owner);
    const token = await joinLink(owner, event.id);
    await join(base, token, { email: "victim@example.org", consent: true });
    await join(base, token, { email: "ana@example.com", consent: true });
    const victim = (await store.participants.recipients(owner.organizationId, event.id)).find((r) => r.email === "victim@example.org");

    // Finding 4: after unsubscribing, someone else typing the address does not re-subscribe it.
    await fetch(`${base}/api/public/unsubscribe/${victim.unsubscribeToken}`, { method: "POST" });
    const retry = await join(base, token, { email: "VICTIM@example.org", consent: true });
    assert.equal(retry.status, 200, "same answer as a normal sign-up");
    assert.deepEqual((await store.participants.recipients(owner.organizationId, event.id)).map((r) => r.email), ["ana@example.com"]);

    // Finding 5: a double submit sends one batch only.
    const decide = () => owner.api(`/api/events/${event.id}/decisions`, { method: "POST", body: { action: "relocate", reason: "Storm", notifyParticipants: true } });
    const [first, second] = await Promise.all([decide(), decide()]);
    const statuses = [(await first.json()).notification, (await second.json()).notification].map((n) => n.reason ?? n.status).sort();
    assert.deepEqual(statuses, ["already_emailed_recently", "sent"]);
    assert.equal((await store.notifications.outbox(owner.organizationId)).length, 1);

    // Finding 6: removing a participant erases their address from past deliveries too.
    const ana = (await (await owner.api(`/api/events/${event.id}/participants`)).json()).participants.find((p) => p.email === "ana@example.com");
    await owner.api(`/api/events/${event.id}/participants/${ana.id}`, { method: "DELETE" });
    const after = await store.notifications.outbox(owner.organizationId);
    assert.equal(after.some((e) => e.email.includes("ana@example.com") || e.body.includes("ana@example.com")), false);
    assert.match(after[0].email, /^removed:/);

    // Finding 8: many people on one network can join (separate counters for viewing and joining).
    for (let index = 0; index < 40; index += 1) {
      await fetch(`${base}/api/public/join/${token}`);
      const response = await join(base, token, { email: `crowd${index}@example.com`, consent: true });
      assert.equal(response.status, 200, `sign-up ${index}`);
    }
  });
});

test("an event's list stops at 500 participants", async () => {
  await withServer({}, async (base, store) => {
    const owner = await signUp(base);
    const event = await createEvent(owner);
    const now = new Date().toISOString();
    for (let index = 0; index < 500; index += 1) {
      await store.participants.add(owner.organizationId, event.id, { email: `p${index}@example.com`, consentSource: "demo", consentText: "demo", unsubscribeToken: `tok-${index}-abcdefghijklmnopqrstuvwxyz`, now });
    }
    const full = await store.participants.add(owner.organizationId, event.id, { email: "late@example.com", consentSource: "join_link", consentText: "x", unsubscribeToken: "tok-late-abcdefghijklmnopqrstuvwxyz", now });
    assert.equal(full.error, "list_full");
    const token = await joinLink(owner, event.id);
    assert.equal((await join(base, token, { email: "late@example.com", consent: true })).status, 409);
  });
});

// ---- Developer tools ------------------------------------------------------------

test("developer demo tools exist only for listed developer user ids", async () => {
  // Off by default: 404 for everyone.
  await withServer({}, async (base) => {
    const user = await signUp(base);
    assert.equal(user.developer, false);
    assert.equal((await user.api("/api/dev/status")).status, 404);
  });

  const developer = { enabled: true, userIds: new Set() };
  await withServer({ developer }, async (base, store) => {
    const dev = await signUp(base);
    developer.userIds.add(dev.user.id);
    const other = await signUp(base);
    assert.equal((await (await fetch(`${base}/api/auth/me`, { headers: { cookie: dev.cookie } })).json()).developer, true);
    assert.equal((await (await fetch(`${base}/api/auth/me`, { headers: { cookie: other.cookie } })).json()).developer, false);
    for (const [route, method] of [["/api/dev/status", "GET"], ["/api/dev/plan", "POST"], ["/api/dev/outbox", "GET"]]) {
      assert.equal((await other.api(route, { method, body: method === "POST" ? { plan: "community" } : undefined })).status, 404, route);
    }
    // The developer works in their own organisation; another organisation still needs membership.
    assert.equal((await dev.api("/api/dev/status", { headers: { "x-rainready-organization": other.organizationId } })).status, 403);

    const status = await (await dev.api("/api/dev/status")).json();
    assert.equal(status.mailer, "outbox");
    assert.equal((await (await dev.api("/api/dev/plan", { method: "POST", body: { plan: "community" } })).json()).plan, "community");
    assert.equal((await store.billing.get(dev.organizationId)).provider, "developer");
    assert.equal((await dev.api("/api/dev/plan", { method: "POST", body: { plan: "platinum" } })).status, 400);
    await dev.api("/api/dev/plan", { method: "POST", body: { plan: "free" } });
    assert.equal((await store.auth.getOrganization(dev.organizationId)).plan, "free");

    const event = await createEvent(dev);
    const added = await (await dev.api(`/api/dev/events/${event.id}/demo-participants`, { method: "POST", body: { count: 3 } })).json();
    assert.equal(added.added.length, 3);
    assert.ok(added.added.every((p) => p.email.endsWith("@example.com") && p.consentSource === "demo"));
    await dev.api(`/api/events/${event.id}/decisions`, { method: "POST", body: { action: "relocate", reason: "Storm", notifyParticipants: true } });
    const box = await (await dev.api("/api/dev/outbox")).json();
    assert.equal(box.emails.length, 3);
    assert.match(box.emails[0].body, /https:\/\/rainready\.example\.org\/unsubscribe\/[A-Za-z0-9_-]{20,}/);
    assert.equal(box.emails[0].unsubscribeToken, undefined);
  });
});

test("plans limit stored events: Free 1, Community 100, Enterprise 500; downgrades keep events but block new ones", async () => {
  await withServer({}, async (base, store) => {
    const owner = await signUp(base);
    const first = await createEvent(owner, { name: "First" });
    const blocked = await owner.api("/api/events", { method: "POST", body: { ...sampleEvent, name: "Second" } });
    assert.equal(blocked.status, 403);
    const body = await blocked.json();
    assert.equal(body.error, "plan_event_limit");
    assert.deepEqual([body.plan, body.limit, body.count], ["free", 1, 1]);
    assert.match(body.message, /Delete your current event/);
    // Delete it, then a new one is allowed.
    assert.equal((await owner.api(`/api/events/${first.id}`, { method: "DELETE" })).status, 200);
    await createEvent(owner, { name: "Replacement" });

    // Two simultaneous creates on Free: only one can win.
    const other = await signUp(base);
    const results = await Promise.all([1, 2].map((n) => other.api("/api/events", { method: "POST", body: { ...sampleEvent, name: `Race ${n}` } })));
    assert.deepEqual(results.map((r) => r.status).sort(), [201, 403]);

    // Community: up to 100.
    await store.auth.setOrganizationPlan(owner.organizationId, "community");
    for (let index = 1; index < 100; index += 1) await createEvent(owner, { name: `Event ${index}` });
    assert.equal(await store.count(owner.organizationId), 100);
    assert.equal((await owner.api("/api/events", { method: "POST", body: sampleEvent })).status, 403);
    const view = await (await owner.api("/api/billing")).json();
    assert.deepEqual(view.usage, { events: 100, eventLimit: 100, templates: true });

    // Enterprise: room for more.
    await store.auth.setOrganizationPlan(owner.organizationId, "enterprise");
    assert.equal((await owner.api("/api/events", { method: "POST", body: sampleEvent })).status, 201);

    // Back to Free: all 101 events are kept, but no new one until the organisation is under the limit again.
    await store.auth.setOrganizationPlan(owner.organizationId, "free");
    assert.equal((await (await owner.api("/api/events")).json()).events.length, 101);
    assert.equal((await owner.api("/api/events", { method: "POST", body: sampleEvent })).status, 403);
    assert.equal((await (await owner.api("/api/billing")).json()).usage.templates, false);
  });
});
