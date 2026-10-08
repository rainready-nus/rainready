import { createServer as createHttpServer } from "node:http";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { getWeatherSnapshot } from "./weather-data.mjs";
import { buildRiskAssessment } from "./risk-assessment.mjs";
import { createEventStore } from "./event-store.mjs";
import { createEventService, EventValidationError } from "./event-service.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const frontendPath = path.join(root, "frontend", "index.html");
const eventStore = createEventStore({
  databasePath: process.env.RAINREADY_DB_FILE || path.join(root, "backend", "data", "rainready.sqlite"),
  legacyFilePath: process.env.RAINREADY_LEGACY_DATA_FILE || path.join(root, "backend", "data", "events.json"),
});

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

async function readJsonBody(request) {
  let body = "";
  for await (const chunk of request) {
    body += chunk;
    if (body.length > 32_768) throw new RangeError("request body must be 32 KB or smaller");
  }
  try {
    return JSON.parse(body);
  } catch {
    throw new EventValidationError("request body must contain valid JSON");
  }
}

export function createServer({ snapshot = getWeatherSnapshot, cache = new Map(), store = eventStore, service } = {}) {
  const events = service ?? createEventService(store);
  return createHttpServer(async (request, response) => {
    const url = new URL(request.url ?? "/", "http://localhost");
    if (request.method === "GET" && url.pathname === "/health") {
      return sendJson(response, 200, {
        status: "ok",
        version: "0.5.0",
        checkedAt: new Date().toISOString(),
      });
    }

    if (url.pathname === "/api/events" && request.method === "GET") {
      try {
        return sendJson(response, 200, { events: await events.list() });
      } catch (error) {
        return sendJson(response, 500, { error: "event_store_error", message: "RainReady could not load saved events.", detail: error.message });
      }
    }

    if (url.pathname === "/api/events" && request.method === "POST") {
      try {
        const event = await events.create(await readJsonBody(request));
        return sendJson(response, 201, { event });
      } catch (error) {
        const status = error instanceof EventValidationError || error instanceof RangeError ? 400 : 500;
        return sendJson(response, status, { error: status === 400 ? "invalid_event" : "event_store_error", message: error.message });
      }
    }

    const decisionsRoute = url.pathname.match(/^\/api\/events\/([^/]+)\/decisions$/);
    if (decisionsRoute) {
      let id;
      try {
        id = decodeURIComponent(decisionsRoute[1]);
      } catch {
        return sendJson(response, 400, { error: "invalid_event_id" });
      }
      if (request.method === "GET") {
        try {
          const decisions = await events.listDecisions(id);
          return decisions ? sendJson(response, 200, { decisions }) : sendJson(response, 404, { error: "event_not_found" });
        } catch (error) {
          return sendJson(response, 500, { error: "event_store_error", message: error.message });
        }
      }
      if (request.method === "POST") {
        try {
          const result = await events.recordDecision(id, await readJsonBody(request));
          return result
            ? sendJson(response, 201, { decision: result.decision, event: result.event })
            : sendJson(response, 404, { error: "event_not_found" });
        } catch (error) {
          const status = error instanceof EventValidationError || error instanceof RangeError ? 400 : 500;
          return sendJson(response, status, { error: status === 400 ? "invalid_decision" : "event_store_error", message: error.message });
        }
      }
    }

    const eventRoute = url.pathname.match(/^\/api\/events\/([^/]+)$/);
    if (eventRoute) {
      let id;
      try {
        id = decodeURIComponent(eventRoute[1]);
      } catch {
        return sendJson(response, 400, { error: "invalid_event_id" });
      }
      if (request.method === "GET") {
        try {
          const event = await events.get(id);
          return event ? sendJson(response, 200, { event }) : sendJson(response, 404, { error: "event_not_found" });
        } catch (error) {
          return sendJson(response, 500, { error: "event_store_error", message: error.message });
        }
      }
      if (request.method === "PATCH") {
        try {
          const event = await events.update(id, await readJsonBody(request));
          return event ? sendJson(response, 200, { event }) : sendJson(response, 404, { error: "event_not_found" });
        } catch (error) {
          const status = error instanceof EventValidationError || error instanceof RangeError ? 400 : 500;
          return sendJson(response, status, { error: status === 400 ? "invalid_event" : "event_store_error", message: error.message });
        }
      }
      if (request.method === "DELETE") {
        try {
          const deleted = await events.delete(id);
          return deleted ? sendJson(response, 200, { deleted: true, id }) : sendJson(response, 404, { error: "event_not_found" });
        } catch (error) {
          return sendJson(response, 500, { error: "event_store_error", message: error.message });
        }
      }
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

    if (request.method === "GET" && url.pathname === "/api/assessment") {
      let latitude;
      let longitude;
      const sensitivity = url.searchParams.get("sensitivity");
      try {
        latitude = parseCoordinate(url.searchParams.get("latitude"), "latitude", -90, 90);
        longitude = parseCoordinate(url.searchParams.get("longitude"), "longitude", -180, 180);
        if (!["low", "medium", "high"].includes(sensitivity)) {
          throw new RangeError("sensitivity must be low, medium, or high");
        }
      } catch (error) {
        return sendJson(response, 400, { error: "invalid_assessment_input", message: error.message });
      }

      try {
        const snapshotResult = await snapshot({ latitude, longitude, cache });
        const assessment = buildRiskAssessment({ snapshot: snapshotResult, sensitivity });
        return sendJson(response, 200, { ...snapshotResult, assessment });
      } catch (error) {
        return sendJson(response, 502, {
          error: "assessment_service_error",
          message: "RainReady could not produce a risk assessment.",
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

