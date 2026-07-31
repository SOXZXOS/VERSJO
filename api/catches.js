import crypto from "node:crypto";

const REDIS_KEY = "regiversj:catches:v1";
const TOMBSTONE_KEY = "regiversj:catch-tombstones:v1";
const AUDIT_KEY = "regiversj:catch-events:v1";
const AUDIT_LIMIT = 500;
const CLIENT_VERSION = "2026-07-31-1";
const USERS = new Set(["Bjarne", "Knut Arne", "Frode"]);
const TIMES = new Set(["Morgen", "Formiddag", "Ettermiddag", "Kveld", "Natt"]);
const WEATHER = new Set([
  "Klarvær",
  "Lettskyet",
  "Overskyet",
  "Tåke",
  "Yr",
  "Regn",
  "Sludd",
  "Snø",
  "Torden"
]);
const SOURCES = new Set(["form", "sync", "migration", "unknown"]);

function boundedText(value, maxLength) {
  return String(value == null ? "" : value).trim().slice(0, maxLength);
}

function boundedNumber(value, minimum, maximum, fallback) {
  const number = Number(value);
  if (!Number.isFinite(number)) return fallback;
  return Math.max(minimum, Math.min(maximum, Math.round(number)));
}

function sanitizeCatch(input) {
  const source = input || {};
  const id = boundedText(source.id, 100);
  const createdBy = boundedText(source.createdBy, 40);
  const date = boundedText(source.date, 10);
  const timeOfDay = boundedText(source.timeOfDay, 20);
  const weatherType = boundedText(source.weatherType, 30);

  if (!/^[A-Za-z0-9_-]{6,100}$/.test(id)) {
    throw new Error("Ugyldig fangst-ID.");
  }
  if (!USERS.has(createdBy)) {
    throw new Error("Ugyldig fisker.");
  }
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) {
    throw new Error("Ugyldig dato.");
  }

  return {
    id,
    date,
    timeOfDay: TIMES.has(timeOfDay) ? timeOfDay : "Ettermiddag",
    position: boundedText(source.position, 80),
    createdBy,
    weightGrams: boundedNumber(source.weightGrams, 1, 9999, 1),
    weatherType: WEATHER.has(weatherType) ? weatherType : "Overskyet",
    temperatureCelsius: boundedNumber(source.temperatureCelsius, -30, 40, 10),
    note: boundedText(source.note, 600),
    createdAt: boundedNumber(source.createdAt, 1, Number.MAX_SAFE_INTEGER, Date.now())
  };
}

function sanitizeSource(value) {
  const source = boundedText(value, 20);
  return SOURCES.has(source) ? source : "unknown";
}

function createEvent(action, details = {}) {
  return {
    id: `EV-${Date.now().toString(36).toUpperCase()}-${crypto.randomBytes(4).toString("hex").toUpperCase()}`,
    action,
    catchId: boundedText(details.catchId, 100),
    actor: USERS.has(details.actor) ? details.actor : "Ukjent",
    source: sanitizeSource(details.source),
    catchDate: /^\d{4}-\d{2}-\d{2}$/.test(details.catchDate || "") ? details.catchDate : "",
    occurredAt: Date.now()
  };
}

function sanitizeEvent(input) {
  const source = input || {};
  return {
    id: boundedText(source.id, 100),
    action: boundedText(source.action, 40),
    catchId: boundedText(source.catchId, 100),
    actor: boundedText(source.actor, 40) || "Ukjent",
    source: sanitizeSource(source.source),
    catchDate: /^\d{4}-\d{2}-\d{2}$/.test(source.catchDate || "") ? source.catchDate : "",
    occurredAt: boundedNumber(source.occurredAt, 1, Number.MAX_SAFE_INTEGER, Date.now())
  };
}

