import test from "node:test";
import assert from "node:assert/strict";
import { buildRiskAssessment } from "./risk-assessment.mjs";

function snapshot({ forecast = "Light Rain", rainfall = 0.4, forecastFreshness = "current", rainFreshness = "current" } = {}) {
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
