// Health endpoint for dedicated worker
// Used by diagnostics and monitoring to confirm worker availability

const { app } = require("@azure/functions");
const { getBuildInfo } = require("../../api/_buildInfo");

const BUILD_INFO = (() => {
  try {
    return getBuildInfo();
  } catch {
    return { build_id: "" };
  }
})();

app.http("workerHealth", {
  route: "health",
  methods: ["GET", "OPTIONS"],
  authLevel: "anonymous",
  handler: async (req, context) => {
    if (req.method === "OPTIONS") {
      return {
        status: 200,
        headers: {
          "Access-Control-Allow-Origin": "*",
          "Access-Control-Allow-Methods": "GET,OPTIONS",
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ ok: true }),
      };
    }

    const now = new Date().toISOString();
    const buildId =
      String(
        process.env.BUILD_ID ||
          process.env.VERCEL_GIT_COMMIT_SHA ||
          process.env.GITHUB_SHA ||
          BUILD_INFO.build_id ||
          "unknown"
      ) || "unknown";

    return {
      status: 200,
      headers: {
        "Content-Type": "application/json",
        "Access-Control-Allow-Origin": "*",
        "Cache-Control": "no-cache",
      },
      body: JSON.stringify({
        ok: true,
        service: "tabarnam-xai-dedicated",
        timestamp: now,
        build_id: buildId,
        hostname: process.env.WEBSITE_HOSTNAME || "unknown",
        environment: process.env.NODE_ENV || "unknown",
      }),
    };
  },
});

module.exports = { app };
