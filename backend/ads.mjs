/**
 * Sponsored messages (ads) for RainReady's Free plan.
 *
 * Who sees ads is decided on the server from the organisation's plan (organizations.plan):
 * Free organisations always see them; Community and Enterprise organisations never do. There is
 * no user setting to hide ads. Plans change only through `npm run plan` (later, a billing system).
 *
 * Ads are "house ads": a small catalogue of text-only sponsor messages served by the RainReady
 * backend itself. No third-party ad script, cookie or tracking pixel is loaded in the browser,
 * and no personal data is used to choose an ad. Selection is contextual only: the page the
 * organiser is on, and whether any upcoming event currently needs a wet-weather plan.
 *
 * Reporting is aggregated: one counter row per ad, placement and Singapore day (impressions and
 * clicks). No user, organisation or event identifier is stored with an ad event.
 *
 *   RAINREADY_ADS       house (default) | off
 *   RAINREADY_ADS_FILE  path to the catalogue JSON (default backend/ads-catalogue.json)
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

/** Where an ad may appear: one slot at the bottom of each workspace page, never inside forms or dialogs. */
export const AD_PLACEMENTS = Object.freeze(["overview", "events", "decisions", "settings"]);
/** Subscription plans (plans.mjs). Only paid plans are ad-free; users cannot switch ads off themselves. */
export { PLANS, isAdFreePlan } from "./plans.mjs";

/** Page context sent by the browser. "wet" means at least one upcoming event needs a wet-weather plan. */
export const AD_CONTEXTS = Object.freeze(["general", "wet"]);
const MODES = new Set(["house", "off"]);
const DEFAULT_CATALOGUE = path.join(path.dirname(fileURLToPath(import.meta.url)), "ads-catalogue.json");
const ID_PATTERN = /^[a-z0-9][a-z0-9-]{1,47}$/;
const LIMITS = { sponsor: 60, headline: 80, body: 160, cta: 24 };

export class AdConfigurationError extends Error {
  constructor(message) {
    super(message);
    this.name = "AdConfigurationError";
  }
}

export function adConfigFromEnv(environment = process.env) {
  const mode = String(environment.RAINREADY_ADS ?? "house").trim().toLowerCase() || "house";
  if (!MODES.has(mode)) throw new AdConfigurationError(`RAINREADY_ADS must be house or off, not "${mode}"`);
  return { mode, catalogueFile: String(environment.RAINREADY_ADS_FILE ?? "").trim() || DEFAULT_CATALOGUE };
}

function cleanText(value, field, id) {
  if (typeof value !== "string" || !value.trim()) throw new AdConfigurationError(`ad "${id}": ${field} is required`);
  const text = value.trim().replace(/\s+/g, " ");
  if (text.length > LIMITS[field]) throw new AdConfigurationError(`ad "${id}": ${field} must be ${LIMITS[field]} characters or fewer`);
  return text;
}

