import crypto from "node:crypto";

const REDIS_KEY = "regiversj:feedback:v1";
const USERS = new Set(["Bjarne", "Knut Arne", "Frode"]);
const PAGES = new Set(["catches", "map"]);

function boundedText(value, maxLength) {
  return String(value == null ? "" : value).trim().slice(0, maxLength);
}

function parseBody(request) {
  if (!request.body) return {};
  if (typeof request.body === "string") return JSON.parse(request.body);
  return request.body;
}

function sanitizeFeedback(input) {
  const source = input || {};
  const id = boundedText(source.id, 100);
  const createdBy = boundedText(source.createdBy, 40);
  const message = boundedText(source.message, 1500);
  const createdAt = Number(source.createdAt);

  if (!/^FB-[A-Za-z0-9_-]{6,96}$/.test(id)) {
    throw new Error("Ugyldig tilbakemeldings-ID.");
  }
  if (!USERS.has(createdBy)) {
    throw new Error("Ugyldig bruker.");
  }
  if (message.length < 3) {
    throw new Error("Tilbakemeldingen er for kort.");
  }

  return {
    id,
    createdBy,
    message,
    page: PAGES.has(source.page) ? source.page : "catches",
    createdAt: Number.isFinite(createdAt) && createdAt > 0 ? Math.round(createdAt) : Date.now()
  };
}

function redisSettings() {
  return {
    url: process.env.UPSTASH_REDIS_REST_URL
      || process.env.UPSTASH_REDIS_REST_KV_REST_API_URL
      || process.env.KV_REST_API_URL,
    token: process.env.UPSTASH_REDIS_REST_TOKEN
      || process.env.UPSTASH_REDIS_REST_KV_REST_API_TOKEN
      || process.env.KV_REST_API_TOKEN
  };
}

async function redis(command) {
  const { url, token } = redisSettings();
  if (!url || !token) {
    const error = new Error("Felles lagring er ikke konfigurert.");
    error.statusCode = 503;
    throw error;
  }

  const response = await fetch(url, {
    method: "POST",
    headers: {
      "Authorization": `Bearer ${token}`,
      "Content-Type": "application/json"
    },
    body: JSON.stringify(command)
  });
  const result = await response.json();
  if (!response.ok || result.error) {
    throw new Error(result.error || "Databasen svarte ikke.");
  }
  return result.result;
}

function send(response, statusCode, body) {
  response.setHeader("Cache-Control", "no-store");
  response.setHeader("Content-Type", "application/json; charset=utf-8");
  return response.status(statusCode).json(body);
}

function hasAdminAccess(request) {
  const expected = process.env.FEEDBACK_ADMIN_KEY || "";
  if (expected.length < 8) return false;

  const authorization = String(request.headers.authorization || "");
  const supplied = authorization.startsWith("Bearer ")
    ? authorization.slice(7)
    : "";
  const expectedBuffer = Buffer.from(expected);
  const suppliedBuffer = Buffer.from(supplied);
  return expectedBuffer.length === suppliedBuffer.length
    && crypto.timingSafeEqual(expectedBuffer, suppliedBuffer);
}

function requireAdmin(request, response) {
  if (!process.env.FEEDBACK_ADMIN_KEY || process.env.FEEDBACK_ADMIN_KEY.length < 8) {
    send(response, 503, { error: "Backoffice er ikke konfigurert." });
    return false;
  }
  if (!hasAdminAccess(request)) {
    send(response, 401, { error: "Feil kode." });
    return false;
  }
  return true;
}

export default async function handler(request, response) {
  try {
    if (request.method === "POST") {
      const feedback = sanitizeFeedback(parseBody(request));
      await redis(["HSET", REDIS_KEY, feedback.id, JSON.stringify(feedback)]);
      return send(response, 201, { saved: true });
    }

    if (request.method === "GET") {
      if (!requireAdmin(request, response)) return;
      const values = await redis(["HGETALL", REDIS_KEY]);
      const feedback = [];

      for (let index = 0; index < (values || []).length; index += 2) {
        try {
          feedback.push(sanitizeFeedback(JSON.parse(values[index + 1])));
        } catch (error) {
          console.warn("Ignorerte ugyldig tilbakemelding i databasen.");
        }
      }

      feedback.sort((a, b) => b.createdAt - a.createdAt);
      return send(response, 200, { feedback });
    }

    if (request.method === "DELETE") {
      if (!requireAdmin(request, response)) return;
      const body = parseBody(request);
      const ids = Array.isArray(body.ids)
        ? body.ids
          .map(id => boundedText(id, 100))
          .filter(id => /^FB-[A-Za-z0-9_-]{6,96}$/.test(id))
        : [];
      if (!ids.length || ids.length > 50) {
        return send(response, 400, { error: "Ingen gyldige tilbakemeldinger å slette." });
      }

      const deleted = await redis(["HDEL", REDIS_KEY, ...ids]);
      return send(response, 200, { deleted: Number(deleted) || 0 });
    }

    response.setHeader("Allow", "GET, POST, DELETE");
    return send(response, 405, { error: "Metoden støttes ikke." });
  } catch (error) {
    console.error("Tilbakemeldingslagring feilet", error);
    return send(response, error.statusCode || 500, {
      error: error.statusCode === 503
        ? error.message
        : "Tilbakemeldingen kunne ikke lagres akkurat nå."
    });
  }
}
