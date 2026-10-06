import { assessRisk, RISK_WEIGHTS } from "./risk-engine.mjs";

// These mappings are RainReady prototype assumptions, not official NEA risk standards.
export const RISK_MAPPINGS = Object.freeze({
  forecast: Object.freeze([
    { match: /thundery|thunderstorm/, score: 85 },
    { match: /heavy shower|heavy rain/, score: 70 },
    { match: /shower|moderate rain/, score: 50 },
    { match: /light rain|drizzle/, score: 30 },
    { match: /cloudy|overcast/, score: 15 },
    { match: /partly cloudy|fair|sunny/, score: 5 },
  ]),
  rainfallFiveMinuteMm: Object.freeze([
    { maxExclusive: 0.001, score: 0 },
    { maxExclusive: 0.2, score: 15 },
    { maxExclusive: 1, score: 35 },
    { maxExclusive: 2, score: 60 },
    { maxExclusive: 5, score: 80 },
    { maxExclusive: Infinity, score: 100 },
  ]),
  sensitivity: Object.freeze({ low: 20, medium: 50, high: 85 }),
});

function scoreForecast(description) {
  if (typeof description !== "string" || !description.trim()) return null;
  const match = RISK_MAPPINGS.forecast.find((rule) => rule.match.test(description.toLowerCase()));
  return match?.score ?? null;
}

function scoreRainfall(value, unit) {
  if (!Number.isFinite(value) || !String(unit).toLowerCase().includes("mm")) return null;
  return RISK_MAPPINGS.rainfallFiveMinuteMm.find((band) => value < band.maxExclusive)?.score ?? 100;
}

function describeFreshness(source) {
  return source?.freshness?.status ?? "unavailable";
}

export function buildRiskAssessment({ snapshot, sensitivity } = {}) {
  const sensitivityScore = RISK_MAPPINGS.sensitivity[sensitivity];
  if (sensitivityScore === undefined) {
    throw new RangeError("sensitivity must be low, medium, or high");
  }

  const forecastSource = snapshot?.sources?.forecast;
  const rainfallSource = snapshot?.sources?.rainfall;
  const forecastText = forecastSource?.data?.nearestArea?.forecast;
  const forecastSeverity = scoreForecast(forecastText);
  const rain = rainfallSource?.data?.nearestStation?.value;
  const rainfallScore = scoreRainfall(rain, rainfallSource?.data?.unit);
  if (forecastSeverity === null) {
    return {
      status: "unavailable",
      score: null,
      riskLevel: "unavailable",
      recommendedAction: "manual_review_required",
      reasons: ["A usable official two-hour forecast was not returned; RainReady cannot calculate a weather risk score."],
      excludedComponents: [
        { name: "forecast", reason: forecastSource?.error || "No usable forecast text for the event location." },
        { name: "historical_probability", reason: "No validated event-matched historical probability is available." },
      ],
      formula: "Score unavailable: current forecast is required. Do not interpret as low risk.",
      lightning: snapshot?.sources?.lightning ?? null,
    };
  }

  const assessment = assessRisk({
    forecastSeverity,
    rainfallScore,
    historicalProbability: null,
    sensitivity: sensitivityScore,
  });
  const excludedComponents = [
    ...(rainfallScore === null ? [{ name: "rainfall", reason: rainfallSource?.error || "No usable nearby 5-minute rainfall reading with millimetre units was returned." }] : []),
    { name: "historical_probability", reason: "Not included: historical data have not yet been validated and matched to event location, date, and time." },
  ];
  const statusValues = [describeFreshness(forecastSource), describeFreshness(rainfallSource)];
  const status = statusValues.includes("stale") ? "stale" : rainfallScore === null || statusValues.includes("unavailable") ? "partial" : "current";
  const used = Object.entries(assessment.breakdown).map(([name, part]) => `${name} ${(part.weight * 100).toFixed(1)}%`);

  return {
    status,
    ...assessment,
    inputs: {
      forecast: { text: forecastText, score: forecastSeverity, freshness: describeFreshness(forecastSource) },
      rainfall: rainfallScore === null ? null : {
        fiveMinuteTotalMm: rain,
        score: rainfallScore,
        station: rainfallSource.data.nearestStation.name,
        distanceKm: rainfallSource.data.nearestStation.distanceKm,
        freshness: describeFreshness(rainfallSource),
      },
      sensitivity: { level: sensitivity, score: sensitivityScore },
      historicalProbability: null,
    },
    excludedComponents,
    formula: `Score = weighted average of available inputs (${used.join(" + ")}); base weights: forecast ${RISK_WEIGHTS.forecast}, rainfall ${RISK_WEIGHTS.rainfall}, history ${RISK_WEIGHTS.history}, sensitivity ${RISK_WEIGHTS.sensitivity}. Missing components are excluded and remaining weights are renormalised.`,
    reasons: [
      `Official two-hour forecast “${forecastText}” mapped to ${forecastSeverity}/100 (RainReady prototype mapping).`,
      ...(rainfallScore === null ? [] : [`Nearest station ${rainfallSource.data.nearestStation.name} recorded ${rain} mm in the latest five-minute total; mapped to ${rainfallScore}/100.`]),
      `Event sensitivity “${sensitivity}” mapped to ${sensitivityScore}/100 (RainReady prototype assumption).`,
      "Historical probability is not included in the score.",
      ...(status === "stale" ? ["At least one used data source is labelled stale; review its timestamp before acting."] : []),
    ],
    lightning: snapshot?.sources?.lightning ?? null,
    safetyNote: "This prototype score is decision support, not an official warning or a guarantee of safety. Lightning observations are not used as an official alert or all-clear.",
  };
}