async function redis(command) {
  const url = process.env.UPSTASH_REDIS_REST_URL
    || process.env.UPSTASH_REDIS_REST_KV_REST_API_URL
    || process.env.KV_REST_API_URL;
  const token = process.env.UPSTASH_REDIS_REST_TOKEN
    || process.env.UPSTASH_REDIS_REST_KV_REST_API_TOKEN
    || process.env.KV_REST_API_TOKEN;

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

async function appendAuditEvents(events) {
  if (!events.length) return;
  try {
    await redis(["LPUSH", AUDIT_KEY, ...events.map(event => JSON.stringify(event))]);
    await redis(["LTRIM", AUDIT_KEY, 0, AUDIT_LIMIT - 1]);
  } catch (error) {
    console.error("Kunne ikke lagre fangsthistorikk", error);
  }
}

function parseBody(request) {
  if (!request.body) return {};
  if (typeof request.body === "string") {
    return JSON.parse(request.body);
  }
  return request.body;
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

function uniqueCatches(input) {
  const byId = new Map();
  input.map(sanitizeCatch).forEach(item => byId.set(item.id, item));
  return Array.from(byId.values());
}

export default async function handler(request, response) {
  try {
    if (request.method === "GET" && String(request.query && request.query.history) === "1") {
      if (!requireAdmin(request, response)) return;
      const values = await redis(["LRANGE", AUDIT_KEY, 0, AUDIT_LIMIT - 1]);
      const events = [];

      for (const value of values || []) {
        try {
          events.push(sanitizeEvent(JSON.parse(value)));
        } catch (error) {
          console.warn("Ignorerte ugyldig hendelse i fangsthistorikken.");
        }
      }

      events.sort((a, b) => b.occurredAt - a.occurredAt);
      return send(response, 200, { events });
    }

    if (request.method === "GET") {
      const values = await redis(["HGETALL", REDIS_KEY]);
      const catches = [];

      for (let index = 0; index < (values || []).length; index += 2) {
        try {
          catches.push(sanitizeCatch(JSON.parse(values[index + 1])));
        } catch (error) {
          console.warn("Ignorerte ugyldig fangst i databasen.");
        }
      }

      const tombstones = catches.length
        ? await redis(["HMGET", TOMBSTONE_KEY, ...catches.map(item => item.id)])
        : [];
      const visibleCatches = catches.filter((item, index) => !tombstones[index]);

      visibleCatches.sort((a, b) => {
        const dateCompare = String(b.date).localeCompare(String(a.date));
        return dateCompare || b.createdAt - a.createdAt;
      });
      return send(response, 200, {
        catches: visibleCatches,
        serverVersion: CLIENT_VERSION
      });
    }

    if (request.method === "POST") {
      const body = parseBody(request);
      const input = Array.isArray(body.catches) ? body.catches : [];
      if (!input.length || input.length > 50) {
        return send(response, 400, { error: "Ingen gyldige fangster å lagre." });
      }

      const catches = uniqueCatches(input);
      const sources = body.sources && typeof body.sources === "object" ? body.sources : {};

      if (body.clientVersion !== CLIENT_VERSION) {
        await appendAuditEvents(catches.map(item => createEvent("gammel_app_blokkert", {
          catchId: item.id,
          actor: item.createdBy,
          source: sources[item.id] || "unknown",
          catchDate: item.date
        })));
        return send(response, 409, {
          error: "Appen er oppdatert. Last siden på nytt før du lagrer.",
          refreshRequired: true,
          serverVersion: CLIENT_VERSION
        });
      }

      const tombstones = await redis(["HMGET", TOMBSTONE_KEY, ...catches.map(item => item.id)]);
      const allowed = catches.filter((item, index) => !tombstones[index]);
      const blocked = catches.filter((item, index) => Boolean(tombstones[index]));
      let existing = [];

      if (allowed.length) {
        existing = await redis(["HMGET", REDIS_KEY, ...allowed.map(item => item.id)]);
        const command = ["HSET", REDIS_KEY];
        allowed.forEach(item => {
          command.push(item.id, JSON.stringify(item));
        });
        await redis(command);
      }

      const events = allowed.map((item, index) => createEvent(existing[index] ? "oppdatert" : "opprettet", {
        catchId: item.id,
        actor: item.createdBy,
        source: sources[item.id] || "sync",
        catchDate: item.date
      }));
      blocked.forEach(item => {
        events.push(createEvent("gjenoppretting_blokkert", {
          catchId: item.id,
          actor: item.createdBy,
          source: sources[item.id] || "sync",
          catchDate: item.date
        }));
      });
      await appendAuditEvents(events);

      return send(response, 200, {
        saved: allowed.length,
        ignored: blocked.length,
        ignoredIds: blocked.map(item => item.id),
        serverVersion: CLIENT_VERSION
      });
    }

    if (request.method === "DELETE") {
      const body = parseBody(request);
      const ids = Array.isArray(body.ids)
        ? Array.from(new Set(body.ids
          .map(id => boundedText(id, 100))
          .filter(id => /^[A-Za-z0-9_-]{6,100}$/.test(id))))
        : [];
      if (!ids.length || ids.length > 50) {
        return send(response, 400, { error: "Ingen gyldige fangster å slette." });
      }

      const deletedBy = body.deletedBy && typeof body.deletedBy === "object"
        ? body.deletedBy
        : {};
      const currentValues = await redis(["HMGET", REDIS_KEY, ...ids]);
      const deletedAt = Date.now();
      const tombstoneCommand = ["HSET", TOMBSTONE_KEY];

      ids.forEach(id => {
        const actor = USERS.has(deletedBy[id]) ? deletedBy[id] : "Ukjent";
        tombstoneCommand.push(id, JSON.stringify({ id, actor, deletedAt }));
      });
      await redis(tombstoneCommand);

      const deleted = await redis(["HDEL", REDIS_KEY, ...ids]);
      const events = ids.map((id, index) => {
        let original = {};
        try {
          original = currentValues[index] ? sanitizeCatch(JSON.parse(currentValues[index])) : {};
        } catch (error) {
          original = {};
        }
        return createEvent("slettet", {
          catchId: id,
          actor: USERS.has(deletedBy[id]) ? deletedBy[id] : original.createdBy,
          source: "form",
          catchDate: original.date
        });
      });
      await appendAuditEvents(events);

      return send(response, 200, {
        deleted: Number(deleted) || 0,
        protected: ids.length,
        serverVersion: CLIENT_VERSION
      });
    }

    response.setHeader("Allow", "GET, POST, DELETE");
    return send(response, 405, { error: "Metoden støttes ikke." });
  } catch (error) {
    console.error("Felles fangstlagring feilet", error);
    return send(response, error.statusCode || 500, {
      error: error.statusCode === 503
        ? error.message
        : "Felles lagring er midlertidig utilgjengelig."
    });
  }
}
