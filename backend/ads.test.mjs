import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  AdConfigurationError, adConfigFromEnv, createAdService, createConfiguredAdService, loadCatalogue, publicAd, singaporeDay, validateCatalogue,
} from "./ads.mjs";
import { summariseAdStats } from "./ads-report.mjs";
import { createEventStore } from "./event-store.mjs";

const base = { sponsor: "Demo Co", headline: "A headline", body: "Some body text.", url: "https://example.com/a" };
const catalogue = validateCatalogue([
  { ...base, id: "wet-only", contexts: ["wet"], weight: 1 },
  { ...base, id: "general-a", contexts: ["general"], weight: 1 },
  { ...base, id: "general-b", contexts: ["general", "wet"], weight: 3, placements: ["overview"] },
  { ...base, id: "inactive", contexts: ["general"], active: false },
]);

test("the shipped demo catalogue is valid, fictional and links only to example.com", () => {
  const ads = loadCatalogue(adConfigFromEnv({}).catalogueFile);
  assert.ok(ads.length >= 3);
  for (const ad of ads) assert.equal(new URL(ad.url).hostname, "example.com", ad.id);
});

test("configuration defaults to house ads and can be turned off", () => {
  assert.equal(adConfigFromEnv({}).mode, "house");
  assert.equal(adConfigFromEnv({ RAINREADY_ADS: "OFF" }).mode, "off");
  assert.throws(() => adConfigFromEnv({ RAINREADY_ADS: "adsense" }), AdConfigurationError);
  const off = createConfiguredAdService({ RAINREADY_ADS: "off" });
  assert.equal(off.enabled, false);
  assert.equal(off.mode, "off");
  assert.equal(off.choose({ placement: "overview" }), null);
  assert.equal(off.find("canopy-hire"), null);
});

test("catalogue validation rejects unsafe or malformed ads", () => {
  const bad = (entry, pattern) => assert.throws(() => validateCatalogue([{ ...base, id: "x1", ...entry }]), pattern);
  bad({ url: "http://example.com" }, /https/);
  bad({ url: "https://user:pw@example.com" }, /https/);
  bad({ url: "javascript:alert(1)" }, /https/);
  bad({ id: "Bad Id" }, /id must be/);
  bad({ headline: "" }, /headline is required/);
  bad({ body: "x".repeat(161) }, /160 characters/);
  bad({ contexts: ["rainy"] }, /contexts/);
  bad({ placements: ["login"] }, /placements/);
  bad({ weight: 0 }, /weight/);
  assert.throws(() => validateCatalogue([{ ...base, id: "dup" }, { ...base, id: "dup" }]), /twice/);
  assert.throws(() => validateCatalogue({ nope: [] }), /JSON array/);
  // Whitespace is collapsed; text is stored as plain text and rendered with textContent.
  assert.equal(validateCatalogue([{ ...base, id: "ws", headline: "  two   words " }])[0].headline, "two words");
});

