/**
 * Subscription plans and what each allows. Shared by ads, events, billing and the frontend copy.
 *
 *   free        1 event stored at a time (delete it to create another), sponsored messages
 *   community   up to 100 events, past events as templates, no sponsored messages
 *   enterprise  up to 500 events, as Community
 *
 * The event limit is enforced by the store inside the same transaction that inserts the event,
 * so neither a script nor two quick clicks can exceed it. Lowering a plan never deletes events:
 * an organisation over its new limit keeps them but cannot add more until it is under the limit.
 */
export const PLANS = Object.freeze(["free", "community", "enterprise"]);
export const PLAN_EVENT_LIMITS = Object.freeze({ free: 1, community: 100, enterprise: 500 });
export const PLAN_NAMES = Object.freeze({ free: "Free", community: "Community", enterprise: "Enterprise" });

export const isAdFreePlan = (plan) => PLANS.includes(plan) && plan !== "free";
export const canUseTemplates = (plan) => plan === "community" || plan === "enterprise";
export const eventLimitFor = (plan, limits = PLAN_EVENT_LIMITS) => limits[PLANS.includes(plan) ? plan : "free"];

export class PlanLimitError extends Error {
  constructor({ limit, count }) {
    super(`limit of ${limit} event${limit === 1 ? "" : "s"} reached`);
    this.name = "PlanLimitError";
    this.code = "plan_event_limit";
    this.limit = limit;
    this.count = count;
  }
}
