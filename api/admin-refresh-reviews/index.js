const { app } = require("../_app");

const { app } = require("../_app");
const { getBuildInfo } = require("../_buildInfo");

const { adminRefreshReviewsHandler } = require("../_adminRefreshReviews");

const BUILD_INFO = getBuildInfo();
const HANDLER_ID = "admin-refresh-reviews";
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

  try {
    console.log(
      JSON.stringify({
        stage: "reviews_refresh",
        route: "admin-refresh-reviews",
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
    const rawBody = result && typeof result === "object" && "body" in result ? result.body : null;
    const isJsonString = typeof rawBody === "string" && rawBody.trim().startsWith("{");

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

    if (!isJsonString) {
      return jsonBody(
        {
          ok: false,
          stage: "reviews_refresh",
          root_cause: "non_json_response",
          message: "Handler returned a non-JSON response body",
          build_id: BUILD_INFO.build_id || null,
          version_tag: VERSION_TAG,
          original_status: Number(result.status) || null,
          original_body_preview: typeof rawBody === "string" ? rawBody.slice(0, 500) : null,
        },
        500
      );
    }

    return result;
  } catch (e) {
    const message = e?.message ? String(e.message) : "Unhandled error";

    try {
      console.error(
        JSON.stringify({
          stage: "reviews_refresh",
          route: "admin-refresh-reviews",
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

app.http("adminRefreshReviews", {
  route: "admin-refresh-reviews",
  methods: ["GET", "POST", "OPTIONS"],
  authLevel: "anonymous",
  handler: safeHandler,
});

module.exports._test = {
  adminRefreshReviewsHandler,
};