test("loadCatalogue reports unreadable and invalid files clearly", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "rainready-ads-"));
  try {
    const file = path.join(directory, "ads.json");
    await writeFile(file, "{not json");
    assert.throws(() => loadCatalogue(file), /not valid JSON/);
    assert.throws(() => loadCatalogue(path.join(directory, "missing.json")), /could not read/);
    assert.throws(() => createConfiguredAdService({ RAINREADY_ADS_FILE: file }), AdConfigurationError);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("choose() prefers ads for the context, respects placements and skips inactive ads", () => {
  const ids = (options, randoms) => randoms.map((value) => createAdService({ catalogue }, { random: () => value }).choose(options)?.id);
  // Wet context on the overview: wet-only (weight 1) and general-b (weight 3).
  assert.deepEqual(ids({ placement: "overview", context: "wet" }, [0, 0.24, 0.26, 0.99]), ["wet-only", "wet-only", "general-b", "general-b"]);
  // general-b is overview-only, so on Events only wet-only matches the wet context.
  assert.deepEqual(ids({ placement: "events", context: "wet" }, [0, 0.99]), ["wet-only", "wet-only"]);
  // General context never shows the wet-only ad or the inactive one.
  const seen = new Set(ids({ placement: "events", context: "general" }, [0, 0.3, 0.6, 0.99]));
  assert.deepEqual([...seen], ["general-a"]);
});

test("choose() falls back to general ads and rotates away from the last ad", () => {
  const onlyGeneral = validateCatalogue([{ ...base, id: "g1" }, { ...base, id: "g2" }]);
  const service = createAdService({ catalogue: onlyGeneral }, { random: () => 0 });
  assert.equal(service.choose({ placement: "settings", context: "wet" }).id, "g1");
  assert.equal(service.choose({ placement: "settings", excludeId: "g1" }).id, "g2");
  const single = createAdService({ catalogue: validateCatalogue([{ ...base, id: "solo" }]) });
  assert.equal(single.choose({ placement: "settings", excludeId: "solo" }).id, "solo");
  assert.equal(createAdService({ catalogue: [] }).enabled, false);
});

test("publicAd keeps the destination server-side and builds a counted click link", () => {
  const ad = publicAd(catalogue[0], "events");
  assert.equal(ad.clickUrl, "/api/ads/wet-only/click?placement=events");
  assert.equal(ad.destinationHost, "example.com");
  assert.equal("url" in ad, false);
});

test("singaporeDay uses the Singapore calendar", () => {
  assert.equal(singaporeDay(new Date("2026-10-27T16:30:00Z")), "2026-10-28");
  assert.equal(singaporeDay(new Date("2026-10-27T15:59:00Z")), "2026-10-27");
});

test("SQLite store keeps aggregated daily ad counters", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "rainready-ads-store-"));
  const store = createEventStore({ databasePath: path.join(directory, "ads.sqlite"), legacyFilePath: null });
  try {
    for (let i = 0; i < 3; i += 1) await store.ads.record({ adId: "canopy-hire", placement: "overview", day: "2026-11-01", kind: "impression" });
    await store.ads.record({ adId: "canopy-hire", placement: "overview", day: "2026-11-01", kind: "click" });
    await store.ads.record({ adId: "canopy-hire", placement: "events", day: "2026-11-02", kind: "impression" });
    const rows = await store.ads.stats({ fromDay: "2026-11-01", toDay: "2026-11-30" });
    assert.deepEqual(rows, [
      { adId: "canopy-hire", placement: "overview", day: "2026-11-01", impressions: 3, clicks: 1 },
      { adId: "canopy-hire", placement: "events", day: "2026-11-02", impressions: 1, clicks: 0 },
    ]);
    assert.deepEqual(await store.ads.stats({ fromDay: "2026-11-02", toDay: "2026-11-02" }), [rows[1]]);
    const summary = summariseAdStats(rows);
    assert.equal(summary[0].placement, "overview");
    assert.equal(summary[0].ctr, 1 / 3);
  } finally {
    store.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test("existing SQLite databases get a plan column with every organisation on Free", async () => {
  const { DatabaseSync } = await import("node:sqlite");
  const directory = await mkdtemp(path.join(os.tmpdir(), "rainready-plan-"));
  const file = path.join(directory, "old.sqlite");
  try {
    const old = new DatabaseSync(file);
    old.exec("CREATE TABLE organizations (id TEXT PRIMARY KEY, name TEXT NOT NULL, created_at TEXT NOT NULL); INSERT INTO organizations VALUES ('o1', 'Old Club', '2026-01-01T00:00:00Z');");
    old.close();
    const store = createEventStore({ databasePath: file, legacyFilePath: null });
    try {
      assert.deepEqual({ ...store.auth.getOrganization("o1") }, { id: "o1", name: "Old Club", plan: "free" });
      assert.equal(store.auth.setOrganizationPlan("o1", "enterprise"), true);
      assert.equal(store.auth.getOrganization("o1").plan, "enterprise");
      assert.equal(store.auth.setOrganizationPlan("missing", "community"), false);
    } finally {
      store.close();
    }
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
