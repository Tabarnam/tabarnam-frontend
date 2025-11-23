const { app } = require("@azure/functions");

const json = (obj, status = 200) => ({
  status,
  headers: {
    "Content-Type": "application/json",
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Methods": "GET,POST,OPTIONS",
    "Access-Control-Allow-Headers": "content-type,x-functions-key",
  },
  body: JSON.stringify(obj),
});

app.http("bulkImportConfig", {
  route: "admin/bulk-import-config",
  methods: ["GET", "OPTIONS"],
  authLevel: "anonymous",
  handler: async (req, context) => {
    if (req.method === "OPTIONS") {
      return {
        status: 204,
        headers: {
          "Access-Control-Allow-Origin": "*",
          "Access-Control-Allow-Methods": "GET,OPTIONS",
          "Access-Control-Allow-Headers": "content-type",
        },
      };
    }

    // Consolidated configuration: XAI_EXTERNAL_BASE is now primary
    const xaiBase = (process.env.XAI_EXTERNAL_BASE || "").trim();
    const xaiKey = (process.env.XAI_EXTERNAL_KEY || process.env.FUNCTION_KEY || "").trim();
    const legacyFunctionUrl = (process.env.FUNCTION_URL || "").trim();

    const config = {
      xai: {
        external_base: {
          configured: !!xaiBase,
          value: xaiBase,
          status: xaiBase ? "✅ CONFIGURED" : "❌ MISSING",
          note: "Primary XAI search endpoint (consolidated configuration)",
        },
        external_key: {
          configured: !!xaiKey,
          status: xaiKey ? "✅ CONFIGURED" : "❌ MISSING",
          note: "Authentication key for XAI endpoint",
        },
        legacy_function_url: {
          configured: !!legacyFunctionUrl,
          value: legacyFunctionUrl,
          status: legacyFunctionUrl ? "⚠️ DEPRECATED - Use XAI_EXTERNAL_BASE instead" : "Not set (OK)",
          note: "FUNCTION_URL is deprecated. Use XAI_EXTERNAL_BASE for new configurations",
        },
      },
      cosmos_db: {
        endpoint: {
          configured: !!(process.env.COSMOS_DB_ENDPOINT || process.env.COSMOS_DB_DB_ENDPOINT || "").trim(),
          value: (process.env.COSMOS_DB_ENDPOINT || process.env.COSMOS_DB_DB_ENDPOINT || "").trim().split("?")[0],
          status: !!(process.env.COSMOS_DB_ENDPOINT || process.env.COSMOS_DB_DB_ENDPOINT || "").trim() ? "✅ CONFIGURED" : "❌ MISSING",
        },
        key: {
          configured: !!(process.env.COSMOS_DB_KEY || process.env.COSMOS_DB_DB_KEY || "").trim(),
          status: !!(process.env.COSMOS_DB_KEY || process.env.COSMOS_DB_DB_KEY || "").trim() ? "✅ CONFIGURED" : "❌ MISSING",
        },
        database: {
          value: process.env.COSMOS_DB_DATABASE || "tabarnam-db",
          status: "✅ CONFIGURED",
        },
        container: {
          value: process.env.COSMOS_DB_COMPANIES_CONTAINER || "companies",
          status: "✅ CONFIGURED",
        },
      },
      status: {
        xai_available: !!(
          (process.env.FUNCTION_URL || "").trim() &&
          (process.env.FUNCTION_KEY || "").trim()
        ),
        cosmos_available: !!(
          (process.env.COSMOS_DB_ENDPOINT || process.env.COSMOS_DB_DB_ENDPOINT || "").trim() &&
          (process.env.COSMOS_DB_KEY || process.env.COSMOS_DB_DB_KEY || "").trim()
        ),
        import_ready: !!(
          (process.env.FUNCTION_URL || "").trim() &&
          (process.env.FUNCTION_KEY || "").trim() &&
          (process.env.COSMOS_DB_ENDPOINT || process.env.COSMOS_DB_DB_ENDPOINT || "").trim() &&
          (process.env.COSMOS_DB_KEY || process.env.COSMOS_DB_DB_KEY || "").trim()
        ),
      },
      recommendations: [],
    };

    // Add recommendations
    if (!config.status.xai_available) {
      config.recommendations.push({
        severity: "critical",
        message: "FUNCTION_URL and FUNCTION_KEY are not configured",
        action: "Set FUNCTION_URL to your XAI API endpoint and FUNCTION_KEY to the authentication key",
        example: "FUNCTION_URL=https://your-xai-api.azurewebsites.net/api/query-companies",
      });
    }

    if (!config.status.cosmos_available) {
      config.recommendations.push({
        severity: "critical",
        message: "Cosmos DB is not properly configured",
        action: "Ensure COSMOS_DB_ENDPOINT and COSMOS_DB_KEY are set",
      });
    }

    if (!config.status.import_ready) {
      config.recommendations.push({
        severity: "critical",
        message: "Bulk import is not ready",
        action: "Configure both XAI and Cosmos DB credentials",
      });
    } else {
      config.recommendations.push({
        severity: "info",
        message: "✅ System is configured and ready for bulk imports",
      });
    }

    return json({ ok: true, config }, 200);
  },
});
