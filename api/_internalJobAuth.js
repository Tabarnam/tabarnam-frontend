function asString(value) {
  return typeof value === "string" ? value : value == null ? "" : String(value);
}

function normalizeSecret(raw) {
  return typeof raw === "string" ? raw.trim() : "";
}

function getInternalJobSecretInfo() {
  const candidates = [
    { source: "X_INTERNAL_JOB_SECRET", value: process.env.X_INTERNAL_JOB_SECRET },
    { source: "XAI_EXTERNAL_KEY", value: process.env.XAI_EXTERNAL_KEY },
    { source: "FUNCTION_KEY", value: process.env.FUNCTION_KEY },
  ];

  for (const c of candidates) {
    const secret = normalizeSecret(c.value);
    if (secret) return { secret, secret_source: c.source };
  }

  return { secret: "", secret_source: null };
}

function getInternalJobSecret() {
  return getInternalJobSecretInfo().secret;
}

function getAcceptableInternalSecretsInfo() {
  const candidates = [
    { source: "X_INTERNAL_JOB_SECRET", value: process.env.X_INTERNAL_JOB_SECRET },
    { source: "XAI_EXTERNAL_KEY", value: process.env.XAI_EXTERNAL_KEY },
    { source: "FUNCTION_KEY", value: process.env.FUNCTION_KEY },
  ]
    .map((c) => ({ source: c.source, secret: normalizeSecret(c.value) }))
    .filter((c) => c.secret);

  // Dedupe by secret while preserving order.
  const out = [];
  const seen = new Set();
  for (const c of candidates) {
    if (seen.has(c.secret)) continue;
    seen.add(c.secret);
    out.push(c);
  }
  return out;
}

function getAcceptableInternalSecrets() {
  return getAcceptableInternalSecretsInfo().map((c) => c.secret);
}

let _randomUUID;
try {
  ({ randomUUID: _randomUUID } = require("crypto"));
} catch {
  _randomUUID = null;
}

function generateRequestId() {
  try {
    if (typeof _randomUUID === "function") return _randomUUID();
  } catch {}
  return `${Date.now()}_${Math.random().toString(16).slice(2)}`;
}

function buildInternalFetchRequest(options) {
  const opts = options && typeof options === "object" ? options : {};

  const include_functions_key = opts.include_functions_key !== false;
  const job_kind = asString(opts.job_kind).trim() || "internal";
  const request_id = asString(opts.request_id).trim() || generateRequestId();

  const extra_headers = opts.extra_headers && typeof opts.extra_headers === "object" ? opts.extra_headers : {};

  const { secret: internalSecret, secret_source } = getInternalJobSecretInfo();

  // IMPORTANT: Azure gateways may require x-functions-key *before* our handler runs.
  // Always use FUNCTION_KEY when present.
  const functionsKey = normalizeSecret(process.env.FUNCTION_KEY) || internalSecret;

  const headers = {
    "Content-Type": "application/json",
    "x-request-id": request_id,
    "x-job-kind": job_kind,
  };

  if (internalSecret || (include_functions_key && functionsKey)) {
    headers["x-tabarnam-internal"] = "1";
  }

  if (internalSecret) {
    headers["Authorization"] = `Bearer ${internalSecret}`;
    headers["x-internal-job-secret"] = internalSecret;
    // Back-compat (older handlers)
    headers["x-internal-secret"] = internalSecret;
  }

  if (include_functions_key && functionsKey) {
    headers["x-functions-key"] = functionsKey;
  }

  for (const [k, v] of Object.entries(extra_headers)) {
    if (v === undefined || v === null) continue;
    headers[k] = asString(v);
  }

  return {
    headers,
    request_id,
    job_kind,
    gateway_key_attached: Boolean(include_functions_key && functionsKey),
    secret_source,
  };
}

function buildInternalFetchHeaders(extra, options) {
  const extra_headers = extra && typeof extra === "object" ? extra : {};
  return buildInternalFetchRequest({
    ...(options && typeof options === "object" ? options : null),
    extra_headers,
  }).headers;
}

function getInternalAuthDecision(req) {
  const acceptableInfo = getAcceptableInternalSecretsInfo();
  const acceptable = acceptableInfo.map((c) => c.secret);

  const hdr = (name) => {
    try {
      return req?.headers?.get ? asString(req.headers.get(name)).trim() : "";
    } catch {
      return "";
    }
  };

  const internalFlag = hdr("x-tabarnam-internal");

  const bearer = hdr("authorization");
  let bearerToken = "";
  if (bearer) {
    const match = bearer.match(/^bearer\s+(.+)$/i);
    bearerToken = match ? asString(match[1]).trim() : "";
  }

  const xInternalJobSecret = hdr("x-internal-job-secret");
  const xInternalSecret = hdr("x-internal-secret");
  const functionsKey = hdr("x-functions-key");

  const secretToSource = (value) => {
    if (!value) return null;
    const found = acceptableInfo.find((c) => c.secret === value);
    return found ? found.source : null;
  };

  const okByBearer = Boolean(bearerToken && acceptable.includes(bearerToken));
  const okByXInternalJob = Boolean(xInternalJobSecret && acceptable.includes(xInternalJobSecret));
  const okByXInternal = Boolean(xInternalSecret && acceptable.includes(xInternalSecret));
  const okByFunctionsKey = Boolean(functionsKey && acceptable.includes(functionsKey));

  const auth_ok = okByBearer || okByXInternalJob || okByXInternal || okByFunctionsKey;

  const auth_method_used = okByBearer
    ? "bearer"
    : okByXInternalJob
      ? "x-internal-job-secret"
      : okByXInternal
        ? "x-internal-secret"
        : okByFunctionsKey
          ? "x-functions-key"
          : null;

  const secret_source = okByBearer
    ? secretToSource(bearerToken)
    : okByXInternalJob
      ? secretToSource(xInternalJobSecret)
      : okByXInternal
        ? secretToSource(xInternalSecret)
        : okByFunctionsKey
          ? secretToSource(functionsKey)
          : null;

  return {
    auth_ok,
    auth_method_used,
    secret_source,
    internal_flag_present: internalFlag === "1",
  };
}

function isInternalJobRequest(req) {
  return Boolean(getInternalAuthDecision(req).auth_ok);
}

module.exports = {
  getInternalJobSecret,
  getInternalJobSecretInfo,
  getAcceptableInternalSecrets,
  getAcceptableInternalSecretsInfo,
  buildInternalFetchHeaders,
  buildInternalFetchRequest,
  getInternalAuthDecision,
  isInternalJobRequest,
};
