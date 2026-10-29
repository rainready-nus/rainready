#!/usr/bin/env node
/**
 * Prints sponsored-message results: impressions, clicks and click-through rate per ad and placement.
 *
 *   npm run ads:report                      # last 30 days
 *   npm run ads:report -- 2026-11-01 2026-11-30
 *
 * Reads the same database as the app (RAINREADY_DB_DRIVER, as in .env). The counters are
 * aggregated per day and hold no user or organisation identifiers.
 */
import path from "node:path";
import { fileURLToPath } from "node:url";
import { singaporeDay } from "./ads.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const DAY = /^\d{4}-\d{2}-\d{2}$/;

export function summariseAdStats(rows) {
  const groups = new Map();
  for (const row of rows) {
    const key = `${row.adId}\u0000${row.placement}`;
    const group = groups.get(key) ?? { adId: row.adId, placement: row.placement, impressions: 0, clicks: 0 };
    group.impressions += row.impressions;
    group.clicks += row.clicks;
    groups.set(key, group);
  }
  return [...groups.values()]
    .map((group) => ({ ...group, ctr: group.impressions ? group.clicks / group.impressions : null }))
    .sort((a, b) => b.impressions - a.impressions || a.adId.localeCompare(b.adId) || a.placement.localeCompare(b.placement));
}

/** Opens the same database as the app (RAINREADY_DB_DRIVER). Shared with plan.mjs. */
export async function openStore(environment = process.env) {
  const driver = (environment.RAINREADY_DB_DRIVER || "sqlite").toLowerCase();
  if (driver === "postgres") {
    const { createPgEventStore, pgConfigFromEnv } = await import("./event-store-pg.mjs");
    return createPgEventStore(pgConfigFromEnv(environment));
  }
  const { createEventStore } = await import("./event-store.mjs");
  return createEventStore({ databasePath: environment.RAINREADY_DB_FILE || path.join(root, "backend", "data", "rainready.sqlite"), legacyFilePath: null });
}

const isMain = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  const toDay = process.argv[3] ?? singaporeDay();
  const fromDay = process.argv[2] ?? singaporeDay(new Date(Date.now() - 29 * 86_400_000));
  if (!DAY.test(fromDay) || !DAY.test(toDay)) {
    console.error("Usage: npm run ads:report -- [fromDay YYYY-MM-DD] [toDay YYYY-MM-DD]");
    process.exit(1);
  }
  const store = await openStore();
  try {
    const summary = summariseAdStats(await store.ads.stats({ fromDay, toDay }));
    console.log(`Sponsored messages, ${fromDay} to ${toDay} (Singapore days)`);
    if (!summary.length) console.log("  No impressions or clicks recorded yet.");
    else {
      console.log(`  ${"Ad".padEnd(22)}${"Placement".padEnd(12)}${"Impressions".padStart(12)}${"Clicks".padStart(8)}${"CTR".padStart(8)}`);
      for (const row of summary) {
        const ctr = row.ctr === null ? "—" : `${(row.ctr * 100).toFixed(1)}%`;
        console.log(`  ${row.adId.padEnd(22)}${row.placement.padEnd(12)}${String(row.impressions).padStart(12)}${String(row.clicks).padStart(8)}${ctr.padStart(8)}`);
      }
      const total = summary.reduce((sum, row) => ({ impressions: sum.impressions + row.impressions, clicks: sum.clicks + row.clicks }), { impressions: 0, clicks: 0 });
      console.log(`  Total: ${total.impressions} impressions, ${total.clicks} clicks${total.impressions ? `, CTR ${(total.clicks / total.impressions * 100).toFixed(1)}%` : ""}`);
    }
  } finally {
    await store.close();
  }
}
