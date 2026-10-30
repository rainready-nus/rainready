/**
 * Plan and billing: Stripe Checkout in TEST MODE for the Community plan.
 *
 *   RAINREADY_STRIPE_SECRET_KEY       sk_test_... or a restricted rk_test_... key (live keys are refused)
 *   RAINREADY_STRIPE_PRICE_COMMUNITY  price_... of a recurring price created in the Stripe dashboard
 *   RAINREADY_STRIPE_WEBHOOK_SECRET   whsec_... for POST /api/billing/webhook (optional locally)
 *   RAINREADY_PLAN_COMMUNITY_PRICE    label shown on the page, default "S$29 per month"
 *
 * The flow: an organisation owner clicks Upgrade -> the server creates a Checkout Session ->
 * the browser goes to Stripe's hosted page (test card 4242 4242 4242 4242) -> Stripe returns
 * to RainReady, which asks Stripe for that session and switches the plan only if it was paid
 * and belongs to this organisation. The signed webhook does the same in the cloud, and also
 * handles cancellations made in Stripe. No card details ever reach RainReady.
 * Uses Stripe's REST API with fetch; no Stripe package is needed.
 */
import { createHmac, timingSafeEqual } from "node:crypto";

const STRIPE_API = "https://api.stripe.com/v1";
export const ACTIVE_STATUSES = new Set(["active", "trialing", "past_due"]);

export class BillingError extends Error {
  constructor(status, code, message) {
    super(message);
    this.name = "BillingError";
    this.status = status;
    this.code = code;
  }
}

export function billingConfigFromEnv(environment = process.env) {
  const secretKey = String(environment.RAINREADY_STRIPE_SECRET_KEY ?? "").trim();
  const priceCommunity = String(environment.RAINREADY_STRIPE_PRICE_COMMUNITY ?? "").trim();
  const webhookSecret = String(environment.RAINREADY_STRIPE_WEBHOOK_SECRET ?? "").trim();
  if (secretKey && !/^(sk|rk)_test_/.test(secretKey)) {
    throw new BillingError(500, "stripe_live_key", "RAINREADY_STRIPE_SECRET_KEY must be a Stripe sandbox (test) key: sk_test_... or rk_test_.... Live payments are not enabled in this prototype.");
  }
  if (secretKey && !/^price_[A-Za-z0-9]+$/.test(priceCommunity)) {
    throw new BillingError(500, "stripe_price_missing", "Set RAINREADY_STRIPE_PRICE_COMMUNITY to the price_... id of the Community plan's recurring price.");
  }
  if (webhookSecret && !webhookSecret.startsWith("whsec_")) {
    throw new BillingError(500, "stripe_webhook_secret", "RAINREADY_STRIPE_WEBHOOK_SECRET must start with whsec_");
  }
  return {
    stripeEnabled: Boolean(secretKey),
    secretKey: secretKey || null,
    priceCommunity: priceCommunity || null,
    webhookSecret: webhookSecret || null,
    communityPriceLabel: String(environment.RAINREADY_PLAN_COMMUNITY_PRICE ?? "").trim() || "S$29 per month",
  };
}

export function planCatalogue(config) {
  return [
    { id: "free", name: "Free", price: "S$0", features: ["1 event at a time (delete it to create another)", "Weather risk, decisions and participant email updates", "Sponsored messages at the bottom of each page"], purchasable: false },
    { id: "community", name: "Community", price: config.communityPriceLabel, features: ["Up to 100 events", "Reuse past events as templates", "No sponsored messages"], purchasable: true },
    { id: "enterprise", name: "Enterprise", price: "Contact us", features: ["Up to 500 events", "Everything in Community", "Multi-venue governance, exports and API access"], purchasable: false },
  ];
}

function formBody(fields) {
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(fields)) if (value !== undefined && value !== null) params.append(key, String(value));
  return params.toString();
}

/** Minimal Stripe REST client. fetchImpl is injectable for tests. */
export function createStripeClient(config, { fetchImpl = fetch } = {}) {
  if (!config.stripeEnabled) return null;
  const call = async (method, path, fields = null) => {
    let response;
    try {
      response = await fetchImpl(`${STRIPE_API}${path}`, {
        method,
        headers: { authorization: `Bearer ${config.secretKey}`, ...(fields ? { "content-type": "application/x-www-form-urlencoded" } : {}) },
        body: fields ? formBody(fields) : undefined,
        signal: AbortSignal.timeout(15000),
      });
    } catch {
      throw new BillingError(502, "stripe_unreachable", "RainReady could not reach Stripe. Try again in a moment.");
    }
    const payload = await response.json().catch(() => null);
    if (response.status === 404 && method === "GET") return null; // unknown session or subscription
    if (!response.ok) {
      console.error("Stripe API error:", response.status, payload?.error?.message);
      throw new BillingError(502, "stripe_error", "Stripe could not complete the request.");
    }
    return payload;
  };
  return {
    createCheckoutSession({ organizationId, email, publicUrl }) {
      return call("POST", "/checkout/sessions", {
        mode: "subscription",
        "line_items[0][price]": config.priceCommunity,
        "line_items[0][quantity]": 1,
        client_reference_id: organizationId,
        "metadata[organization_id]": organizationId,
        "metadata[plan]": "community",
        "subscription_data[metadata][organization_id]": organizationId,
        "subscription_data[metadata][plan]": "community",
        customer_email: email,
        success_url: `${publicUrl}/?checkout=success&session_id={CHECKOUT_SESSION_ID}#billing`,
        cancel_url: `${publicUrl}/?checkout=cancelled#billing`,
      });
    },
    retrieveCheckoutSession(sessionId) {
      return call("GET", `/checkout/sessions/${encodeURIComponent(sessionId)}`);
    },
    retrieveSubscription(subscriptionId) {
      return call("GET", `/subscriptions/${encodeURIComponent(subscriptionId)}`);
    },
    cancelSubscription(subscriptionId) {
      return call("DELETE", `/subscriptions/${encodeURIComponent(subscriptionId)}`);
    },
  };
}

