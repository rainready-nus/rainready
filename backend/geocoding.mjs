const ONEMAP_SEARCH_URL = "https://www.onemap.gov.sg/api/common/elastic/search";
const ONEMAP_TOKEN_URL = "https://www.onemap.gov.sg/api/auth/post/getToken";

export class GeocodingConfigurationError extends Error {
  constructor(message = "OneMap search is not configured. Set ONEMAP_ACCESS_TOKEN or both ONEMAP_API_EMAIL and ONEMAP_API_PASSWORD in the backend environment.") {
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

async function requestOneMapToken({ email, password, fetchImpl }) {
  let response;
  let payload;
  try {
    response = await fetchImpl(ONEMAP_TOKEN_URL, {
      method: "POST",
      headers: { "content-type": "application/json", accept: "application/json" },
      body: JSON.stringify({ email, password }),
      signal: AbortSignal.timeout(8_000),
    });
    if (!response.ok) throw new GeocodingUpstreamError("OneMap authentication failed.");
    payload = await response.json();
  } catch (error) {
    if (error instanceof GeocodingUpstreamError) throw error;
    throw new GeocodingUpstreamError("OneMap authentication is temporarily unavailable.");
  }

  const accessToken = typeof payload?.access_token === "string" ? payload.access_token.trim() : "";
  if (!accessToken) throw new GeocodingUpstreamError("OneMap authentication failed.");
  const expirySeconds = Number(payload.expiry_timestamp);
  return {
    accessToken,
    expiresAt: Number.isFinite(expirySeconds) ? expirySeconds * 1000 : null,
  };
}

export function createOneMapTokenManager({
  token = process.env.ONEMAP_ACCESS_TOKEN,
  email = process.env.ONEMAP_API_EMAIL,
  password = process.env.ONEMAP_API_PASSWORD,
  fetchImpl = fetch,
  now = () => Date.now(),
} = {}) {
  let cachedToken = typeof token === "string" && token.trim() ? token.trim() : null;
  let expiresAt = null;
  let refreshPromise = null;
  const canRefresh = Boolean(email?.trim() && password);

  return {
    canRefresh,
    async getToken({ forceRefresh = false } = {}) {
      const stillCurrent = cachedToken && (!expiresAt || now() < expiresAt - 60_000);
      if (!forceRefresh && stillCurrent) return cachedToken;
      if (!canRefresh) {
        if (cachedToken && !forceRefresh) return cachedToken;
        throw new GeocodingConfigurationError(
          "OneMap search needs ONEMAP_ACCESS_TOKEN or both ONEMAP_API_EMAIL and ONEMAP_API_PASSWORD in the backend environment.",
        );
      }
      if (!refreshPromise) {
        refreshPromise = requestOneMapToken({ email: email.trim(), password, fetchImpl })
          .then((result) => {
            cachedToken = result.accessToken;
            expiresAt = result.expiresAt;
            return cachedToken;
          })
          .finally(() => { refreshPromise = null; });
      }
      return refreshPromise;
    },
  };
}

const defaultTokenManager = createOneMapTokenManager();

async function requestSearch({ url, token, fetchImpl }) {
  let response;
  let payload;
  try {
    response = await fetchImpl(url, {
      headers: { Authorization: token, Accept: "application/json" },
      signal: AbortSignal.timeout(8_000),
    });
    payload = await response.json().catch(() => null);
  } catch {
    throw new GeocodingUpstreamError();
  }
  return { response, payload };
}

function authenticationRejected({ response, payload }) {
  return response?.status === 401
    || typeof payload?.error === "string" && /token|authenticat|expired/i.test(payload.error);
}

export async function searchOneMap({ query, token, fetchImpl = fetch, tokenManager } = {}) {
  const search = typeof query === "string" ? query.trim() : "";
  if (search.length < 3 || search.length > 120) {
    throw new RangeError("Search text must be between 3 and 120 characters.");
  }
  const manager = tokenManager ?? (token !== undefined
    ? createOneMapTokenManager({ token, fetchImpl })
    : defaultTokenManager);
  let activeToken = await manager.getToken();

  const url = new URL(ONEMAP_SEARCH_URL);
  url.search = new URLSearchParams({
    searchVal: search,
    returnGeom: "Y",
    getAddrDetails: "Y",
    pageNum: "1",
  }).toString();

  let result = await requestSearch({ url, token: activeToken, fetchImpl });
  if (authenticationRejected(result) && manager.canRefresh) {
    activeToken = await manager.getToken({ forceRefresh: true });
    result = await requestSearch({ url, token: activeToken, fetchImpl });
  }

  if (!result.response?.ok || result.payload?.error) {
    throw new GeocodingUpstreamError("OneMap rejected the search request. Check the backend credentials and try again.");
  }
  return (Array.isArray(result.payload?.results) ? result.payload.results : [])
    .map(cleanResult)
    .filter(Boolean)
    .slice(0, 8);
}
