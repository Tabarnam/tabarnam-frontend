/**
 * Function App diagnostic logging utility for validating API wiring.
 * 
 * This module provides logging for inbound requests to help diagnose
 * which Function App is receiving traffic and where it's being routed from.
 * 
 * From repo config (linkedBackend.json):
 * - SWA: tabarnam-frontend-v2
 * - SWA Linked Backend Routing Path: /api
 * - Primary Function App: tabarnam-xai-dedicated
 * - External API Function App: tabarnam-xai-externalapi
 * - Region: westus2
 * - Subscription: 78b03a8f-1fcd-4944-8793-8371ed2c7f55
 * - Resource Group: tabarnam-mvp-rg
 */

/**
 * Log inbound request details for wiring diagnostics.
 * Call this early in your request handler (after receiving context).
 *
 * @param {Object} context - Azure Function context
 * @param {Object} req - Express-like request object
 * @param {string} endpoint - The endpoint name being called (e.g., "search-companies")
 */
function logInboundRequest(context, req, endpoint) {
  try {
    const host = req?.headers?.host || "UNKNOWN_HOST";
    const path = req?.originalUrl || req?.url || "UNKNOWN_PATH";
    const method = req?.method || "UNKNOWN_METHOD";
    const forwardedFor = req?.headers?.["x-forwarded-for"] || req?.headers?.["x-client-ip"] || "UNKNOWN_IP";
    const forwardedProto = req?.headers?.["x-forwarded-proto"] || "UNKNOWN_PROTO";
    const userAgent = (req?.headers?.["user-agent"] || "").substring(0, 100);
    const referer = req?.headers?.referer || "(no referrer)";

    // Log to Azure Functions context (appears in Azure Monitor and Log Stream)
    context.log(`
[WIRING DIAGNOSTIC] Inbound Request
  Endpoint: ${endpoint}
  Method: ${method} ${path}
  Host Header: ${host}
  Client IP (x-forwarded-for): ${forwardedFor}
  Protocol (x-forwarded-proto): ${forwardedProto}
  Referer: ${referer}
  User-Agent: ${userAgent}
  Function App Name: ${process.env.WEBSITE_INSTANCE_ID || process.env.HOSTNAME || "UNKNOWN"}
  Request Time: ${new Date().toISOString()}
`);
  } catch (err) {
    context.log(`[WIRING DIAGNOSTIC] Failed to log inbound request: ${err?.message}`);
  }
}

/**
 * Log diagnostic information about the deployed Function App configuration.
 * Call this once during app startup or first request.
 *
 * @param {Object} context - Azure Function context
 */
function logFunctionAppConfiguration(context) {
  try {
    const websiteInstanceId = process.env.WEBSITE_INSTANCE_ID || "NOT_SET";
    const functionUrl = process.env.FUNCTION_URL || "NOT_SET";
    const region = process.env.WEBSITE_DEPLOYMENT_ID?.split(";")[1] || "UNKNOWN";

    context.log(`
[WIRING DIAGNOSTIC] Function App Configuration
  Website Instance ID: ${websiteInstanceId}
  Function URL: ${functionUrl}
  Region: ${region}
  Node Version: ${process.version}
  
  Expected Routing (from linkedBackend.json):
    - SWA: tabarnam-frontend-v2
    - SWA Routing Path: /api
    - Primary Function App Target: tabarnam-xai-dedicated
    - External API Function App: tabarnam-xai-externalapi
    - Subscription: 78b03a8f-1fcd-4944-8793-8371ed2c7f55
    - Resource Group: tabarnam-mvp-rg
    - Region: westus2
`);
  } catch (err) {
    context.log(`[WIRING DIAGNOSTIC] Failed to log Function App config: ${err?.message}`);
  }
}

/**
 * Validate that a response is being sent with correct headers.
 * Call this when returning responses to help diagnose if requests are reaching the backend.
 *
 * @param {Object} context - Azure Function context
 * @param {Object} response - Response object being sent
 * @param {string} endpoint - The endpoint name
 * @param {number} statusCode - HTTP status code
 */
function logOutboundResponse(context, response, endpoint, statusCode) {
  try {
    const hasContent = response?.body ? "(with body)" : "(no body)";
    context.log(`[WIRING DIAGNOSTIC] Outbound Response - ${endpoint} ${statusCode} ${hasContent}`);
  } catch (err) {
    context.log(`[WIRING DIAGNOSTIC] Failed to log outbound response: ${err?.message}`);
  }
}

/**
 * Create a diagnostic response that shows which Function App is handling the request.
 * Useful for /diagnostics or /health endpoints.
 *
 * @returns {Object} Diagnostic information object
 */
function getDiagnosticInfo() {
  return {
    timestamp: new Date().toISOString(),
    function_app_name: process.env.WEBSITE_INSTANCE_ID || process.env.HOSTNAME || "UNKNOWN",
    function_url: process.env.FUNCTION_URL || "NOT_SET",
    nodejs_version: process.version,
    platform: process.platform,
    app_insights_instrumentation_key_present: !!process.env.APPINSIGHTS_INSTRUMENTATION_KEY,
    expected_routing: {
      swa_name: "tabarnam-frontend-v2",
      swa_routing_path: "/api",
      primary_function_app: "tabarnam-xai-dedicated",
      external_api_function_app: "tabarnam-xai-externalapi",
      subscription_id: "78b03a8f-1fcd-4944-8793-8371ed2c7f55",
      resource_group: "tabarnam-mvp-rg",
      region: "westus2",
    },
    environment_variables: {
      COSMOS_DB_ENDPOINT: process.env.COSMOS_DB_ENDPOINT ? "SET" : "NOT_SET",
      COSMOS_DB_DATABASE: process.env.COSMOS_DB_DATABASE || "NOT_SET",
      COSMOS_DB_CONTAINER: process.env.COSMOS_DB_CONTAINER || "NOT_SET",
      AZURE_STORAGE_ACCOUNT_NAME: process.env.AZURE_STORAGE_ACCOUNT_NAME ? "SET" : "NOT_SET",
      AZURE_STORAGE_CONNECTION_STRING: process.env.AZURE_STORAGE_CONNECTION_STRING ? "SET" : "NOT_SET",
      AzureWebJobsStorage: process.env.AzureWebJobsStorage ? "SET" : "NOT_SET",
    },
  };
}

module.exports = {
  logInboundRequest,
  logFunctionAppConfiguration,
  logOutboundResponse,
  getDiagnosticInfo,
};