/** Validates a catalogue; throws AdConfigurationError on the first problem so a bad file is caught at start-up. */
export function validateCatalogue(raw) {
  const list = Array.isArray(raw) ? raw : raw?.ads;
  if (!Array.isArray(list)) throw new AdConfigurationError("the ad catalogue must be a JSON array or { \"ads\": [...] }");
  const seen = new Set();
  return list.map((entry, index) => {
    const id = entry?.id;
    if (typeof id !== "string" || !ID_PATTERN.test(id)) throw new AdConfigurationError(`ad #${index + 1}: id must be 2-48 lower-case letters, digits or hyphens`);
    if (seen.has(id)) throw new AdConfigurationError(`ad "${id}" appears twice`);
    seen.add(id);
    let url;
    try { url = new URL(entry.url); } catch { throw new AdConfigurationError(`ad "${id}": url is not a valid URL`); }
    if (url.protocol !== "https:" || url.username || url.password) throw new AdConfigurationError(`ad "${id}": url must be https:// without a user name or password`);
    const contexts = entry.contexts ?? ["general"];
    const placements = entry.placements ?? AD_PLACEMENTS;
    if (!Array.isArray(contexts) || !contexts.length || contexts.some((value) => !AD_CONTEXTS.includes(value))) {
      throw new AdConfigurationError(`ad "${id}": contexts must use ${AD_CONTEXTS.join(", ")}`);
    }
    if (!Array.isArray(placements) || !placements.length || placements.some((value) => !AD_PLACEMENTS.includes(value))) {
      throw new AdConfigurationError(`ad "${id}": placements must use ${AD_PLACEMENTS.join(", ")}`);
    }
    const weight = entry.weight ?? 1;
    if (!Number.isInteger(weight) || weight < 1 || weight > 100) throw new AdConfigurationError(`ad "${id}": weight must be a whole number from 1 to 100`);
    return {
      id,
      sponsor: cleanText(entry.sponsor, "sponsor", id),
      headline: cleanText(entry.headline, "headline", id),
      body: cleanText(entry.body, "body", id),
      cta: cleanText(entry.cta ?? "Learn more", "cta", id),
      url: url.href,
      contexts: [...new Set(contexts)],
      placements: [...new Set(placements)],
      weight,
      active: entry.active !== false,
    };
  });
}

export function loadCatalogue(file) {
  let text;
  try { text = readFileSync(file, "utf8"); } catch (error) { throw new AdConfigurationError(`could not read the ad catalogue ${file}: ${error.code ?? error.message}`); }
  let raw;
  try { raw = JSON.parse(text); } catch { throw new AdConfigurationError(`the ad catalogue ${file} is not valid JSON`); }
  return validateCatalogue(raw);
}

/** Singapore calendar day (YYYY-MM-DD) for the daily counters. */
export function singaporeDay(date = new Date()) {
  return new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Singapore" }).format(date);
}

/** The public fields of an ad, as sent to the browser (the destination stays server-side). */
export function publicAd(ad, placement) {
  return {
    id: ad.id,
    sponsor: ad.sponsor,
    headline: ad.headline,
    body: ad.body,
    cta: ad.cta,
    clickUrl: `/api/ads/${encodeURIComponent(ad.id)}/click?placement=${encodeURIComponent(placement)}`,
    destinationHost: new URL(ad.url).host,
  };
}

/**
 * createAdService({ mode, catalogue }, { random }) -> { enabled, mode, choose, find }
 * choose() prefers ads written for the current context, falls back to general ones,
 * and picks among them by weight. random is injectable for tests.
 */
export function createAdService({ mode = "house", catalogue = [] } = {}, { random = Math.random } = {}) {
  const enabled = mode === "house" && catalogue.some((ad) => ad.active);
  const active = catalogue.filter((ad) => ad.active);
  const byId = new Map(active.map((ad) => [ad.id, ad]));
  return {
    enabled,
    mode: enabled ? "house" : "off",
    count: active.length,
    find(id) { return enabled ? byId.get(id) ?? null : null; },
    choose({ placement, context = "general", excludeId = null }) {
      if (!enabled) return null;
      const eligible = active.filter((ad) => ad.placements.includes(placement));
      const matching = eligible.filter((ad) => ad.contexts.includes(context));
      let pool = matching.length ? matching : eligible.filter((ad) => ad.contexts.includes("general"));
      // Rotate: avoid showing the same ad twice in a row when there is an alternative.
      if (excludeId && pool.length > 1) pool = pool.filter((ad) => ad.id !== excludeId);
      if (!pool.length) return null;
      const total = pool.reduce((sum, ad) => sum + ad.weight, 0);
      let pick = random() * total;
      for (const ad of pool) {
        pick -= ad.weight;
        if (pick < 0) return ad;
      }
      return pool.at(-1);
    },
  };
}

/** Builds the service from the environment. A broken catalogue stops the server at start-up. */
export function createConfiguredAdService(environment = process.env) {
  const config = adConfigFromEnv(environment);
  if (config.mode === "off") return createAdService({ mode: "off" });
  return createAdService({ mode: "house", catalogue: loadCatalogue(config.catalogueFile) });
}
