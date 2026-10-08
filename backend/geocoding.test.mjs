import test from "node:test";
import assert from "node:assert/strict";
import { searchOneMap, GeocodingConfigurationError, GeocodingUpstreamError } from "./geocoding.mjs";

test("OneMap search sends a server-side token and normalises results", async () => {
  let requestedUrl;
  let requestedToken;
  const results = await searchOneMap({
    query: "University Town",
    token: "test-token",
    fetchImpl: async (url, options) => {
      requestedUrl = new URL(url);
      requestedToken = options.headers.Authorization;
      return new Response(JSON.stringify({
        results: [
          { SEARCHVAL: "UNIVERSITY TOWN", ADDRESS: "NUS, SINGAPORE", LATITUDE: "1.304", LONGITUDE: "103.773" },
          { SEARCHVAL: "Bad coordinate", ADDRESS: "Invalid", LATITUDE: "91", LONGITUDE: "103.8" },
        ],
      }), { status: 200, headers: { "content-type": "application/json" } });
    },
  });

  assert.equal(requestedUrl.searchParams.get("searchVal"), "University Town");
  assert.equal(requestedUrl.searchParams.get("returnGeom"), "Y");
  assert.equal(requestedUrl.searchParams.get("getAddrDetails"), "Y");
  assert.equal(requestedToken, "test-token");
  assert.deepEqual(results, [{ name: "UNIVERSITY TOWN", address: "NUS, SINGAPORE", latitude: 1.304, longitude: 103.773 }]);
});

test("OneMap search requires a configured token", async () => {
  await assert.rejects(searchOneMap({ query: "NUS", token: "", fetchImpl: async () => { throw new Error("must not call upstream"); } }), GeocodingConfigurationError);
});

test("OneMap search reports upstream failures without exposing response details", async () => {
  await assert.rejects(
    searchOneMap({ query: "NUS", token: "test-token", fetchImpl: async () => new Response("private upstream detail", { status: 401 }) }),
    (error) => error instanceof GeocodingUpstreamError && !error.message.includes("private upstream detail"),
  );
});

test("OneMap search rejects too-short queries before making a request", async () => {
  await assert.rejects(searchOneMap({ query: "  ", token: "test-token" }), RangeError);
});
