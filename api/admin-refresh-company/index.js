const { app } = require("../_app");
const { getBuildInfo } = require("../_buildInfo");

const {
  adminRefreshCompanyHandler,
  buildProposedCompanyFromXaiResult,
  buildPrompt,
  parseXaiCompaniesResponse,
  loadCompanyById,
  toNormalizedDomain,
} = require("../_adminRefreshCompany");

const BUILD_INFO = getBuildInfo();
const HANDLER_ID = "admin-refresh-company";

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

const safeHandler = async (req, context) => {
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

    if (rawBody && typeof rawBody === "object") {
      return {
        ...result,
        status: 200,
        headers: { ...headers, "Content-Type": "application/json" },
        body: JSON.stringify(rawBody),
      };
    }

    const bodyText = typeof rawBody === "string" ? rawBody : rawBody == null ? "" : String(rawBody);

    // Ensure it's JSON.
    try {
      JSON.parse(bodyText || "{}");
      return {
        ...result,
        status: 200,
        headers: { ...headers, "Content-Type": "application/json" },
        body: bodyText,
      };
    } catch {
      return jsonBody({
        ok: false,
        stage: "refresh_company",
        root_cause: "non_json_response",
        attempts: [],
        diagnostics: { original_body_preview: bodyText ? bodyText.slice(0, 700) : null },
        build_id: String(BUILD_INFO.build_id || ""),
      });
    }
  } catch (e) {
    return jsonBody({
      ok: false,
      stage: "refresh_company",
      root_cause: "unhandled_exception",
      attempts: [],
      diagnostics: { message: asString(e?.message || e) || "Unhandled error" },
      build_id: String(BUILD_INFO.build_id || ""),
    });
  }
};

app.http("adminRefreshCompany", {
  route: "admin-refresh-company",
  methods: ["GET", "POST", "OPTIONS"],
  authLevel: "anonymous",
  handler: safeHandler,
});

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
