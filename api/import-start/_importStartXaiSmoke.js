/**
 * xAI smoke test handler and safe handler wrapper.
 *
 * Extracted from import-start/index.js to reduce the monolith.
 */

const { getBuildInfo } = require("../_buildInfo");
const { getImportStartHandlerVersion } = require("../_handlerVersions");
const { getXAIEndpoint, getXAIKey } = require("../_shared");
const {
  XAI_SYSTEM_PROMPT,
  readQueryParam,
  generateRequestId,
  toTextPreview,
  sanitizeTextPreview,
  resolveXaiEndpointForModel,
  redactUrlQueryAndHash,
  postJsonWithTimeout,
  toHostPathOnlyForLog,
} = require("./_importStartRequestUtils");

// Reuse the module-level json() helper (same signature as the one in index.js).
function json(obj, status = 200, extraHeaders) {
  const buildInfo = (() => {
    try { return getBuildInfo(); } catch { return { build_id: "unknown" }; }
  })();

  const payload = obj && typeof obj === "object" && !Array.isArray(obj)
    ? { ...obj, build_id: obj.build_id || String(buildInfo?.build_id || "") }
    : obj;

  return {
    status,
    headers: {
      "Content-Type": "application/json",
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Methods": "GET,POST,OPTIONS",
      "Access-Control-Allow-Headers":
        "content-type,authorization,x-functions-key,x-request-id,x-correlation-id,x-session-id,x-client-request-id,x-tabarnam-internal,x-internal-secret,x-internal-job-secret,x-job-kind",
      "Access-Control-Expose-Headers": "x-request-id,x-correlation-id,x-session-id,X-Api-Handler,X-Api-Build-Id",
      "X-Api-Handler": "import-start",
      "X-Api-Build-Id": String(buildInfo?.build_id || ""),
      ...(extraHeaders && typeof extraHeaders === "object" ? extraHeaders : {}),
    },
    body: JSON.stringify(payload),
  };
}

// ---------------------------------------------------------------------------
// xAI smoke handler
// ---------------------------------------------------------------------------

const xaiSmokeHandler = async (req, _context) => {
  try {
    const requestId = generateRequestId(req);
    const responseHeaders = { "x-request-id": requestId };

    const method = String(req.method || "").toUpperCase();
    if (method === "OPTIONS") {
      return {
        status: 200,
        headers: {
          "Access-Control-Allow-Origin": "*",
          "Access-Control-Allow-Methods": "GET,OPTIONS",
          "Access-Control-Allow-Headers":
            "content-type,authorization,x-functions-key,x-request-id,x-correlation-id,x-session-id,x-client-request-id",
          "Access-Control-Expose-Headers": "x-request-id,x-correlation-id,x-session-id",
          ...responseHeaders,
        },
      };
    }

    if (method !== "GET") {
      return json(
        { ok: false, error: { code: "METHOD_NOT_ALLOWED", message: "Method not allowed" } },
        405,
        responseHeaders
      );
    }

    const buildInfo = getBuildInfo();
    const handlerVersion = getImportStartHandlerVersion(buildInfo);
    const model = String(readQueryParam(req, "model") || "grok-4-0709").trim() || "grok-4-0709";

    const xaiEndpointRaw = getXAIEndpoint();
    const xaiKey = getXAIKey();
    const xaiUrl = resolveXaiEndpointForModel(xaiEndpointRaw, model);

    const resolved_upstream_url_redacted = redactUrlQueryAndHash(xaiUrl) || null;
    const auth_header_present = Boolean(xaiKey);

    if (!xaiUrl || !xaiKey) {
      return json(
        {
          ok: false,
          handler_version: handlerVersion,
          build_id: buildInfo?.build_id || null,
          resolved_upstream_url_redacted,
          auth_header_present,
          status: null,
          model_returned: null,
        },
        500,
        responseHeaders
      );
    }

    const timeoutMsUsed = Math.min(20000, Number(process.env.XAI_TIMEOUT_MS) || 20000);

    const useResponsesFormat = /\/v1\/responses\/?$/i.test(xaiUrl) || xaiUrl.includes("/responses");

    const upstreamBody = useResponsesFormat
      ? {
          model,
          input: [
            { role: "system", content: XAI_SYSTEM_PROMPT },
            { role: "user", content: 'Return ONLY valid JSON with the schema {"ok":true,"source":"xai_smoke"} and no other text.' },
          ],
          search: { mode: "off" },
        }
      : {
          model,
          messages: [
            { role: "system", content: XAI_SYSTEM_PROMPT },
            { role: "user", content: 'Return ONLY valid JSON with the schema {"ok":true,"source":"xai_smoke"} and no other text.' },
          ],
          temperature: 0,
          stream: false,
        };

    const res = await postJsonWithTimeout(xaiUrl, {
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${xaiKey}` },
      body: JSON.stringify(upstreamBody),
      timeoutMs: timeoutMsUsed,
    });

    const model_returned =
      typeof res?.data?.model === "string" && res.data.model.trim() ? res.data.model.trim() : model;

    const upstream_status = res?.status ?? null;
    const okUpstream = upstream_status === 200;

    const headersObj = res && typeof res === "object" ? res.headers : null;
    const xai_request_id =
      (headersObj && typeof headersObj === "object" &&
        (headersObj["xai-request-id"] || headersObj["x-request-id"] || headersObj["request-id"])) || null;

    return json(
      {
        ok: okUpstream,
        handler_version: handlerVersion,
        build_id: buildInfo?.build_id || null,
        resolved_upstream_url_redacted,
        auth_header_present,
        status: upstream_status,
        model_returned,
        xai_request_id,
      },
      okUpstream ? 200 : 502,
      responseHeaders
    );
  } catch (e) {
    const requestId = `req_${Date.now()}_${Math.random().toString(36).slice(2)}`;
    const responseHeaders = { "x-request-id": requestId };

    return json(
      {
        ok: false,
        resolved_upstream_url_redacted: null,
        auth_header_present: false,
        status: null,
        model_returned: null,
        upstream_text_preview: toTextPreview(e?.message || String(e || ""), 2000),
      },
      502,
      responseHeaders
    );
  }
};

// ---------------------------------------------------------------------------
// Safe handler wrapper
// ---------------------------------------------------------------------------

function createSafeHandler(handler, { stage = "import_start" } = {}) {
  return async (req, context) => {
    try {
      const result = await handler(req, context);

      if (!result || typeof result !== "object") {
        return json(
          { ok: false, root_cause: "handler_contract", stage, message: "Handler returned no response" },
          200
        );
      }

      const status = Number(result.status || 200) || 200;

      if (status >= 500) {
        return json(
          { ok: false, root_cause: "handler_5xx", stage, http_status: status, message: `Handler returned HTTP ${status}` },
          200
        );
      }

      if (result.body && typeof result.body === "object") {
        return {
          ...result,
          status: 200,
          headers: {
            ...(result.headers && typeof result.headers === "object" ? result.headers : {}),
            "Content-Type": "application/json",
          },
          body: JSON.stringify(result.body),
        };
      }

      return result;
    } catch (e) {
      const message = sanitizeTextPreview(e?.message || String(e || "Unhandled exception"));
      try { console.error("[import-start] safeHandler caught exception:", message); } catch {}
      return json({ ok: false, root_cause: "unhandled_exception", message, stage }, 200);
    }
  };
}

module.exports = { xaiSmokeHandler, createSafeHandler };
