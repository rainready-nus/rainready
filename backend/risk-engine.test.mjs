import test from "node:test";
import assert from "node:assert/strict";
import { assessRisk } from "./risk-engine.mjs";

const base = { forecastSeverity: 0, rainfallScore: 0, historicalProbability: 0, sensitivity: 0 };

test("uses the proposed component weights and returns an explanation", () => {
  const result = assessRisk({ ...base, forecastSeverity: 80, rainfallScore: 50, historicalProbability: 20, sensitivity: 40 });
  assert.equal(result.score, 59);
  assert.equal(result.riskLevel, "high");
  assert.equal(result.breakdown.forecast.contribution, 40);
  assert.match(result.reasons[0], /forecast contributed 40 points/);
});

test("classifies score-band boundaries", () => {
  assert.equal(assessRisk({ ...base, forecastSeverity: 58 }).riskLevel, "low"); // 29
  assert.equal(assessRisk({ ...base, forecastSeverity: 60 }).riskLevel, "medium"); // 30
  assert.equal(assessRisk({ ...base, forecastSeverity: 100, rainfallScore: 25 }).riskLevel, "high"); // 55
  assert.equal(assessRisk({ ...base, forecastSeverity: 100, rainfallScore: 100, historicalProbability: 34 }).riskLevel, "critical"); // 75
});

test("confirmed lightning overrides ordinary inputs and never suggests automatic resumption", () => {
  const result = assessRisk({ ...base, forecastSeverity: 0, lightningStatus: "confirmed_alert" });
  assert.equal(result.score, 100);
  assert.equal(result.riskLevel, "critical");
  assert.equal(result.recommendedAction, "stop_and_shelter");
  assert.equal(result.override, true);
});

test("rejects scores outside the documented input range", () => {
  assert.throws(() => assessRisk({ ...base, rainfallScore: 101 }), RangeError);
});
