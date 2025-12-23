let app;
try {
  ({ app } = require("@azure/functions"));
} catch {
  app = { http() {} };
}

const { runPrimaryJob } = require("../../_importPrimaryWorker");

function cors(req) {
  const origin = req?.headers?.get?.("origin") || "*";
  return {
    "Access-Control-Allow-Origin": origin,
    Vary: "Origin",
    "Access-Control-Allow-Methods": "POST,OPTIONS",
    "Access-Control-Allow-Headers":
      "content-type,authorization,x-functions-key,x-request-id,x-correlation-id,x-session-id,x-client-request-id",
  };
}

function json(obj, status = 200, req) {
  return {
    status,
    headers: { ...cors(req), "Content-Type": "application/json" },
    body: JSON.stringify(obj),
  };
}

async function handler(req, context) {
  const method = String(req?.method || "").toUpperCase();
  if (method === "OPTIONS") return { status: 200, headers: cors(req) };
  if (method !== "POST") return json({ ok: false, error: "Method not allowed" }, 405, req);

  const url = new URL(req.url);
  const noCosmosMode = String(url.searchParams.get("no_cosmos") || "").trim() === "1";
  const cosmosEnabled = !noCosmosMode;

  let body = {};
  try {
    const txt = await req.text();
    if (txt) body = JSON.parse(txt);
  } catch {}

  const sessionId = String(body?.session_id || body?.sessionId || url.searchParams.get("session_id") || "").trim();

  if (!sessionId) {
    return json({ ok: false, error: "Missing session_id" }, 400, req);
  }

  const result = await runPrimaryJob({
    context,
    sessionId,
    cosmosEnabled,
    invocationSource: "primary-worker",
  });

  return json(result.body, result.httpStatus || 200, req);
}

app.http("import-primary-worker", {
  route: "import/primary-worker",
  methods: ["POST", "OPTIONS"],
  authLevel: "anonymous",
  handler,
});

module.exports = { _test: { handler } };
