import test from "node:test";
import assert from "node:assert/strict";
import { buildRiskAssessment } from "./risk-assessment.mjs";

function snapshot({ forecast = "Light Rain", rainfall = 0.4, psi = 82, forecastFreshness = "current", rainFreshness = "current", airFreshness = "current" } = {}) {
  return {
    sources: {
      forecast: {
        data: forecast === null ? null : { nearestArea: { forecast } },
        freshness: { status: forecastFreshness },
      },
      rainfall: {
        data: rainfall === null ? null : { unit: "mm", nearestStation: { value: rainfall, name: "Test station", distanceKm: 1.2 } },
        freshness: { status: rainFreshness },
      },
      lightning: { data: { observations: [], interpretation: "observations only" }, freshness: { status: "current" } },
      airQuality: {
        data: psi === null ? null : {
          observedAt: "2026-10-06T15:00:00+08:00",
          nearestRegion: { name: "west", psiTwentyFourHourly: psi },
        },
        freshness: { status: airFreshness },
      },
    },
  };
}

test("scores current forecast, five-minute rainfall, and event sensitivity; excludes history", () => {
  const result = buildRiskAssessment({ snapshot: snapshot(), sensitivity: "high" });
  assert.equal(result.status, "current");
  assert.equal(result.inputs.forecast.score, 30);
  assert.equal(result.inputs.rainfall.fiveMinuteTotalMm, 0.4);
  assert.equal(result.inputs.rainfall.score, 35);
  assert.equal(result.inputs.sensitivity.score, 85);
  assert.equal(result.inputs.historicalProbability, null);
  assert.equal(result.breakdown.history, undefined);
  assert.ok(result.excludedComponents.some((item) => item.name === "historical_probability"));
  assert.match(result.formula, /remaining weights are renormalised/);
  assert.match(result.safetyNote, /not an official warning/);
  assert.equal(result.airQuality.level, "moderate");
  assert.equal(result.airQuality.psi, 82);
});

test("returns NEA-aligned air-quality advisory bands without adding PSI to the routine weather score", () => {
  const unhealthy = buildRiskAssessment({ snapshot: snapshot({ psi: 150 }), sensitivity: "medium" });
  assert.equal(unhealthy.airQuality.level, "unhealthy");
  assert.match(unhealthy.airQuality.advice, /Reduce prolonged or strenuous/);
  assert.equal(unhealthy.breakdown.airQuality, undefined);

  const hazardous = buildRiskAssessment({ snapshot: snapshot({ psi: 350, airFreshness: "stale" }), sensitivity: "medium" });
  assert.equal(hazardous.airQuality.level, "hazardous");
  assert.equal(hazardous.airQuality.status, "stale");
  assert.match(hazardous.airQuality.sensitiveGroupsAdvice, /Avoid outdoor activity/);
});

test("reports unavailable air quality explicitly", () => {
  const result = buildRiskAssessment({ snapshot: snapshot({ psi: null }), sensitivity: "medium" });
  assert.equal(result.airQuality.status, "unavailable");
  assert.equal(result.airQuality.psi, null);
});

test("organiser-confirmed lightning alert overrides the routine score even when forecast is unavailable", () => {
  const result = buildRiskAssessment({
    snapshot: snapshot({ forecast: null }),
    sensitivity: "low",
    lightningStatus: "confirmed_alert",
  });
  assert.equal(result.status, "override");
  assert.equal(result.score, 100);
  assert.equal(result.riskLevel, "critical");
  assert.equal(result.recommendedAction, "stop_and_shelter");
  assert.equal(result.lightningOverride.active, true);
  assert.match(result.lightningOverride.note, /does not infer an official warning/);
});

test("renormalises the remaining weights when rainfall is unavailable", () => {
  const result = buildRiskAssessment({ snapshot: snapshot({ rainfall: null }), sensitivity: "medium" });
  assert.equal(result.status, "partial");
  assert.equal(result.breakdown.rainfall, undefined);
  assert.equal(result.breakdown.forecast.weight + result.breakdown.sensitivity.weight, 1);
  assert.ok(result.excludedComponents.some((item) => item.name === "rainfall"));
});

test("does not turn missing forecast into a low-risk result", () => {
  const result = buildRiskAssessment({ snapshot: snapshot({ forecast: null }), sensitivity: "low" });
  assert.equal(result.status, "unavailable");
  assert.equal(result.score, null);
  assert.equal(result.riskLevel, "unavailable");
  assert.match(result.formula, /Do not interpret as low risk/);
});

test("marks a score stale when a required feed is stale", () => {
  const result = buildRiskAssessment({ snapshot: snapshot({ forecastFreshness: "stale" }), sensitivity: "low" });
  assert.equal(result.status, "stale");
  assert.ok(result.reasons.some((reason) => /stale/.test(reason)));
});

test("rejects an unknown sensitivity", () => {
  assert.throws(() => buildRiskAssessment({ snapshot: snapshot(), sensitivity: "extreme" }), RangeError);
});
