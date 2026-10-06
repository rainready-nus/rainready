import { createServer as createHttpServer } from "node:http";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { getWeatherSnapshot } from "./weather-data.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const frontendPath = path.join(root, "frontend", "index.html");

function sendJson(response, statusCode, body) {
  response.writeHead(statusCode, {
    "content-type": "application/json; charset=utf-8",
    "cache-control": "no-store",
  });
  response.end(JSON.stringify(body));
}

function parseCoordinate(value, name, min, max) {
  if (value === null || value.trim() === "") throw new RangeError(`${name} is required`);
  const number = Number(value);
  if (!Number.isFinite(number) || number < min || number > max) {
    throw new RangeError(`${name} must be between ${min} and ${max}`);
  }
  return number;
}

export function createServer({ snapshot = getWeatherSnapshot, cache = new Map() } = {}) {
  return createHttpServer(async (request, response) => {
    const url = new URL(request.url ?? "/", "http://localhost");
    if (request.method === "GET" && url.pathname === "/health") {
      return sendJson(response, 200, {
        status: "ok",
        version: "0.2.0",
        checkedAt: new Date().toISOString(),
      });
    }

    if (request.method === "GET" && url.pathname === "/api/weather") {
      let latitude;
      let longitude;
      try {
        latitude = parseCoordinate(url.searchParams.get("latitude"), "latitude", -90, 90);
        longitude = parseCoordinate(url.searchParams.get("longitude"), "longitude", -180, 180);
      } catch (error) {
        return sendJson(response, 400, { error: "invalid_location", message: error.message });
      }

      try {
        const result = await snapshot({ latitude, longitude, cache });
        return sendJson(response, 200, result);
      } catch (error) {
        return sendJson(response, 502, {
          error: "weather_service_error",
          message: "RainReady could not retrieve a weather snapshot.",
          detail: error.message,
        });
      }
    }

    if (request.method === "GET" && url.pathname === "/") {
      try {
        const html = await readFile(frontendPath);
        response.writeHead(200, { "content-type": "text/html; charset=utf-8" });
        return response.end(html);
      } catch {
        return sendJson(response, 500, { error: "frontend_unavailable" });
      }
    }

    return sendJson(response, 404, { error: "not_found" });
  });
}

const isMain = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  const port = Number(process.env.PORT ?? 8787);
  const server = createServer();
  server.listen(port, "127.0.0.1", () => {
    console.log(`RainReady is running at http://127.0.0.1:${port}`);
  });
}
