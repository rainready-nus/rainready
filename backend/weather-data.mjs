/**
 * Fetch and normalise the official NEA real-time feeds for RainReady.
 * This module reports observations and freshness; it does not make safety decisions.
 */

export const DATA_ENDPOINTS = Object.freeze({
  forecast: "https://api-open.data.gov.sg/v2/real-time/api/two-hr-forecast",
  rainfall: "https://api-open.data.gov.sg/v2/real-time/api/rainfall",
  lightning: "https://api-open.data.gov.sg/v2/real-time/api/weather?api=lightning",
  airQuality: "https://api-open.data.gov.sg/v2/real-time/api/psi",
});

const FRESHNESS_LIMITS_MS = Object.freeze({
  forecast: 60 * 60 * 1000,
  rainfall: 15 * 60 * 1000,
  lightning: 5 * 60 * 1000,
  airQuality: 90 * 60 * 1000,
});

const finiteCoordinate = (value, label, min, max) => {
  if (value === null || value === undefined || value === "") {
    throw new RangeError(`${label} is required`);
  }
  const number = Number(value);
  if (!Number.isFinite(number) || number < min || number > max) {
    throw new RangeError(`${label} must be between ${min} and ${max}`);
  }
  return number;
};

function validateLocation(location) {
  return {
    latitude: finiteCoordinate(location?.latitude, "latitude", -90, 90),
    longitude: finiteCoordinate(location?.longitude, "longitude", -180, 180),
  };
}

function haversineKm(a, b) {
  const radians = (degrees) => (degrees * Math.PI) / 180;
  const earthRadiusKm = 6371.0088;
  const dLat = radians(b.latitude - a.latitude);
  const dLon = radians(b.longitude - a.longitude);
  const lat1 = radians(a.latitude);
  const lat2 = radians(b.latitude);
  const h = Math.sin(dLat / 2) ** 2
    + Math.cos(lat1) * Math.cos(lat2) * Math.sin(dLon / 2) ** 2;
  return 2 * earthRadiusKm * Math.asin(Math.sqrt(h));
}

function nearestLocation(target, candidates, getLocation) {
  let nearest = null;
  for (const candidate of candidates) {
    const location = getLocation(candidate);
    const latitude = Number(location?.latitude);
    const longitude = Number(location?.longitude);
    if (!Number.isFinite(latitude) || !Number.isFinite(longitude)) continue;
    const distanceKm = haversineKm(target, { latitude, longitude });
    if (!nearest || distanceKm < nearest.distanceKm) {
      nearest = { candidate, distanceKm };
    }
  }
  return nearest;
}

function latestNotFuture(records, getTimestamp, nowMs) {
  return records
    .filter((record) => Number.isFinite(Date.parse(getTimestamp(record))))
    .filter((record) => Date.parse(getTimestamp(record)) <= nowMs + 60_000)
    .sort((a, b) => Date.parse(getTimestamp(b)) - Date.parse(getTimestamp(a)))[0] ?? null;
}

function sourceStatus(observedAt, retrievedAt, source, fallback = false) {
  const observedMs = Date.parse(observedAt);
  const retrievedMs = Date.parse(retrievedAt);
  if (!Number.isFinite(observedMs)) {
    return { status: fallback ? "stale" : "unavailable", ageMinutes: null };
  }
  const ageMs = retrievedMs - observedMs;
  // These display thresholds are RainReady prototype assumptions, not NEA standards.
  const isFresh = ageMs >= -60_000 && ageMs <= FRESHNESS_LIMITS_MS[source];
  return {
    status: fallback || !isFresh ? "stale" : "current",
    ageMinutes: Math.max(0, Math.round(ageMs / 60_000)),
  };
}

function requireData(payload, source) {
  if (!payload || payload.code !== 0 || !payload.data) {
    throw new Error(`${source} returned an unsuccessful or malformed response`);
  }
  return payload.data;
}

