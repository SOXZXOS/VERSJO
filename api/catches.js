const REDIS_KEY = "regiversj:catches:v1";
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

function boundedText(value, maxLength) {
  return String(value == null ? "" : value).slice(0, maxLength);
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

export default async function handler(request, response) {
  try {
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

      catches.sort((a, b) => {
        const dateCompare = String(b.date).localeCompare(String(a.date));
        return dateCompare || b.createdAt - a.createdAt;
      });
      return send(response, 200, { catches });
    }

    if (request.method === "POST") {
      const body = parseBody(request);
      const input = Array.isArray(body.catches) ? body.catches : [];
      if (!input.length || input.length > 50) {
        return send(response, 400, { error: "Ingen gyldige fangster å lagre." });
      }

      const catches = input.map(sanitizeCatch);
      const command = ["HSET", REDIS_KEY];
      catches.forEach(item => {
        command.push(item.id, JSON.stringify(item));
      });
      await redis(command);
      return send(response, 200, { saved: catches.length });
    }

    if (request.method === "DELETE") {
      const body = parseBody(request);
      const ids = Array.isArray(body.ids)
        ? body.ids.map(id => boundedText(id, 100)).filter(id => /^[A-Za-z0-9_-]{6,100}$/.test(id))
        : [];
      if (!ids.length || ids.length > 50) {
        return send(response, 400, { error: "Ingen gyldige fangster å slette." });
      }

      const deleted = await redis(["HDEL", REDIS_KEY, ...ids]);
      return send(response, 200, { deleted: Number(deleted) || 0 });
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
