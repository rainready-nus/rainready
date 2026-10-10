import test from "node:test";
import assert from "node:assert/strict";
import { DATA_ENDPOINTS, getWeatherSnapshot } from "./weather-data.mjs";

const now = new Date("2026-10-06T07:42:20.000Z");

function response(payload) {
  return { ok: true, status: 200, json: async () => payload };
}

function fixtures() {
  return {
    forecast: {
      code: 0,
      data: {
        area_metadata: [
          { name: "Jurong West", label_location: { latitude: 1.34, longitude: 103.70 } },
          { name: "Tampines", label_location: { latitude: 1.34, longitude: 103.94 } },
        ],
        items: [{
          timestamp: "2026-10-06T15:30:00+08:00",
          update_timestamp: "2026-10-06T15:36:39+08:00",
          valid_period: { start: "2026-10-06T15:30:00+08:00", end: "2026-10-06T17:30:00+08:00" },
          forecasts: [
            { area: "Jurong West", forecast: "Showers" },
            { area: "Tampines", forecast: "Fair" },
          ],
        }],
      },
    },
    rainfall: {
      code: 0,
      data: {
        stations: [
          { id: "S218", name: "Bukit Batok", location: { latitude: 1.36491, longitude: 103.75065 } },
          { id: "S81", name: "Punggol", location: { latitude: 1.4028, longitude: 103.9095 } },
        ],
        readings: [{
          timestamp: "2026-10-06T15:40:00+08:00",
          data: [{ stationId: "S218", value: 0.2 }, { stationId: "S81", value: 0 }],
        }],
        readingType: "TB1 Rainfall 5 Minute Total F",
        readingUnit: "mm",
      },
    },
    lightning: {
      code: 0,
      data: {
        records: [{
          datetime: "2026-10-06T15:40:00+08:00",
          updatedTimestamp: "2026-10-06T15:42:14+08:00",
          item: {
            type: "observation",
            isStationData: false,
            readings: [{
              location: { latitude: "1.38", longitude: "103.70" },
              type: "C",
              text: "Cloud to Cloud",
              datetime: "2026-10-06T15:39:59+08:00",
            }],
          },
        }],
      },
    },
    airQuality: {
      code: 0,
      data: {
        regionMetadata: [
          { name: "west", labelLocation: { latitude: 1.35735, longitude: 103.7 } },
          { name: "east", labelLocation: { latitude: 1.35735, longitude: 103.94 } },
        ],
        items: [{
          timestamp: "2026-10-06T15:00:00+08:00",
          updatedTimestamp: "2026-10-06T15:15:00+08:00",
          readings: {
            psi_twenty_four_hourly: { west: 82, east: 105 },
            pm25_twenty_four_hourly: { west: 34, east: 58 },
          },
        }],
      },
    },
  };
}

test("fetches the four public sources and normalises weather, lightning and air-quality data", async () => {
  const payloads = fixtures();
  const fetchImpl = async (url) => {
    const name = Object.keys(DATA_ENDPOINTS).find((key) => DATA_ENDPOINTS[key] === url);
    assert.ok(name, `unexpected URL: ${url}`);
    return response(payloads[name]);
  };

  const result = await getWeatherSnapshot({
    latitude: 1.35,
    longitude: 103.75,
    fetchImpl,
    now,
  });

  assert.equal(result.sources.forecast.data.nearestArea.name, "Jurong West");
  assert.equal(result.sources.forecast.data.nearestArea.forecast, "Showers");
  assert.equal(result.sources.rainfall.data.nearestStation.id, "S218");
  assert.equal(result.sources.rainfall.data.nearestStation.value, 0.2);
  assert.equal(result.sources.rainfall.data.unit, "mm");
  assert.equal(result.sources.lightning.data.observations[0].type, "C");
  assert.equal(result.sources.lightning.data.status, "observations_returned");
  assert.match(result.sources.lightning.data.interpretation, /not an official warning/);
  assert.equal(result.sources.airQuality.data.nearestRegion.name, "west");
  assert.equal(result.sources.airQuality.data.nearestRegion.psiTwentyFourHourly, 82);
  assert.equal(result.sources.airQuality.data.nearestRegion.pm25TwentyFourHourly, 34);
  assert.equal(result.sources.airQuality.freshness.status, "current");
});

test("reports an empty lightning result as no observations returned, not as an all-clear", async () => {
  const payloads = fixtures();
  payloads.lightning.data.records[0].item.readings = [];
  const fetchImpl = async (url) => {
    const name = Object.keys(DATA_ENDPOINTS).find((key) => DATA_ENDPOINTS[key] === url);
    return response(payloads[name]);
  };
  const result = await getWeatherSnapshot({ latitude: 1.35, longitude: 103.75, fetchImpl, now });
  assert.equal(result.sources.lightning.data.status, "no_observations_returned");
  assert.equal(result.sources.lightning.data.observations.length, 0);
  assert.match(result.sources.lightning.data.interpretation, /not an official warning/);
});

test("does not turn a missing regional PSI reading into zero", async () => {
  const payloads = fixtures();
  payloads.airQuality.data.items[0].readings.psi_twenty_four_hourly.west = null;
  const fetchImpl = async (url) => {
    const name = Object.keys(DATA_ENDPOINTS).find((key) => DATA_ENDPOINTS[key] === url);
    return response(payloads[name]);
  };
  const result = await getWeatherSnapshot({ latitude: 1.35, longitude: 103.75, fetchImpl, now });
  assert.equal(result.sources.airQuality.data.nearestRegion.psiTwentyFourHourly, null);
});

test("keeps a last-good response visible as stale when a source fails", async () => {
  const cache = new Map();
  const payloads = fixtures();
  const goodFetch = async (url) => {
    const name = Object.keys(DATA_ENDPOINTS).find((key) => DATA_ENDPOINTS[key] === url);
    return response(payloads[name]);
  };
  await getWeatherSnapshot({ latitude: 1.35, longitude: 103.75, fetchImpl: goodFetch, cache, now });

  const failedFetch = async (url) => {
    if (url === DATA_ENDPOINTS.rainfall) throw new Error("network down");
    const name = Object.keys(DATA_ENDPOINTS).find((key) => DATA_ENDPOINTS[key] === url);
    return response(payloads[name]);
  };
  const result = await getWeatherSnapshot({
    latitude: 1.35,
    longitude: 103.75,
    fetchImpl: failedFetch,
    cache,
    now: new Date("2026-10-06T08:00:00.000Z"),
  });
  assert.equal(result.sources.rainfall.freshness.status, "stale");
  assert.equal(result.sources.rainfall.data.nearestStation.value, 0.2);
  assert.match(result.sources.rainfall.error, /network down/);
});

test("marks unavailable sources and rejects invalid event coordinates", async () => {
  const result = await getWeatherSnapshot({
    latitude: 1.35,
    longitude: 103.75,
    fetchImpl: async () => { throw new Error("offline"); },
    now,
  });
  assert.equal(result.sources.forecast.freshness.status, "unavailable");
  await assert.rejects(
    getWeatherSnapshot({ latitude: 100, longitude: 103.75 }),
    RangeError,
  );
});
