const { app } = require("../_app");

const {
  adminRefreshCompanyHandler,
  buildProposedCompanyFromXaiResult,
  buildPrompt,
  parseXaiCompaniesResponse,
  loadCompanyById,
  toNormalizedDomain,
} = require("../_adminRefreshCompany");

const { getBuildInfo } = require("../_buildInfo");

const BUILD_INFO = getBuildInfo();
const HANDLER_ID = "xadmin-api-refresh-company";

function jsonBody(obj) {
  let body = "{}";
  try {
    body = JSON.stringify(obj);
  } catch (e) {
    body = JSON.stringify({
      ok: false,
      stage: "refresh_company",
      root_cause: "response_serialization_error",
      attempts: [],
      diagnostics: {
        message: typeof e?.message === "string" ? e.message : String(e || ""),
      },
      build_id: String(BUILD_INFO.build_id || ""),
    });
  }

  return {
    status: 200,
    headers: {
      "Content-Type": "application/json",
      "Cache-Control": "no-store",
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Methods": "GET,POST,OPTIONS",
      "Access-Control-Allow-Headers": "Content-Type, Authorization, x-functions-key",
      "X-Api-Handler": HANDLER_ID,
      "X-Api-Build-Id": String(BUILD_INFO.build_id || ""),
      "X-Api-Build-Source": String(BUILD_INFO.build_id_source || ""),
    },
    body,
  };
}

const SAFE_MARKER_LINE = `[${HANDLER_ID}] handler=SAFE build=${String(BUILD_INFO.build_id || "unknown")}`;

function safeLogLine(context, line) {
  try {
    if (typeof context?.log === "function") context.log(line);
    else console.log(line);
  } catch {
    // ignore
  }
}

function asString(value) {
  return typeof value === "string" ? value : value == null ? "" : String(value);
}

function normalizeSafePayload(raw, { original_status, url } = {}) {
  const base = raw && typeof raw === "object" ? raw : {};

  const ok = base.ok === true;

  const attempts = Array.isArray(base.attempts) ? base.attempts : [];
  const diagnosticsBase = base.diagnostics && typeof base.diagnostics === "object" && !Array.isArray(base.diagnostics) ? base.diagnostics : {};

  const root_cause = ok
    ? asString(base.root_cause).trim()
    : asString(base.root_cause).trim() || asString(base.error).trim() || asString(base.message).trim() || "unknown";

  const diagnostics = {
    ...diagnosticsBase,
    http_status: typeof original_status === "number" ? original_status : diagnosticsBase.http_status,
    url: asString(diagnosticsBase.url).trim() || asString(url).trim() || undefined,
  };

  return {
    ...base,
    ok,
    stage: asString(base.stage).trim() || "refresh_company",
    root_cause,
    attempts,
    diagnostics,
    build_id: asString(base.build_id).trim() || String(BUILD_INFO.build_id || ""),
  };
}

const safeHandler = async (req, context) => {
  // Mandatory per-request marker to validate SAFE wrapper deployment.
  safeLogLine(context, SAFE_MARKER_LINE);

  try {
    const result = await adminRefreshCompanyHandler(req, context);

    if (!result || typeof result !== "object") {
      return jsonBody({
        ok: false,
        stage: "refresh_company",
        root_cause: "handler_contract",
        attempts: [],
        diagnostics: { message: "Handler returned an invalid response" },
        build_id: String(BUILD_INFO.build_id || ""),
      });
    }

    const headers = result.headers && typeof result.headers === "object" ? result.headers : {};
    const rawBody = "body" in result ? result.body : null;

    // Ensure JSON body string.
    if (rawBody && typeof rawBody === "object") {
      const normalized = normalizeSafePayload(rawBody, { original_status: result.status, url: req?.url });
      return {
        ...result,
        status: 200,
        headers: { ...headers, "Content-Type": "application/json" },
        body: JSON.stringify(normalized),
      };
    }

    const bodyText = typeof rawBody === "string" ? rawBody : rawBody == null ? "" : String(rawBody);

    // If it isn't valid JSON, normalize to a stable JSON error payload.
    try {
      const parsed = bodyText.trim() ? JSON.parse(bodyText) : null;
      const okJson = parsed !== null && (typeof parsed === "object" || Array.isArray(parsed));
      if (!okJson) {
        return jsonBody({
          ok: false,
          stage: "refresh_company",
          root_cause: "non_json_response",
          attempts: [],
          diagnostics: {
            message: "Handler returned a non-JSON response body",
            original_status: typeof result.status === "number" ? result.status : null,
            original_body_preview: bodyText ? bodyText.slice(0, 700) : null,
          },
          build_id: String(BUILD_INFO.build_id || ""),
        });
      }

      const normalized = normalizeSafePayload(parsed, { original_status: result.status, url: req?.url });

      return {
        ...result,
        status: 200,
        headers: { ...headers, "Content-Type": "application/json" },
        body: JSON.stringify(normalized),
      };
    } catch {
      return jsonBody({
        ok: false,
        stage: "refresh_company",
        root_cause: "non_json_response",
        attempts: [],
        diagnostics: {
          message: "Handler returned a non-JSON response body",
          original_status: typeof result.status === "number" ? result.status : null,
          original_body_preview: bodyText ? bodyText.slice(0, 700) : null,
        },
        build_id: String(BUILD_INFO.build_id || ""),
      });
    }
  } catch (e) {
    const message = asString(e?.message || e) || "Unhandled error";

    try {
      console.error(
        JSON.stringify({
          stage: "refresh_company",
          route: "xadmin-api-refresh-company",
          kind: "safe_wrapper_unhandled_exception",
          message,
          build_id: BUILD_INFO.build_id || null,
        })
      );
    } catch {
      // ignore
    }

    return jsonBody({
      ok: false,
      stage: "refresh_company",
      root_cause: "unhandled_exception",
      attempts: [],
      diagnostics: { message },
      build_id: String(BUILD_INFO.build_id || ""),
    });
  }
};

app.http("xadminApiRefreshCompany", {
  route: "xadmin-api-refresh-company",
  methods: ["GET", "POST", "OPTIONS"],
  authLevel: "anonymous",
  handler: safeHandler,
});


// Legacy compatibility: some deployments (or wrappers) still expect index.js to export a `handler`.
// Ensure it is the SAFE wrapper, not the raw handler.
module.exports.handler = safeHandler;

module.exports._test = {
  handler: safeHandler,
  adminRefreshCompanyHandler,
  buildProposedCompanyFromXaiResult,
  buildPrompt,
  parseXaiCompaniesResponse,
  loadCompanyById,
  toNormalizedDomain,
};
