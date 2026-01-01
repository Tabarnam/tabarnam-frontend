const { app, hasRoute } = require("../_app");
const { getBuildInfo } = require("../_buildInfo");

const { adminRefreshReviewsHandler } = require("../_adminRefreshReviews");

const BUILD_INFO = getBuildInfo();
const HANDLER_ID = "xadmin-api-refresh-reviews";
const VERSION_TAG = `ded-${HANDLER_ID}-${String(BUILD_INFO.build_id || "unknown").slice(0, 12)}`;

function jsonBody(obj, status = 200) {
  return {
    status,
    headers: {
      "Content-Type": "application/json",
      "Cache-Control": "no-store",
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Methods": "GET,POST,OPTIONS",
      "Access-Control-Allow-Headers": "Content-Type, Authorization, x-functions-key",
      "X-Api-Handler": HANDLER_ID,
      "X-Api-Build-Id": String(BUILD_INFO.build_id || ""),
      "X-Api-Build-Source": String(BUILD_INFO.build_id_source || ""),
      "X-Api-Version": VERSION_TAG,
    },
    body: JSON.stringify(obj),
  };
}

async function safeHandler(req, context) {
  const method = String(req?.method || "GET").toUpperCase();

  // One-line marker log for prod log search.
  try {
    console.log(
      JSON.stringify({
        stage: "reviews_refresh",
        route: "xadmin-api-refresh-reviews",
        kind: "request_start",
        method,
        build_id: BUILD_INFO.build_id || null,
        version_tag: VERSION_TAG,
      })
    );
  } catch {
    // ignore
  }

  try {
    const result = await adminRefreshReviewsHandler(req, context);

    // Ensure body is JSON even if handler accidentally returns a non-JSON response.
    if (!result || typeof result !== "object") {
      return jsonBody(
        {
          ok: false,
          stage: "reviews_refresh",
          root_cause: "handler_contract",
          message: "Handler returned an invalid response",
          build_id: BUILD_INFO.build_id || null,
          version_tag: VERSION_TAG,
        },
        500
      );
    }

    const rawBody = "body" in result ? result.body : null;

    // If a handler returns an object/array body, normalize it to a JSON string.
    if (rawBody && typeof rawBody === "object") {
      return {
        ...result,
        headers: {
          ...(result.headers && typeof result.headers === "object" ? result.headers : {}),
          "Content-Type": "application/json",
        },
        body: JSON.stringify(rawBody),
      };
    }

    const rawText = typeof rawBody === "string" ? rawBody : rawBody == null ? "" : String(rawBody);

    try {
      const parsed = rawText.trim() ? JSON.parse(rawText) : null;
      const okJson = parsed !== null && (typeof parsed === "object" || Array.isArray(parsed));
      if (okJson) return result;
    } catch {
      // fall through
    }

    return jsonBody(
      {
        ok: false,
        stage: "reviews_refresh",
        root_cause: "non_json_response",
        message: "Handler returned a non-JSON response body",
        build_id: BUILD_INFO.build_id || null,
        version_tag: VERSION_TAG,
        original_status: Number(result.status) || null,
        original_body_preview: rawText ? rawText.slice(0, 500) : null,
      },
      500
    );
  } catch (e) {
    const message = e?.message ? String(e.message) : "Unhandled error";

    try {
      console.error(
        JSON.stringify({
          stage: "reviews_refresh",
          route: "xadmin-api-refresh-reviews",
          kind: "unhandled_exception",
          message,
          build_id: BUILD_INFO.build_id || null,
          version_tag: VERSION_TAG,
        })
      );
    } catch {
      // ignore
    }

    return jsonBody(
      {
        ok: false,
        stage: "reviews_refresh",
        root_cause: "unhandled_exception",
        message,
        build_id: BUILD_INFO.build_id || null,
        version_tag: VERSION_TAG,
      },
      500
    );
  }
}

app.http("xadminApiRefreshReviews", {
  route: "xadmin-api-refresh-reviews",
  methods: ["GET", "POST", "OPTIONS"],
  authLevel: "anonymous",
  handler: safeHandler,
});

// Production safety: if a deployment accidentally omits admin-refresh-reviews,
// this alias keeps /api/admin-refresh-reviews available.
if (!hasRoute("admin-refresh-reviews")) {
  app.http("adminRefreshReviewsAlias", {
    route: "admin-refresh-reviews",
    methods: ["GET", "POST", "OPTIONS"],
    authLevel: "anonymous",
    handler: async (req, context) => {
      return adminRefreshReviewsHandler(req, context);
    },
  });
}

module.exports._test = {
  adminRefreshReviewsHandler,
};
