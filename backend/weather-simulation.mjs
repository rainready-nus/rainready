/**
 * Developer-only extreme-weather simulation for demos.
 *
 * A developer (RAINREADY_DEMO_TOOLS + RAINREADY_DEVELOPER_USER_IDS) can ask for a risk check with
 * ?simulate=<scenario>. The real NEA snapshot is fetched as usual, then the parts the scenario
 * covers are replaced with simulated readings, so the normal risk rules, organiser decision and
 * participant emails can be shown end to end on any day. Nothing is stored: the simulation lasts
 * only while the developer's browser keeps asking for it, and every result is labelled SIMULATED.
 * Emails sent for a decision made under a simulation are marked as a demonstration.
 */
export const SIMULATIONS = Object.freeze({
  lightning: Object.freeze({
    label: "Lightning alert",
    summary: "Lightning detected near the venue: stop outdoor activity and seek shelter.",
    forecast: "Heavy Thundery Showers",
    lightning: true,
    psi: null,
    suggestedAction: "postpone",
    suggestedReason: "Lightning alert near the venue (simulated for the demo). Outdoor activity is stopped for everyone's safety.",
  }),
  thunderstorm: Object.freeze({
    label: "Heavy thunderstorm",
    summary: "Heavy thundery showers forecast at the event start.",
    forecast: "Heavy Thundery Showers",
    lightning: false,
    rainfallMm: 8,
    psi: null,
    suggestedAction: "relocate",
    suggestedReason: "Heavy thundery showers are forecast at the start time (simulated for the demo). Moving indoors to stay safe and dry.",
  }),
  haze: Object.freeze({
    label: "Unhealthy haze",
    summary: "24-hour PSI 180 (unhealthy): reduce prolonged or strenuous outdoor exertion.",
    forecast: "Hazy",
    lightning: false,
    psi: 180,
    suggestedAction: "cancel",
    suggestedReason: "Haze has reached an unhealthy level, PSI 180 (simulated for the demo). Cancelling the outdoor activity to protect participants' health.",
  }),
});

export const isSimulation = (value) => typeof value === "string" && Object.hasOwn(SIMULATIONS, value);

/** Public description of the scenarios, for the developer page. */
export function simulationCatalogue() {
  return Object.entries(SIMULATIONS).map(([id, s]) => ({ id, label: s.label, summary: s.summary, suggestedAction: s.suggestedAction, suggestedReason: s.suggestedReason }));
}

/** Singapore-time ISO string (+08:00) for a millisecond timestamp. */
const singaporeIso = (ms) => `${new Date(ms + 8 * 3_600_000).toISOString().slice(0, 19)}+08:00`;
const current = (data) => ({ data, freshness: { status: "current", ageMinutes: 0 }, error: null });

/**
 * Returns a copy of a weather snapshot with the scenario's readings in place. eventDateTime is
 * the event start ("YYYY-MM-DDTHH:mm:ss+08:00") or null for a current-conditions check.
 */
export function simulateSnapshot(snapshot, scenario, eventDateTime = null, now = new Date()) {
  const s = SIMULATIONS[scenario];
  if (!s) throw new RangeError(`simulate must be ${Object.keys(SIMULATIONS).join(", ")}`);
  const target = eventDateTime ? Date.parse(eventDateTime) : now.getTime();
  const nowIso = now.toISOString();
  const sources = { ...(snapshot?.sources ?? {}) };
  const area = sources.forecast?.data?.nearestArea;
  sources.forecast = current({
    observedAt: nowIso,
    updatedAt: nowIso,
    validPeriod: { start: singaporeIso(target - 3_600_000), end: singaporeIso(target + 3_600_000), text: "Simulated period around the event start" },
    nearestArea: { name: area?.name ?? "Simulated area", latitude: area?.latitude ?? null, longitude: area?.longitude ?? null, distanceKm: area?.distanceKm ?? 0, forecast: s.forecast },
  });
  if (s.rainfallMm !== undefined) {
    const station = sources.rainfall?.data?.nearestStation;
    sources.rainfall = current({
      observedAt: nowIso,
      unit: "mm",
      nearestStation: { name: station?.name ?? "Simulated station", latitude: station?.latitude ?? null, longitude: station?.longitude ?? null, distanceKm: station?.distanceKm ?? 0, value: s.rainfallMm },
    });
  }
  if (s.psi !== null) {
    const region = sources.airQuality?.data?.nearestRegion;
    sources.airQuality = current({
      observedAt: nowIso,
      updatedAt: nowIso,
      nearestRegion: { name: region?.name ?? "central", latitude: region?.latitude ?? null, longitude: region?.longitude ?? null, distanceKm: region?.distanceKm ?? 0, psiTwentyFourHourly: s.psi, pm25TwentyFourHourly: null },
      unit: { psi: "index", pm25TwentyFourHourly: "ug/m3" },
    });
  }
  return { ...snapshot, sources, simulation: { scenario, label: s.label } };
}

/** Labels an assessment built from a simulated snapshot, so nobody mistakes it for real weather. */
export function labelSimulatedAssessment(assessment, scenario) {
  const s = SIMULATIONS[scenario];
  const note = `SIMULATED (developer demo): ${s.label}. ${s.summary} This is not real weather.`;
  const labelled = {
    ...assessment,
    simulation: { scenario, label: s.label, summary: s.summary, note },
    reasons: [note, ...(assessment.reasons ?? [])],
  };
  if (assessment.lightningOverride?.active) {
    labelled.lightningOverride = { ...assessment.lightningOverride, source: "developer simulation", note: "Simulated lightning alert for a demo. Not an official NEA warning." };
  }
  return labelled;
}
