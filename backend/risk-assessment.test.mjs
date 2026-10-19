import test from "node:test";
import assert from "node:assert/strict";
import { buildRiskAssessment } from "./risk-assessment.mjs";

function snapshot({ forecast = "Light Rain", rainfall = 0.4, psi = 82, forecastFreshness = "current", rainFreshness = "current", airFreshness = "current", fourDayOutlook = null, fourDayFreshness = "current", fourDaySummary = "Afternoon thundery showers", fourDayTemperatureHigh = 34 } = {}) {
  return {
    retrievedAt: "2026-10-06T07:42:20.000Z",
    sources: {
      forecast: {
        data: forecast === null ? null : {
          nearestArea: { forecast },
          validPeriod: { start: "2026-10-06T15:30:00+08:00", end: "2026-10-06T17:30:00+08:00", text: "3:30 pm to 5:30 pm" },
        },
        freshness: { status: forecastFreshness },
      },
      eventForecast: {
        data: {
          region: "west",
          regionDistanceKm: 2,
          periods: [
            { start: "2026-10-06T15:00:00+08:00", end: "2026-10-06T18:00:00+08:00", label: "3 pm to 6 pm", text: "Showers" },
            { start: "2026-10-06T18:00:00+08:00", end: "2026-10-07T06:00:00+08:00", label: "6 pm to 6 am", text: "Thundery Showers" },
          ],
        },
        freshness: { status: "current" },
      },
      fourDayOutlook: {
        data: fourDayOutlook ? {
          updatedAt: "2026-10-06T15:41:00+08:00",
          scope: "Singapore-wide daily outlook; not venue-specific or time-of-day-specific",
          forecasts: [{
            date: "2026-10-08",
            day: "Thursday",
            summary: fourDaySummary,
            text: "Thundery Showers",
            temperature: { low: 25, high: fourDayTemperatureHigh },
            temperatureUnit: "Degrees Celsius",
            wind: { direction: "SE", speed: { low: 10, high: 20 }, speedUnit: null },
            relativeHumidity: { low: 60, high: 95 },
            relativeHumidityUnit: "Percentage",
          }],
        } : null,
        freshness: { status: fourDayFreshness },
        error: fourDayFreshness === "unavailable" ? "upstream unavailable" : null,
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
  assert.equal(unhealthy.airQuality.severityScore, 50);

  const hazardous = buildRiskAssessment({ snapshot: snapshot({ psi: 350, airFreshness: "stale" }), sensitivity: "medium" });
  assert.equal(hazardous.airQuality.level, "hazardous");
  assert.equal(hazardous.airQuality.status, "stale");
  assert.equal(hazardous.airQuality.severityScore, 100);
  assert.match(hazardous.airQuality.sensitiveGroupsAdvice, /Avoid outdoor activity/);
});

test("maps NEA PSI categories to a separate ordinal indicator and handles boundaries", () => {
  const cases = [[50, 0], [51, 25], [100, 25], [101, 50], [200, 50], [201, 75], [300, 75], [301, 100]];
  for (const [psi, expected] of cases) {
    const result = buildRiskAssessment({ snapshot: snapshot({ psi }), sensitivity: "medium" });
    assert.equal(result.airQuality.severityScore, expected, `PSI ${psi}`);
    assert.equal(result.breakdown.airQuality, undefined, `PSI ${psi} must remain outside the weather score`);
  }
});

test("maps specific partly-cloudy forecast before the generic cloudy rule", () => {
  const result = buildRiskAssessment({ snapshot: snapshot({ forecast: "Partly Cloudy" }), sensitivity: "medium" });
  assert.equal(result.inputs.forecast.score, 5);
});

test("maps heavy thundery wording to the highest prototype forecast severity", () => {
  const result = buildRiskAssessment({ snapshot: snapshot({ forecast: "Heavy Thundery Showers with Gusty Winds" }), sensitivity: "medium" });
  assert.equal(result.inputs.forecast.score, 100);
});

test("matches event start to the NEA local two-hour forecast window and excludes current rain", () => {
  const result = buildRiskAssessment({ snapshot: snapshot({ forecast: "Light Rain", rainfall: 4 }), sensitivity: "medium", eventDateTime: "2026-10-06T16:00:00+08:00" });
  assert.equal(result.score, 35);
  assert.equal(result.window.status, "covered");
  assert.equal(result.window.source, "NEA 2-hour local-area forecast");
  assert.equal(result.inputs.forecast.text, "Light Rain");
  assert.equal(result.inputs.rainfall, null);
  assert.ok(result.excludedComponents.some((item) => item.name === "current_rainfall"));
  assert.equal(result.breakdown.rainfall, undefined);
});

test("uses the same matched 24-hour regional forecast period when the local two-hour window does not cover the event", () => {
  const result = buildRiskAssessment({ snapshot: snapshot({ forecast: "Cloudy" }), sensitivity: "medium", eventDateTime: "2026-10-06T20:00:00+08:00" });
  assert.equal(result.window.source, "NEA 24-hour regional forecast");
  assert.equal(result.window.region, "west");
  assert.equal(result.inputs.forecast.text, "Thundery Showers");
  assert.equal(result.score, 77);
});

test("estimates a rough daily planning risk for a 2–4 day event and gives activity-aware advice", () => {
  const result = buildRiskAssessment({ snapshot: snapshot({ fourDayOutlook: true }), sensitivity: "medium", activityType: "Sports", eventDateTime: "2026-10-08T16:00:00+08:00" });
  assert.equal(result.status, "planning_only");
  assert.equal(result.score, 77);
  assert.equal(result.riskLevel, "critical");
  assert.equal(result.window.mode, "planning_outlook");
  assert.equal(result.planningOutlook.summary, "Afternoon thundery showers");
  assert.deepEqual(result.planningOutlook.temperature, { low: 25, high: 34 });
  assert.deepEqual(result.planningOutlook.wind.speed, { low: 10, high: 20 });
  assert.equal(result.planningOutlook.forecastSeverity, 85);
  assert.equal(result.planningOutlook.temperatureSeverity, 25);
  assert.equal(result.planningOutlook.dailyWeatherConcern, 85);
  assert.ok(result.planningOutlook.advice.some((item) => /shelter/.test(item)));
  assert.ok(result.planningOutlook.advice.some((item) => /drinking water/.test(item)));
  assert.ok(result.planningOutlook.advice.some((item) => /sports/.test(item)));
  assert.equal(result.airQuality, null);
  assert.match(result.formula, /Daily planning estimate/);
  assert.match(result.safetyNote, /not venue\/time-specific/);
  assert.ok(result.excludedComponents.some((item) => item.name === "future_psi"));
  assert.ok(result.excludedComponents.some((item) => item.name === "live_rainfall"));
});

test("uses the daily high-temperature prototype band for planning concern and heat advice", () => {
  const result = buildRiskAssessment({
    snapshot: snapshot({ fourDayOutlook: true, fourDaySummary: "Fair", fourDayTemperatureHigh: 36, psi: 160 }),
    sensitivity: "medium",
    activityType: "Sports",
    eventDateTime: "2026-10-08T16:00:00+08:00",
  });
  assert.equal(result.planningOutlook.forecastSeverity, 5);
  assert.equal(result.planningOutlook.temperatureSeverity, 50);
  assert.equal(result.planningOutlook.dailyWeatherConcern, 50);
  assert.equal(result.score, 50);
  assert.equal(result.planningOutlook.attentionLevel, "Prepare");
  assert.ok(result.planningOutlook.advice.some((item) => /drinking water/.test(item)));
  assert.equal(result.airQuality, null, "current PSI must not be represented as future PSI");
});

test("does not create a risk score beyond the four-day outlook horizon", () => {
  const result = buildRiskAssessment({ snapshot: snapshot(), sensitivity: "medium", eventDateTime: "2026-10-11T16:00:00+08:00" });
  assert.equal(result.status, "unavailable");
  assert.equal(result.score, null);
  assert.equal(result.window.mode, "planning_outlook");
  assert.equal(result.window.status, "unavailable");
  assert.match(result.reasons[0], /beyond the published four-day outlook/);
});

test("does not use a stale four-day outlook as a planning result", () => {
  const result = buildRiskAssessment({ snapshot: snapshot({ fourDayOutlook: true, fourDayFreshness: "stale" }), sensitivity: "medium", eventDateTime: "2026-10-08T16:00:00+08:00" });
  assert.equal(result.status, "stale");
  assert.equal(result.score, null);
  assert.equal(result.planningOutlook, null);
  assert.match(result.reasons[0], /outlook is delayed/);
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