function normalizeForecast(payload, target, retrievedAt) {
  const data = requireData(payload, "forecast");
  const nowMs = Date.parse(retrievedAt);
  const item = latestNotFuture(data.items ?? [], (entry) => entry.timestamp, nowMs);
  if (!item) throw new Error("forecast contains no usable item");

  const nearest = nearestLocation(target, data.area_metadata ?? [], (area) => area.label_location);
  const forecast = nearest
    ? item.forecasts?.find((entry) => entry.area === nearest.candidate.name) ?? null
    : null;
  const observedAt = item.timestamp ?? null;
  return {
    observedAt,
    updatedAt: item.update_timestamp ?? null,
    validPeriod: item.valid_period ?? null,
    nearestArea: nearest ? {
      name: nearest.candidate.name,
      latitude: Number(nearest.candidate.label_location.latitude),
      longitude: Number(nearest.candidate.label_location.longitude),
      distanceKm: Number(nearest.distanceKm.toFixed(2)),
      forecast: forecast?.forecast ?? null,
    } : null,
    freshness: sourceStatus(observedAt, retrievedAt, "forecast"),
  };
}

function normalizeRainfall(payload, target, retrievedAt) {
  const data = requireData(payload, "rainfall");
  const readingGroup = latestNotFuture(data.readings ?? [], (entry) => entry.timestamp, Date.parse(retrievedAt));
  const readingByStation = new Map((readingGroup?.data ?? []).map((reading) => [reading.stationId, reading]));
  const nearest = nearestLocation(target, data.stations ?? [], (station) => station.location);
  const station = nearest?.candidate ?? null;
  const reading = station ? readingByStation.get(station.id) ?? null : null;
  const observedAt = readingGroup?.timestamp ?? null;
  return {
    observedAt,
    readingType: data.readingType ?? null,
    unit: data.readingUnit ?? null,
    nearestStation: station ? {
      id: station.id,
      name: station.name,
      latitude: Number(station.location.latitude),
      longitude: Number(station.location.longitude),
      distanceKm: Number(nearest.distanceKm.toFixed(2)),
      value: reading ? Number(reading.value) : null,
    } : null,
    freshness: sourceStatus(observedAt, retrievedAt, "rainfall"),
  };
}

function normalizeLightning(payload, target, retrievedAt) {
  const data = requireData(payload, "lightning");
  const records = data.records ?? [];
  const latestRecord = latestNotFuture(records, (record) => record.datetime, Date.parse(retrievedAt));
  const observations = records.flatMap((record) => (record.item?.readings ?? []).map((reading) => {
    const latitude = Number(reading.location?.latitude);
    const longitude = Number(reading.location?.longitude);
    if (!Number.isFinite(latitude) || !Number.isFinite(longitude)) return null;
    const location = { latitude, longitude };
    return {
      observedAt: reading.datetime ?? record.datetime,
      type: reading.type ?? null,
      description: reading.text ?? null,
      latitude,
      longitude,
      distanceKm: Number(haversineKm(target, location).toFixed(2)),
    };
  }).filter(Boolean));
  const usableObservations = observations.filter((observation) => {
    const at = Date.parse(observation.observedAt);
    return Number.isFinite(at) && at <= Date.parse(retrievedAt) + 60_000;
  });
  const observedAt = latestRecord?.datetime ?? null;
  return {
    observedAt,
    updatedAt: latestRecord?.updatedTimestamp ?? null,
    observations: usableObservations,
    status: usableObservations.length ? "observations_returned" : "no_observations_returned",
    interpretation: "Lightning observations are not an official warning or an all-clear.",
    freshness: sourceStatus(observedAt, retrievedAt, "lightning"),
  };
}

