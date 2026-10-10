import test from "node:test";
import assert from "node:assert/strict";
import { createOneMapTokenManager, searchOneMap, GeocodingConfigurationError, GeocodingUpstreamError } from "./geocoding.mjs";

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

test("OneMap search refreshes an expired token with backend credentials and retries once", async () => {
  const tokens = [];
  let authenticationCalls = 0;
  const fetchImpl = async (url, options = {}) => {
    if (String(url).includes("/api/auth/post/getToken")) {
      authenticationCalls += 1;
      assert.deepEqual(JSON.parse(options.body), { email: "member@example.com", password: "private-password" });
      return new Response(JSON.stringify({ access_token: "refreshed-token", expiry_timestamp: "9999999999" }), { status: 200 });
    }
    tokens.push(options.headers.Authorization);
    if (options.headers.Authorization === "expired-token") {
      return new Response(JSON.stringify({ error: "Authentication token expired. Tokens is valid for 3 days.", results: [] }), { status: 200 });
    }
    return new Response(JSON.stringify({
      results: [{ SEARCHVAL: "UNIVERSITY TOWN", ADDRESS: "NUS, SINGAPORE", LATITUDE: "1.304", LONGITUDE: "103.773" }],
    }), { status: 200 });
  };
  const tokenManager = createOneMapTokenManager({
    token: "expired-token",
    email: "member@example.com",
    password: "private-password",
    fetchImpl,
  });

  const first = await searchOneMap({ query: "University Town", fetchImpl, tokenManager });
  const second = await searchOneMap({ query: "University Town", fetchImpl, tokenManager });
  assert.equal(first.length, 1);
  assert.equal(second.length, 1);
  assert.equal(authenticationCalls, 1);
  assert.deepEqual(tokens, ["expired-token", "refreshed-token", "refreshed-token"]);
});

test("OneMap credential mode obtains a token when no static token is configured", async () => {
  let authenticationCalls = 0;
  const fetchImpl = async (url, options = {}) => {
    if (String(url).includes("/api/auth/post/getToken")) {
      authenticationCalls += 1;
      return new Response(JSON.stringify({ access_token: "generated-token", expiry_timestamp: "9999999999" }), { status: 200 });
    }
    assert.equal(options.headers.Authorization, "generated-token");
    return new Response(JSON.stringify({ results: [] }), { status: 200 });
  };
  const tokenManager = createOneMapTokenManager({
    token: "",
    email: "member@example.com",
    password: "private-password",
    fetchImpl,
  });
  await searchOneMap({ query: "NUS", fetchImpl, tokenManager });
  await searchOneMap({ query: "NUS", fetchImpl, tokenManager });
  assert.equal(authenticationCalls, 1);
});
