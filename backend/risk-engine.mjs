/**
 * Explainable first-pass RainReady score. Inputs are already normalised to 0–100.
 * The weights/bands are project assumptions for the prototype, not official NEA guidance.
 */
const WEIGHTS = Object.freeze({ forecast: 0.50, rainfall: 0.20, history: 0.15, sensitivity: 0.15 });

function scoreInput(name, value, optional = false) {
  if (optional && (value === null || value === undefined)) return null;
  if (!Number.isFinite(value) || value < 0 || value > 100) {
    throw new RangeError(`${name} must be a finite number between 0 and 100`);
  }
  return value;
}

function bandFor(score) {
  if (score >= 75) return { riskLevel: "critical", recommendedAction: "review_cancel_or_relocate" };
  if (score >= 55) return { riskLevel: "high", recommendedAction: "prepare_contingency" };
  if (score >= 30) return { riskLevel: "medium", recommendedAction: "prepare_rain_plan" };
  return { riskLevel: "low", recommendedAction: "continue_and_monitor" };
}

export function assessRisk({
  forecastSeverity,
  rainfallScore,
  historicalProbability,
  sensitivity,
  lightningStatus = "none",
}) {
  if (!["none", "confirmed_alert"].includes(lightningStatus)) {
    throw new RangeError("lightningStatus must be none or confirmed_alert");
  }
  const lightningOverride = lightningStatus === "confirmed_alert";
  const inputs = {
    forecast: scoreInput("forecastSeverity", forecastSeverity, lightningOverride),
    rainfall: scoreInput("rainfallScore", rainfallScore, true),
    history: scoreInput("historicalProbability", historicalProbability, true),
    sensitivity: scoreInput("sensitivity", sensitivity),
  };
  const availableInputs = Object.fromEntries(Object.entries(inputs).filter(([, value]) => value !== null));
  const availableWeight = Object.keys(availableInputs).reduce((total, key) => total + WEIGHTS[key], 0);
  const breakdown = Object.fromEntries(Object.entries(availableInputs).map(([key, value]) => {
    const effectiveWeight = WEIGHTS[key] / availableWeight;
    return [key, {
      input: value,
      baseWeight: WEIGHTS[key],
      weight: Number(effectiveWeight.toFixed(4)),
      contribution: Number((value * effectiveWeight).toFixed(2)),
    }];
  }));

  // Safety override: a confirmed official alert bypasses ordinary score thresholds.
  if (lightningOverride) {
    return {
      score: 100,
      riskLevel: "critical",
      recommendedAction: "stop_and_shelter",
      override: true,
      reasons: ["Confirmed lightning alert: stop outdoor activity and seek shelter."],
      breakdown: Object.fromEntries(Object.entries(availableInputs).map(([key, value]) => [key, {
        input: value,
        weight: WEIGHTS[key],
        contribution: Number((value * WEIGHTS[key]).toFixed(2)),
      }])),
    };
  }

  const score = Math.round(Object.values(breakdown).reduce((total, part) => total + part.contribution, 0));
  return {
    score,
    ...bandFor(score),
    override: false,
    reasons: Object.entries(breakdown)
      .filter(([, part]) => part.contribution > 0)
      .sort((a, b) => b[1].contribution - a[1].contribution)
      .map(([component, part]) => `${component} contributed ${part.contribution} points (${part.input} × ${part.weight}).`),
    breakdown,
  };
}

export const RISK_WEIGHTS = WEIGHTS;