function normalizeAirQuality(payload, target, retrievedAt) {
  const data = requireData(payload, "air quality");
  const regions = data.regionMetadata ?? data.region_metadata ?? [];
  const nearest = nearestLocation(target, regions, (region) => region.labelLocation ?? region.label_location);
  const item = latestNotFuture(data.items ?? [], (entry) => entry.timestamp, Date.parse(retrievedAt));
  if (!item) throw new Error("air quality contains no usable item");

  const regionName = nearest?.candidate?.name?.toLowerCase() ?? null;
  const readings = item.readings ?? {};
  const psiByRegion = readings.psi_twenty_four_hourly ?? {};
  const pm25ByRegion = readings.pm25_twenty_four_hourly ?? {};
  const numericReading = (value) => value === null || value === undefined || value === "" ? null : Number(value);
  const psi = regionName === null ? null : numericReading(psiByRegion[regionName]);
  const pm25 = regionName === null ? null : numericReading(pm25ByRegion[regionName]);
  const labelLocation = nearest?.candidate?.labelLocation ?? nearest?.candidate?.label_location;
  const observedAt = item.timestamp ?? null;

  return {
    observedAt,
    updatedAt: item.updatedTimestamp ?? item.update_timestamp ?? null,
    nearestRegion: nearest ? {
      name: nearest.candidate.name,
      latitude: Number(labelLocation.latitude),
      longitude: Number(labelLocation.longitude),
      distanceKm: Number(nearest.distanceKm.toFixed(2)),
      psiTwentyFourHourly: Number.isFinite(psi) ? psi : null,
      pm25TwentyFourHourly: Number.isFinite(pm25) ? pm25 : null,
    } : null,
    unit: { psi: "index", pm25TwentyFourHourly: "ug/m3" },
    interpretation: "24-hour PSI supports general health planning; individual risk also depends on health status, exposure duration and activity intensity.",
    freshness: sourceStatus(observedAt, retrievedAt, "airQuality"),
  };
}

async function requestJson(source, url, fetchImpl, timeoutMs) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  timer.unref?.();
  try {
    const response = await fetchImpl(url, { method: "GET", signal: controller.signal });
    if (!response?.ok) throw new Error(`${source} HTTP ${response?.status ?? "error"}`);
    return await response.json();
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Produce an event-centred, normalised snapshot. A Map cache can preserve last-good
 * source payloads between calls in a local server; callers should persist it for cloud use.
 */
export async function getWeatherSnapshot({
  latitude,
  longitude,
  fetchImpl = globalThis.fetch,
  cache = new Map(),
  now = new Date(),
  timeoutMs = 8000,
} = {}) {
  const target = validateLocation({ latitude, longitude });
  if (typeof fetchImpl !== "function") throw new TypeError("fetchImpl must be a function");
  const retrievedAt = now.toISOString();

  const sources = await Promise.all(Object.entries(DATA_ENDPOINTS).map(async ([name, url]) => {
    try {
      const payload = await requestJson(name, url, fetchImpl, timeoutMs);
      requireData(payload, name);
      const result = { payload, retrievedAt, fallback: false, error: null };
      cache.set(name, result);
      return [name, result];
    } catch (error) {
      const lastGood = cache.get(name);
      if (lastGood?.payload) {
        return [name, { ...lastGood, fallback: true, error: error.message }];
      }
      return [name, { payload: null, retrievedAt: null, fallback: false, error: error.message }];
    }
  }));
  const sourceMap = Object.fromEntries(sources);

  const processSource = (name, normalizer) => {
    const source = sourceMap[name];
    if (!source.payload) {
      return { data: null, freshness: { status: "unavailable", ageMinutes: null }, error: source.error };
    }
    try {
      const data = normalizer(source.payload, target, retrievedAt);
      const freshness = source.fallback
        ? { ...data.freshness, status: "stale" }
        : data.freshness;
      return {
        data: { ...data, retrievedAt: source.retrievedAt },
        freshness,
        error: source.error,
      };
    } catch (error) {
      return { data: null, freshness: { status: "unavailable", ageMinutes: null }, error: error.message };
    }
  };

  return {
    retrievedAt,
    location: target,
    sources: {
      forecast: processSource("forecast", normalizeForecast),
      rainfall: processSource("rainfall", normalizeRainfall),
      lightning: processSource("lightning", normalizeLightning),
      airQuality: processSource("airQuality", normalizeAirQuality),
    },
    notes: [
      "Forecast and rainfall locations are represented by the nearest official area/station; inspect distanceKm before relying on them.",
      "Lightning observations are contextual data only; this module does not create official alerts or resume activities.",
      "Air-quality advice uses the nearest NEA reporting region and the reported 24-hour PSI; it is not a medical diagnosis.",
      "Freshness thresholds are prototype assumptions and should be reviewed against observed API latency.",
    ],
  };
}
