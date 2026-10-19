import { assessRisk, RISK_WEIGHTS } from "./risk-engine.mjs";

// These mappings are RainReady prototype assumptions, not official NEA risk standards.
export const RISK_MAPPINGS = Object.freeze({
  forecast: Object.freeze([
    { match: /heavy thundery|heavy thunderstorm/, score: 100 },
    { match: /thundery|thunderstorm/, score: 85 },
    { match: /heavy shower|heavy rain/, score: 70 },
    { match: /shower|moderate rain/, score: 50 },
    { match: /light rain|drizzle/, score: 30 },
    { match: /hazy/, score: 30 },
    { match: /mist|fog|windy/, score: 25 },
    { match: /partly cloudy|fair|sunny/, score: 5 },
    { match: /cloudy|overcast/, score: 15 },
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

function scoreDailyTemperature(high) {
  if (!Number.isFinite(high)) return null;
  // Planning-only prototype bands; these are not NEA or medical thresholds.
  if (high >= 40) return 100;
  if (high >= 38) return 75;
  if (high >= 36) return 50;
  if (high >= 34) return 25;
  return 0;
}

function describeFreshness(source) {
  return source?.freshness?.status ?? "unavailable";
}

export function buildAirQualityAdvisory(source) {
  const region = source?.data?.nearestRegion;
  const psi = region?.psiTwentyFourHourly;
  const status = describeFreshness(source);
  if (!Number.isFinite(psi)) {
    return {
      status: "unavailable",
      level: "unavailable",
      psi: null,
      severityScore: null,
      region: region?.name ?? null,
      advice: "Air-quality advice is unavailable; check the latest official NEA health advisory before prolonged outdoor activity.",
      sensitiveGroupsAdvice: "People who feel unwell or have health concerns should seek appropriate medical advice.",
    };
  }

  const band = psi <= 50
    ? { level: "good", advice: "Normal activities.", sensitive: "Normal activities." }
    : psi <= 100
      ? { level: "moderate", advice: "Normal activities; monitor symptoms and official updates.", sensitive: "Normal activities, but reduce exposure if symptoms occur." }
      : psi <= 200
        ? { level: "unhealthy", advice: "Reduce prolonged or strenuous outdoor physical exertion.", sensitive: "Minimise prolonged or strenuous outdoor physical exertion; people with chronic lung or heart disease should avoid it." }
        : psi <= 300
          ? { level: "very_unhealthy", advice: "Avoid prolonged or strenuous outdoor physical exertion.", sensitive: "Minimise outdoor activity; people with chronic lung or heart disease should avoid outdoor activity." }
          : { level: "hazardous", advice: "Minimise outdoor activity.", sensitive: "Avoid outdoor activity." };

  return {
    status,
    level: band.level,
    psi,
    // RainReady's optional 5-step ordinal indicator follows NEA PSI bands;
    // it is not a continuous PSI normalization and is not part of the weather score.
    severityScore: psi <= 50 ? 0 : psi <= 100 ? 25 : psi <= 200 ? 50 : psi <= 300 ? 75 : 100,
    region: region.name,
    observedAt: source.data.observedAt ?? null,
    updatedAt: source.data.updatedAt ?? null,
    advice: band.advice,
    sensitiveGroupsAdvice: band.sensitive,
    basis: "NEA 24-hour PSI health-advisory bands (0-50, 51-100, 101-200, 201-300, above 300).",
    severityBasis: "RainReady ordinal display mapped from NEA PSI bands (0, 25, 50, 75, 100); shown separately and not included in the weather-risk score.",
  };
}

function forecastCoveringEvent(snapshot, eventDateTime) {
  if (!eventDateTime) return null;
  const targetMs = Date.parse(eventDateTime);
  if (!Number.isFinite(targetMs)) return null;
  const local = snapshot?.sources?.forecast;
  const localData = local?.data;
  const localStart = Date.parse(localData?.validPeriod?.start);
  const localEnd = Date.parse(localData?.validPeriod?.end);
  if (Number.isFinite(localStart) && Number.isFinite(localEnd) && targetMs >= localStart && targetMs < localEnd && localData?.nearestArea?.forecast) {
    return {
      text: localData.nearestArea.forecast,
      source: "NEA 2-hour local-area forecast",
      freshness: describeFreshness(local),
      start: localData.validPeriod.start,
      end: localData.validPeriod.end,
      label: localData.validPeriod.text ?? null,
      region: localData.nearestArea.name,
      regionDistanceKm: localData.nearestArea.distanceKm,
    };
  }
  const regional = snapshot?.sources?.eventForecast;
  const regionData = regional?.data;
  const period = regionData?.periods?.find((candidate) => {
    const start = Date.parse(candidate.start);
    const end = Date.parse(candidate.end);
    return Number.isFinite(start) && Number.isFinite(end) && targetMs >= start && targetMs < end;
  });
  if (!period) return null;
  return {
    text: period.text,
    source: "NEA 24-hour regional forecast",
    freshness: describeFreshness(regional),
    start: period.start,
    end: period.end,
    label: period.label,
    region: regionData.region,
    regionDistanceKm: regionData.regionDistanceKm,
  };
}

function singaporeDate(date) {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Singapore",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(date);
}

function calendarDayOffset(fromDate, toDate) {
  const from = Date.parse(`${fromDate}T00:00:00Z`);
  const to = Date.parse(`${toDate}T00:00:00Z`);
  return Number.isFinite(from) && Number.isFinite(to) ? Math.round((to - from) / 86_400_000) : null;
}

function planningOutlookForEvent(snapshot, eventDateTime) {
  if (!eventDateTime) return null;
  const targetDate = eventDateTime.slice(0, 10);
  const now = new Date(snapshot?.retrievedAt ?? Date.now());
  const dayOffset = calendarDayOffset(singaporeDate(now), targetDate);
  if (dayOffset === null || dayOffset < 2) return null;
  if (dayOffset > 4) return { dayOffset, targetDate, source: null, forecast: null };
  const source = snapshot?.sources?.fourDayOutlook;
  if (source?.freshness?.status !== "current") return { dayOffset, targetDate, source, forecast: null };
  const forecast = source.data?.forecasts?.find((entry) => entry.date === targetDate) ?? null;
  return { dayOffset, targetDate, source, forecast };
}

function planningAdvice(forecast, sensitivity, activityType) {
  const description = String(forecast.summary ?? forecast.text ?? "").toLowerCase();
  const advice = [];
  if (/thunder|thundery/.test(description)) {
    advice.push("Thunderstorms are mentioned in the daily outlook. Identify a nearby substantial shelter and prepare a pause-and-shelter procedure; check official warnings again on the event day.");
  } else if (/heavy shower|heavy rain/.test(description)) {
    advice.push("Heavy rain is possible. Confirm a sheltered alternative, protect equipment, and decide how you will notify participants if plans change.");
  } else if (/shower|rain/.test(description)) {
    advice.push("Rain is possible. Prepare rain protection and check whether the venue or ground remains suitable closer to the event.");
  } else {
    advice.push("No rain or thunder is stated in this daily summary, but conditions can change. Keep a weather check in the event-day plan.");
  }

  const temperatureHigh = forecast.temperature?.high;
  if (Number.isFinite(temperatureHigh) && temperatureHigh >= 33) {
    advice.push("Warm conditions are possible: plan drinking water, shaded rest, and breaks, especially for strenuous activities.");
  }
  if (sensitivity === "high") {
    advice.push("This event is marked high-sensitivity; prioritise a sheltered option and make the participant communication plan explicit.");
  }
  if (activityType === "Sports" && Number.isFinite(temperatureHigh) && temperatureHigh >= 33) {
    advice.push("For sports, consider reducing exertion or scheduling recovery breaks if it feels hot on the day.");
  } else if (activityType === "Performance" && /windy|gust/.test(description)) {
    advice.push("For a performance, check whether staging, lightweight props, and outdoor equipment can be secured.");
  } else if (activityType === "Community gathering" && /rain|shower|thunder/.test(description)) {
    advice.push("For a community gathering, check sheltered capacity and ensure participants know where to go if rain or thunder develops.");
  }
  return advice;
}

function planningAttentionLevel(score) {
  if (score >= 75) return "Contingency attention";
  if (score >= 55) return "Review the plan";
  if (score >= 30) return "Prepare";
  return "Routine planning";
}

function buildPlanningOutlookAssessment(planning, sensitivity, activityType) {
  const forecast = planning.forecast;
  const dateLabel = new Date(`${planning.targetDate}T12:00:00+08:00`).toLocaleDateString("en-SG", {
    timeZone: "Asia/Singapore",
    weekday: "long",
    day: "numeric",
    month: "short",
  });
  if (!forecast) {
    const reason = planning.dayOffset > 4
      ? "No official NEA forecast is currently available for this date; it is beyond the published four-day outlook. Check again after a later forecast update."
      : planning.source?.freshness?.status === "stale"
        ? "The NEA four-day outlook is delayed. No event-time score is available; check the official forecast again later."
        : "The NEA four-day outlook for this date is not currently available. No event-time score is available; check again after the next forecast update.";
    return {
      status: planning.source?.freshness?.status === "stale" ? "stale" : "unavailable",
      score: null,
      riskLevel: "unavailable",
      recommendedAction: "manual_review_required",
      reasons: [reason],
      window: { mode: "planning_outlook", status: "unavailable", eventDateTime: null, date: planning.targetDate, dayOffset: planning.dayOffset },
      planningOutlook: null,
      excludedComponents: [{ name: "event_time_score", reason: "The daily four-day outlook is not a precise venue/time forecast and is never converted into an event-time score." }],
      formula: "No score: daily outlook data are for advance planning only.",
      airQuality: null,
      lightning: null,
      lightningOverride: { active: false, status: "none" },
      safetyNote: "This Singapore-wide daily outlook is not specific to the event venue or start time and is not a safety assessment.",
    };
  }
  const forecastSeverity = scoreForecast(forecast.summary ?? forecast.text);
  if (forecastSeverity === null) {
    return {
      status: "unavailable",
      score: null,
      riskLevel: "unavailable",
      recommendedAction: "manual_review_required",
      reasons: ["The NEA daily forecast description could not be mapped to the prototype planning scale; review the official outlook manually."],
      window: { mode: "planning_outlook", status: "unavailable", eventDateTime: null, date: planning.targetDate, dayOffset: planning.dayOffset, source: "NEA 4-day Weather Forecast" },
      planningOutlook: null,
      excludedComponents: [{ name: "daily_planning_estimate", reason: "No supported forecast description is available; no score is invented." }],
      formula: "No estimate: forecast description is not mapped.",
      airQuality: null,
      lightning: null,
      lightningOverride: { active: false, status: "none" },
      safetyNote: "The daily outlook is not venue- or time-specific and is not a safety assessment.",
    };
  }
  const temperatureSeverity = scoreDailyTemperature(forecast.temperature?.high);
  const dailyWeatherConcern = Math.max(forecastSeverity, temperatureSeverity ?? 0);
  const estimate = assessRisk({ forecastSeverity: dailyWeatherConcern, rainfallScore: null, historicalProbability: null, sensitivity: RISK_MAPPINGS.sensitivity[sensitivity] });
  const advice = planningAdvice(forecast, sensitivity, activityType);
  const effectiveWeights = Object.entries(estimate.breakdown).map(([name, part]) => `${name} ${(part.weight * 100).toFixed(1)}%`);
  return {
    status: "planning_only",
    ...estimate,
    reasons: [`NEA daily outlook for ${dateLabel}: ${forecast.summary ?? forecast.text ?? "Forecast description unavailable"}; forecast wording maps to ${forecastSeverity}/100 and the high-temperature indicator maps to ${temperatureSeverity ?? "unavailable"}/100. The higher value (${dailyWeatherConcern}/100) is used as the daily weather-concern input.`, `Event sensitivity “${sensitivity}” is included as a planning factor; no live rain or future PSI is used.`],
    window: { mode: "planning_outlook", status: "planning_only", eventDateTime: null, date: planning.targetDate, dayOffset: planning.dayOffset, source: "NEA 4-day Weather Forecast", updatedAt: planning.source.data.updatedAt },
    planningOutlook: {
      date: planning.targetDate,
      day: forecast.day,
      summary: forecast.summary ?? forecast.text ?? null,
      text: forecast.text,
      temperature: forecast.temperature,
      temperatureUnit: forecast.temperatureUnit,
      wind: forecast.wind,
      relativeHumidity: forecast.relativeHumidity,
      relativeHumidityUnit: forecast.relativeHumidityUnit,
      forecastSeverity,
      temperatureSeverity,
      dailyWeatherConcern,
      attentionLevel: planningAttentionLevel(estimate.score),
      advice,
      updatedAt: planning.source.data.updatedAt,
      freshness: planning.source.freshness.status,
      scope: planning.source.data.scope,
    },
    excludedComponents: [
      { name: "live_rainfall", reason: "Current rainfall is not a forecast for the event date." },
      { name: "historical_probability", reason: "No validated event-matched historical probability is available." },
      { name: "future_psi", reason: "The regular PSI feed is a current regional reading, not a four-day forecast." },
      ...(forecast.wind?.speed && !forecast.wind.speedUnit ? [{ name: "wind_speed_score", reason: "The feed does not provide a validated unit for numeric wind thresholds; wind wording remains visible and can inform preparation advice." }] : []),
    ],
    formula: `Daily planning estimate = weighted average of daily weather concern (${dailyWeatherConcern}/100; maximum of mapped forecast wording ${forecastSeverity}/100 and high-temperature indicator ${temperatureSeverity ?? "unavailable"}/100) and sensitivity using the existing base weights (${effectiveWeights.join(" + ")}); rainfall ${RISK_WEIGHTS.rainfall} and history ${RISK_WEIGHTS.history} are excluded and remaining weights are renormalised. Temperature bands are prototype assumptions; wind numeric severity is not scored without a validated unit. This is not an event-time risk score.`,
    airQuality: null,
    lightning: null,
    lightningOverride: { active: false, status: "none" },
    safetyNote: "This rough daily planning estimate is based on a Singapore-wide daily forecast and RainReady prototype mappings. It is not venue/time-specific, not calibrated as a probability, and not an official warning. Recheck official forecasts closer to the event.",
  };
}

export function buildRiskAssessment({ snapshot, sensitivity, lightningStatus = "none", eventDateTime = null, activityType = "Other" } = {}) {
  const sensitivityScore = RISK_MAPPINGS.sensitivity[sensitivity];
  if (sensitivityScore === undefined) {
    throw new RangeError("sensitivity must be low, medium, or high");
  }
  if (!["none", "confirmed_alert"].includes(lightningStatus)) {
    throw new RangeError("lightningStatus must be none or confirmed_alert");
  }

  const forecastSource = snapshot?.sources?.forecast;
  const rainfallSource = snapshot?.sources?.rainfall;
  const lightningSource = snapshot?.sources?.lightning;
  const airQuality = buildAirQualityAdvisory(snapshot?.sources?.airQuality);
  const selectedForecast = eventDateTime ? forecastCoveringEvent(snapshot, eventDateTime) : null;
  const planning = eventDateTime && !selectedForecast ? planningOutlookForEvent(snapshot, eventDateTime) : null;
  if (planning && planning.dayOffset >= 2) {
    return buildPlanningOutlookAssessment(planning, sensitivity, activityType);
  }
  const forecastText = eventDateTime ? selectedForecast?.text : forecastSource?.data?.nearestArea?.forecast;
  const forecastSeverity = scoreForecast(forecastText);
  const rain = rainfallSource?.data?.nearestStation?.value;
  // A current five-minute reading must not be treated as a forecast for a future event.
  const rainfallScore = eventDateTime ? null : scoreRainfall(rain, rainfallSource?.data?.unit);
  if (lightningStatus === "confirmed_alert") {
    const assessment = assessRisk({
      forecastSeverity,
      rainfallScore,
      historicalProbability: null,
      sensitivity: sensitivityScore,
      lightningStatus,
    });
    return {
      status: "override",
      ...assessment,
      inputs: {
        forecast: forecastSeverity === null ? null : { text: forecastText, score: forecastSeverity, freshness: describeFreshness(forecastSource) },
        rainfall: rainfallScore === null ? null : { fiveMinuteTotalMm: rain, score: rainfallScore, freshness: describeFreshness(rainfallSource) },
        sensitivity: { level: sensitivity, score: sensitivityScore },
        historicalProbability: null,
      },
      excludedComponents: [{ name: "historical_probability", reason: "No validated event-matched historical probability is available." }],
      formula: "Lightning safety override: an organiser-confirmed demo alert bypasses the routine weather score.",
      lightning: lightningSource ?? null,
      lightningOverride: {
        active: true,
        status: "confirmed_alert",
        source: "organiser-confirmed demo alert",
        note: "This local prototype does not infer an official warning from the NEA observation feed and never auto-resumes an event.",
      },
      airQuality,
      safetyNote: "Stop outdoor activity and seek shelter under the confirmed demo alert. The organiser must reassess before resuming.",
    };
  }
  if (forecastSeverity === null) {
    const noWindowReason = eventDateTime
      ? planning && planning.dayOffset > 4
        ? "No official NEA forecast is currently available for this date; it is beyond the published four-day outlook. Check again after a later forecast update."
        : "No NEA forecast period currently covers the scheduled event start. Recheck when a new forecast is published; do not interpret this as low risk."
      : "A usable official two-hour forecast was not returned; RainReady cannot calculate a weather risk score.";
    return {
      status: "unavailable",
      score: null,
      riskLevel: "unavailable",
      recommendedAction: "manual_review_required",
      reasons: [noWindowReason],
      window: eventDateTime ? { mode: "scheduled_event_start", eventDateTime, status: "outside_forecast_coverage" } : null,
      excludedComponents: [
        { name: "forecast", reason: eventDateTime ? snapshot?.sources?.eventForecast?.error || "The scheduled time is outside the currently published forecast periods." : forecastSource?.error || "No usable forecast text for the event location." },
        ...(eventDateTime ? [{ name: "current_rainfall", reason: "The latest five-minute observation describes conditions now, not at the scheduled event time." }] : []),
        { name: "historical_probability", reason: "No validated event-matched historical probability is available." },
      ],
      formula: eventDateTime ? "Score unavailable: the scheduled event start is not covered by a current NEA forecast period. Do not interpret as low risk." : "Score unavailable: current forecast is required. Do not interpret as low risk.",
      lightning: lightningSource ?? null,
      lightningOverride: { active: false, status: "none" },
      airQuality,
    };
  }

  const assessment = assessRisk({
    forecastSeverity,
    rainfallScore,
    historicalProbability: null,
    sensitivity: sensitivityScore,
  });
  const excludedComponents = [
    ...(rainfallScore === null ? [{ name: eventDateTime ? "current_rainfall" : "rainfall", reason: eventDateTime ? "Excluded from the event-time score because this five-minute reading describes conditions now, not the scheduled start." : rainfallSource?.error || "No usable nearby 5-minute rainfall reading with millimetre units was returned." }] : []),
    { name: "historical_probability", reason: "Not included: historical data have not yet been validated and matched to event location, date, and time." },
  ];
  const statusValues = eventDateTime
    ? [selectedForecast.freshness]
    : [describeFreshness(forecastSource), describeFreshness(rainfallSource)];
  const status = statusValues.includes("stale") ? "stale" : !eventDateTime && (rainfallScore === null || statusValues.includes("unavailable")) ? "partial" : "current";
  const used = Object.entries(assessment.breakdown).map(([name, part]) => `${name} ${(part.weight * 100).toFixed(1)}%`);

  return {
    status,
    ...assessment,
    inputs: {
      forecast: { text: forecastText, score: forecastSeverity, freshness: eventDateTime ? selectedForecast.freshness : describeFreshness(forecastSource), source: selectedForecast?.source ?? "NEA 2-hour local-area forecast", period: selectedForecast ? { start: selectedForecast.start, end: selectedForecast.end, label: selectedForecast.label, region: selectedForecast.region, regionDistanceKm: selectedForecast.regionDistanceKm } : null },
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
    window: eventDateTime ? {
      mode: "scheduled_event_start",
      eventDateTime,
      status: "covered",
      source: selectedForecast.source,
      start: selectedForecast.start,
      end: selectedForecast.end,
      region: selectedForecast.region,
    } : { mode: "current_snapshot" },
    excludedComponents,
    formula: `Score = weighted average of available inputs (${used.join(" + ")}); base weights: forecast ${RISK_WEIGHTS.forecast}, rainfall ${RISK_WEIGHTS.rainfall}, history ${RISK_WEIGHTS.history}, sensitivity ${RISK_WEIGHTS.sensitivity}. Missing or time-misaligned components are excluded and remaining weights are renormalised.`,
    reasons: [
      eventDateTime
        ? `${selectedForecast.source} for ${eventDateTime} SGT covers “${selectedForecast.label ?? `${selectedForecast.start} to ${selectedForecast.end}`}”: ${forecastText}, mapped to ${forecastSeverity}/100.`
        : `Official two-hour forecast “${forecastText}” mapped to ${forecastSeverity}/100 (RainReady prototype mapping).`,
      ...(rainfallScore === null ? [] : [`Nearest station ${rainfallSource.data.nearestStation.name} recorded ${rain} mm in the latest five-minute total; mapped to ${rainfallScore}/100.`]),
      `Event sensitivity “${sensitivity}” mapped to ${sensitivityScore}/100 (RainReady prototype assumption).`,
      "Historical probability is not included in the score.",
      ...(status === "stale" ? ["At least one used data source is labelled stale; review its timestamp before acting."] : []),
    ],
    lightning: lightningSource ?? null,
    lightningOverride: { active: false, status: "none" },
    airQuality,
    safetyNote: "This prototype score is decision support, not an official warning or a guarantee of safety. Lightning observations are not used as an official alert or all-clear.",
  };
}
