function getHeader(req, name) {
  if (!req || !req.headers) return "";
  const headers = req.headers;
  if (typeof headers.get === "function") {
    try {
      return headers.get(name) || headers.get(name.toLowerCase()) || "";
    } catch {
      return "";
    }
  }
  return headers[name] || headers[name.toLowerCase()] || "";
}

function cors(req) {
  const origin = getHeader(req, "origin") || "*";
  return {
    "Access-Control-Allow-Origin": origin,
    Vary: "Origin",
    "Access-Control-Allow-Methods": "POST, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type",
  };
}

function json(body, status, req) {
  return {
    status,
    headers: { ...cors(req), "Content-Type": "application/json" },
    body: JSON.stringify(body),
  };
}

async function getJson(req) {
  if (!req) return {};
  if (typeof req.json === "function") {
    try {
      const val = await req.json();
      if (val && typeof val === "object") return val;
    } catch {}
  }
  if (req.body && typeof req.body === "object") return req.body;
  if (typeof req.rawBody === "string" && req.rawBody) {
    try {
      const parsed = JSON.parse(req.rawBody);
      if (parsed && typeof parsed === "object") return parsed;
    } catch {}
  }
  return {};
}

async function handle(req) {
  if (req.method === "OPTIONS") {
    return { status: 204, headers: cors(req) };
  }

  let body = await getJson(req);
  body = body || {};

  const text = typeof body.text === "string" ? body.text : "";
  const target = typeof body.target === "string" ? body.target : "en";

  return json({ text, target, translatedText: text }, 200, req);
}

module.exports = async function (context, req) {
  const res = await handle(req, context);
  context.res = res;
};
