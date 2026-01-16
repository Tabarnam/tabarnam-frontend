function asString(value) {
  return typeof value === "string" ? value : value == null ? "" : String(value);
}

function getInternalJobSecret() {
  // Prefer a dedicated internal secret, but fall back to other already-configured secrets
  // so internal workers (resume/primary) can't 401 due to missing config.
  const secret = (
    process.env.X_INTERNAL_JOB_SECRET ||
    process.env.FUNCTION_KEY ||
    process.env.XAI_EXTERNAL_KEY ||
    ""
  ).trim();
  return secret;
}

function buildInternalFetchHeaders(extra) {
  const headers = {
    "Content-Type": "application/json",
  };

  const secret = getInternalJobSecret();

  // Use the same secret for both the internal gate and Azure Functions host key.
  // This keeps configuration simple: set X_INTERNAL_JOB_SECRET if you want a dedicated secret,
  // otherwise FUNCTION_KEY is used.
  if (secret) {
    headers["x-tabarnam-internal"] = "1";
    headers["x-internal-secret"] = secret;
    headers["x-functions-key"] = secret;
    // Some gateways are more likely to forward Authorization than custom x-* headers.
    headers["Authorization"] = `Bearer ${secret}`;
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
  const expected = getInternalJobSecret();
  if (!expected) return false;

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

  if (internalFlag === "1" && providedSecret && providedSecret === expected) return true;

  // Best-effort fallback for callers that only forward x-functions-key.
  if (functionsKey && functionsKey === expected) return true;

  // Additional fallback: Authorization: Bearer <secret>
  if (authorization) {
    const match = authorization.match(/^bearer\s+(.+)$/i);
    const token = match ? String(match[1] || "").trim() : "";
    if (token && token === expected) return true;
  }

  return false;
}

module.exports = {
  getInternalJobSecret,
  buildInternalFetchHeaders,
  isInternalJobRequest,
};
