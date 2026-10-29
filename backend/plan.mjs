#!/usr/bin/env node
/**
 * Shows or changes an organisation's subscription plan. Free organisations see sponsored
 * messages; Community and Enterprise organisations are ad-free.
 *
 *   npm run plan -- <organizationId>                 # show the plan
 *   npm run plan -- <organizationId> community       # free | community | enterprise
 *
 * This is the only way to change a plan: there is deliberately no HTTP route, so no user can
 * switch ads off from the browser. A billing system (for example a payment-provider webhook)
 * would call store.auth.setOrganizationPlan() after a successful payment.
 * The organisation ID is shown in the app under Settings › Workspace.
 */
import path from "node:path";
import { fileURLToPath } from "node:url";
import { PLANS } from "./ads.mjs";
import { openStore } from "./ads-report.mjs";

const isMain = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  const [organizationId, plan] = process.argv.slice(2);
  if (!organizationId || (plan && !PLANS.includes(plan))) {
    console.error(`Usage: npm run plan -- <organizationId> [${PLANS.join("|")}]`);
    process.exit(1);
  }
  const store = await openStore();
  try {
    const before = await store.auth.getOrganization(organizationId);
    if (!before) {
      console.error(`No organisation with ID ${organizationId}. Copy it from Settings › Workspace in the app.`);
      process.exitCode = 1;
    } else if (!plan) {
      console.log(`${before.name}: ${before.plan}${before.plan === "free" ? " (shows sponsored messages)" : " (ad-free)"}`);
    } else {
      await store.auth.setOrganizationPlan(organizationId, plan);
      console.log(`${before.name}: ${before.plan} -> ${plan}${plan === "free" ? " (sponsored messages on)" : " (ad-free)"}`);
    }
  } finally {
    await store.close();
  }
}
