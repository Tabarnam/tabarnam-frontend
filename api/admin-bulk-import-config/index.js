const { app } = require('@azure/functions');

const json = (obj, status = 200) => ({
  status,
  headers: {
    "Content-Type": "application/json",
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Methods": "GET,OPTIONS",
    "Access-Control-Allow-Headers": "content-type,x-functions-key",
  },
  body: JSON.stringify(obj),
});

function createBulkImportConfigHandler(routeName) {
  return async (req, context) => {
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
        xai_available: !!(xaiBase && xaiKey),
        cosmos_available: !!(
          (process.env.COSMOS_DB_ENDPOINT || process.env.COSMOS_DB_DB_ENDPOINT || "").trim() &&
          (process.env.COSMOS_DB_KEY || process.env.COSMOS_DB_DB_KEY || "").trim()
        ),
        import_ready: !!(xaiBase && xaiKey &&
          (process.env.COSMOS_DB_ENDPOINT || process.env.COSMOS_DB_DB_ENDPOINT || "").trim() &&
          (process.env.COSMOS_DB_KEY || process.env.COSMOS_DB_DB_KEY || "").trim()
        ),
      },
      recommendations: [],
    };

    if (!config.status.xai_available) {
      config.recommendations.push({
        severity: "critical",
        message: "XAI search endpoint is not configured",
        action: "Set XAI_EXTERNAL_BASE to your XAI API endpoint and XAI_EXTERNAL_KEY to the authentication key",
        example: "XAI_EXTERNAL_BASE=https://your-xai-api.azurewebsites.net/api",
        legacy_note: "Legacy FUNCTION_URL is deprecated. Use XAI_EXTERNAL_BASE instead",
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

    return json({ ok: true, route: routeName, config }, 200);
  };
}

app.http("adminBulkImportConfig", {
  route: "xadmin-api-bulk-import-config",
  methods: ["GET", "OPTIONS"],
  authLevel: "anonymous",
  handler: createBulkImportConfigHandler("xadmin-api-bulk-import-config"),
});

// Alias for older docs/links
app.http("adminBulkImportConfigAlias", {
  route: "admin/bulk-import-config",
  methods: ["GET", "OPTIONS"],
  authLevel: "anonymous",
  handler: createBulkImportConfigHandler("admin/bulk-import-config"),
});