/** Verifies the Stripe-Signature header (HMAC-SHA256 of "t.body", within 5 minutes). */
export function verifyStripeSignature(rawBody, header, secret, { now = Date.now(), toleranceSeconds = 300 } = {}) {
  if (!secret || typeof header !== "string") return false;
  const parts = Object.groupBy(header.split(",").map((part) => part.split("=")), ([key]) => key.trim());
  const timestamp = Number(parts.t?.[0]?.[1]);
  const signatures = (parts.v1 ?? []).map(([, value]) => value);
  if (!Number.isFinite(timestamp) || !signatures.length) return false;
  if (Math.abs(now / 1000 - timestamp) > toleranceSeconds) return false;
  const expected = createHmac("sha256", secret).update(`${timestamp}.${rawBody}`).digest();
  return signatures.some((value) => {
    const given = Buffer.from(String(value), "hex");
    return given.length === expected.length && timingSafeEqual(given, expected);
  });
}

/**
 * What a paid Checkout Session means for an organisation, or null if it must not change anything.
 * A session stays "paid" for ever, so callers must also check the subscription's CURRENT status
 * (currentPlanFromStripe) before granting the plan; otherwise an old session could be replayed.
 */
export function planFromCheckoutSession(session, organizationId) {
  if (!session || session.object !== "checkout.session") return null;
  if (session.client_reference_id !== organizationId || session.metadata?.organization_id !== organizationId) return null;
  if (session.status !== "complete" || !["paid", "no_payment_required"].includes(session.payment_status)) return null;
  if (session.metadata?.plan !== "community") return null;
  const subscriptionId = typeof session.subscription === "string" ? session.subscription : session.subscription?.id ?? null;
  const customerId = typeof session.customer === "string" ? session.customer : session.customer?.id ?? null;
  return { plan: "community", status: "active", subscriptionId, customerId, checkoutSessionId: session.id };
}

/**
 * The plan an organisation should have right now, from the subscription's CURRENT state in
 * Stripe (not from the event or session that mentioned it). This makes replayed, repeated or
 * out-of-order webhook deliveries and old checkout sessions harmless.
 */
export async function currentPlanFromStripe(stripe, subscriptionId) {
  const subscription = subscriptionId ? await stripe.retrieveSubscription(subscriptionId) : null;
  if (!subscription) return null;
  const active = ACTIVE_STATUSES.has(subscription.status);
  return {
    plan: active ? "community" : "free",
    status: subscription.status,
    subscriptionId: subscription.id,
    customerId: typeof subscription.customer === "string" ? subscription.customer : subscription.customer?.id ?? null,
    organizationId: subscription.metadata?.organization_id ?? null,
  };
}

/** Applies one verified Stripe webhook event. Returns a short description for the log. */
export async function applyStripeEvent(store, stripe, event, now = new Date().toISOString()) {
  const object = event?.data?.object;
  let subscriptionId = null;
  let organizationId = null;
  let checkoutSessionId = null;
  if (event.type === "checkout.session.completed") {
    organizationId = object?.client_reference_id ?? null;
    if (!organizationId || !planFromCheckoutSession(object, organizationId)) return "ignored: checkout session not paid or not for a RainReady plan";
    subscriptionId = typeof object.subscription === "string" ? object.subscription : object.subscription?.id ?? null;
    checkoutSessionId = object.id;
  } else if (["customer.subscription.created", "customer.subscription.updated", "customer.subscription.deleted"].includes(event.type)) {
    subscriptionId = object?.id ?? null;
    organizationId = (subscriptionId ? (await store.billing.findBySubscriptionId(subscriptionId))?.organizationId : null) ?? object?.metadata?.organization_id ?? null;
  } else {
    return `ignored: ${event.type}`;
  }
  if (!subscriptionId || !organizationId) return "ignored: no subscription or organisation";
  const current = await currentPlanFromStripe(stripe, subscriptionId);
  if (!current) return "ignored: subscription not found in Stripe";
  if (current.organizationId && current.organizationId !== organizationId) return "ignored: subscription belongs to another organisation";
  // A subscription that is not the organisation's current one (for example an older, replaced
  // one) must not change its plan.
  const stored = await store.billing.get(organizationId);
  if (stored?.subscriptionId && stored.subscriptionId !== subscriptionId && stored.provider === "stripe" && stored.plan !== "free" && current.plan === "free") {
    return "ignored: not the organisation's current subscription";
  }
  const applied = await store.billing.apply(organizationId, {
    provider: "stripe", plan: current.plan, status: current.status, subscriptionId, customerId: current.customerId, checkoutSessionId, now,
  });
  return applied ? `organisation ${organizationId} -> ${current.plan} (${current.status})` : "ignored: unknown organisation";
}
