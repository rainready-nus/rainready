const ONEMAP_SEARCH_URL = "https://www.onemap.gov.sg/api/common/elastic/search";

export class GeocodingConfigurationError extends Error {
  constructor(message = "OneMap search is not configured. Set ONEMAP_ACCESS_TOKEN in the backend environment.") {
    super(message);
    this.name = "GeocodingConfigurationError";
  }
}

export class GeocodingUpstreamError extends Error {
  constructor(message = "OneMap could not complete the location search.") {
    super(message);
    this.name = "GeocodingUpstreamError";
  }
}

function cleanResult(item) {
  const latitude = Number(item?.LATITUDE);
  const longitude = Number(item?.LONGITUDE ?? item?.LONGTITUDE);
  if (!Number.isFinite(latitude) || latitude < -90 || latitude > 90) return null;
  if (!Number.isFinite(longitude) || longitude < -180 || longitude > 180) return null;
  const name = typeof item.SEARCHVAL === "string" ? item.SEARCHVAL.trim() : "";
  const address = typeof item.ADDRESS === "string" ? item.ADDRESS.trim() : "";
  if (!name && !address) return null;
  return {
    name: (name || address).slice(0, 240),
    address: (address || name).slice(0, 240),
    latitude,
    longitude,
  };
}

export async function searchOneMap({ query, token = process.env.ONEMAP_ACCESS_TOKEN, fetchImpl = fetch }) {
  const search = typeof query === "string" ? query.trim() : "";
  if (search.length < 3 || search.length > 120) {
    throw new RangeError("Search text must be between 3 and 120 characters.");
  }
  if (!token) throw new GeocodingConfigurationError();

  const url = new URL(ONEMAP_SEARCH_URL);
  url.search = new URLSearchParams({
    searchVal: search,
    returnGeom: "Y",
    getAddrDetails: "Y",
    pageNum: "1",
  }).toString();

  let response;
  let payload;
  try {
    response = await fetchImpl(url, {
      headers: { Authorization: token, Accept: "application/json" },
      signal: AbortSignal.timeout(8_000),
    });
    if (!response.ok) throw new GeocodingUpstreamError(`OneMap returned HTTP ${response.status}.`);
    payload = await response.json();
  } catch (error) {
    if (error instanceof GeocodingUpstreamError) throw error;
    throw new GeocodingUpstreamError();
  }

  if (payload?.error) throw new GeocodingUpstreamError("OneMap rejected the search request. Check the backend token and try again.");
  return (Array.isArray(payload?.results) ? payload.results : [])
    .map(cleanResult)
    .filter(Boolean)
    .slice(0, 8);
}
