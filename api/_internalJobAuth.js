function asString(value) {
  return typeof value === "string" ? value : value == null ? "" : String(value);
}

function getInternalJobSecret() {
  // Prefer a dedicated internal secret, but fall back to other already-configured secrets
  // so internal workers (resume/primary) can't 401 due to missing config.
  // IMPORTANT: this must be stable across all runtimes that might call each other.
  const secret = (
    process.env.X_INTERNAL_JOB_SECRET ||
    process.env.XAI_EXTERNAL_KEY ||
    process.env.FUNCTION_KEY ||
    ""
  ).trim();
  return secret;
}

function getAcceptableInternalSecrets() {
  const candidates = [
    process.env.X_INTERNAL_JOB_SECRET,
    process.env.XAI_EXTERNAL_KEY,
    process.env.FUNCTION_KEY,
  ]
    .map((v) => (typeof v === "string" ? v.trim() : ""))
    .filter(Boolean);

  // Dedupe while preserving order.
  const seen = new Set();
  const out = [];
  for (const v of candidates) {
    if (seen.has(v)) continue;
    seen.add(v);
    out.push(v);
  }
  return out;
}

function buildInternalFetchHeaders(extra) {
  const headers = {
    "Content-Type": "application/json",
  };

  const internalSecret = getInternalJobSecret();
  const functionsKey = (process.env.FUNCTION_KEY || "").trim() || internalSecret;

  // Some deployments are behind gateways that validate Azure Functions keys *before* the
  // request reaches our JS handler. In those cases, x-functions-key must be FUNCTION_KEY.
  // Separately, our own internal guard uses x-internal-secret / Authorization.
  if (internalSecret || functionsKey) {
    headers["x-tabarnam-internal"] = "1";
  }

  if (internalSecret) {
    headers["x-internal-secret"] = internalSecret;
    // Some gateways are more likely to forward Authorization than custom x-* headers.
    headers["Authorization"] = `Bearer ${internalSecret}`;
  }

  if (functionsKey) {
    headers["x-functions-key"] = functionsKey;
  }

  if (extra && typeof extra === "object") {
    for (const [k, v] of Object.entries(extra)) {
      if (v === undefined || v === null) continue;
      headers[k] = asString(v);
    }
  }

  return headers;
}

function isInternalJobRequest(req) {
  const acceptable = getAcceptableInternalSecrets();
  if (acceptable.length === 0) return false;

  const hdr = (name) => {
    try {
      return req?.headers?.get ? asString(req.headers.get(name)).trim() : "";
    } catch {
      return "";
    }
  };

  const internalFlag = hdr("x-tabarnam-internal");
  const providedSecret = hdr("x-internal-secret");
  const functionsKey = hdr("x-functions-key");
  const authorization = hdr("authorization");

  if (internalFlag === "1" && providedSecret && acceptable.includes(providedSecret)) return true;

  // Best-effort fallback for callers that only forward x-functions-key.
  if (functionsKey && acceptable.includes(functionsKey)) return true;

  // Additional fallback: Authorization: Bearer <secret>
  if (authorization) {
    const match = authorization.match(/^bearer\s+(.+)$/i);
    const token = match ? String(match[1] || "").trim() : "";
    if (token && acceptable.includes(token)) return true;
  }

  return false;
}

module.exports = {
  getInternalJobSecret,
  buildInternalFetchHeaders,
  isInternalJobRequest,
};
