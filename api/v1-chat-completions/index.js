// api/v1-chat-completions/index.js
// Chat ingress endpoint for the dedicated worker.
// Route: /api/v1/chat/completions

let app;
try {
  ({ app } = require("../_app"));
} catch {
  app = { http() {} };
}

const {
  getHandlerVersion,
  buildIngressSnapshot,
  buildEgressSnapshot,
  setLatestIngressSnapshot,
  setLatestEgressSnapshot,
  isDebugAuthorized,
} = require("../_debugSnapshots");

function withCors(headers) {
  return {
    ...headers,
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Methods": "GET,POST,OPTIONS",
    "Access-Control-Allow-Headers": "content-type,authorization,x-tabarnam-debug-key",
  };
}

function jsonResponse(status, obj) {
  return {
    status,
    headers: withCors({ "Content-Type": "application/json" }),
    body: JSON.stringify(obj),
  };
}

// xAI deprecated /chat/completions (returns 410 Gone). Use /responses instead.
function resolveXaiResponsesUrl(rawBase) {
  const base = String(rawBase || "").trim();
  if (!base) return "https://api.x.ai/v1/responses";

  try {
    const u = new URL(base);
    const path = String(u.pathname || "");
    const lower = path.toLowerCase();

    // If already pointing to /responses, use it
    if (/\/v1\/responses\/?$/.test(lower)) {
      u.search = "";
      return u.toString();
    }

    // If pointing to /chat/completions, convert to /responses
    if (/\/v1\/chat\/completions\/?$/.test(lower)) {
      u.pathname = path.replace(/\/chat\/completions\/?$/i, "/responses");
      u.search = "";
      return u.toString();
    }

    // Normalize bases like https://api.x.ai or https://api.x.ai/v1
    let basePath = path.replace(/\/+$/, "");
    if (basePath.toLowerCase().endsWith("/v1")) basePath = basePath.slice(0, -3);

    u.pathname = `${basePath}/v1/responses`.replace(/\/{2,}/g, "/");
    // Ensure no query params are carried through.
    u.search = "";

    return u.toString();
  } catch {
    // If it's not a valid URL, fall back to the canonical external API.
    return "https://api.x.ai/v1/responses";
  }
}

// Convert /chat/completions payload to /responses format
function convertToResponsesPayload(chatPayload) {
  if (!chatPayload || typeof chatPayload !== "object") return chatPayload;

  // If it already has 'input', it's already in responses format
  if (Array.isArray(chatPayload.input)) return chatPayload;

  const messages = chatPayload.messages;
  if (!Array.isArray(messages)) return chatPayload;

  const responsesPayload = {
    model: chatPayload.model || "grok-4-latest",
    input: messages.map(m => ({
      role: m.role,
      content: typeof m.content === "string" ? m.content : String(m.content || ""),
    })),
  };

  // Preserve search parameters if present
  if (chatPayload.search_parameters) {
    responsesPayload.search = { mode: chatPayload.search_parameters.mode || "on" };
  }

  return responsesPayload;
}

// Convert /responses response back to /chat/completions format
function convertToChatCompletionsResponse(responsesData) {
  if (!responsesData || typeof responsesData !== "object") return responsesData;

  // If it already has 'choices', it's already in chat/completions format
  if (Array.isArray(responsesData.choices)) return responsesData;

  // Extract text from /responses format: output[0].content[...].text
  let content = "";
  if (Array.isArray(responsesData.output)) {
    const firstOutput = responsesData.output[0];
    if (firstOutput?.content) {
      const textItem = Array.isArray(firstOutput.content)
        ? firstOutput.content.find(c => c?.type === "output_text") || firstOutput.content[0]
        : firstOutput.content;
      if (textItem?.text) content = String(textItem.text);
    }
  }

  // Build /chat/completions format response
  return {
    id: responsesData.id || `chatcmpl-${Date.now()}`,
    object: "chat.completion",
    created: responsesData.created || Math.floor(Date.now() / 1000),
    model: responsesData.model || "grok-4-latest",
    choices: [{
      index: 0,
      message: {
        role: "assistant",
        content,
      },
      finish_reason: responsesData.stop_reason || "stop",
    }],
    usage: responsesData.usage || {
      prompt_tokens: 0,
      completion_tokens: 0,
      total_tokens: 0,
    },
  };
}

function getRequestHost(req) {
  try {
    return new URL(req.url).host;
  } catch {
    return "";
  }
}

function getUpstreamXaiUrl(req) {
  const requestHost = getRequestHost(req);
  const candidates = [
    // Prefer external first.
    process.env.XAI_EXTERNAL_BASE,
    process.env.XAI_INTERNAL_BASE, // alias
    process.env.XAI_UPSTREAM_BASE,

    // Legacy fallbacks (only when external is missing).
    process.env.XAI_BASE,
    process.env.FUNCTION_URL,
  ];

  for (const c of candidates) {
    const raw = String(c || "").trim();
    if (!raw) continue;
    const resolved = resolveXaiResponsesUrl(raw);
    try {
      const u = new URL(resolved);
      // Avoid accidentally pointing to ourselves and causing recursion.
      if (requestHost && u.host === requestHost) continue;
      return resolved;
    } catch {
      continue;
    }
  }

  return "https://api.x.ai/v1/responses";
}

function getUpstreamXaiKey() {
  // IMPORTANT: if an external key is present, legacy vars must NOT override it.
  const primary = (
    (process.env.XAI_API_KEY || "").trim() ||
    (process.env.XAI_EXTERNAL_KEY || "").trim() ||
    (process.env.FUNCTION_KEY || "").trim() ||
    (process.env.XAI_UPSTREAM_KEY || "").trim()
  );

  if (primary) return primary;

  return (process.env.XAI_KEY || "").trim() || "";
}

async function readRawBodyText(req) {
  try {
    return await req.text();
  } catch {
    return "";
  }
}

function safeJsonParse(text) {
  const t = typeof text === "string" ? text : "";
  if (!t.trim()) return { ok: false, value: null };

  try {
    return { ok: true, value: JSON.parse(t) };
  } catch {
    return { ok: false, value: null };
  }
}

function requireInternal(req) {
  const internalOnly = (process.env.INTERNAL_ONLY_CHAT_COMPLETIONS || "").trim().toLowerCase() === "true";
  if (!internalOnly) return { ok: true };

  const provided = (req.headers.get("x-internal-key") || "").trim();
  const expected = (process.env.INTERNAL_KEY || "").trim();

  if (!expected) {
    return { ok: false, status: 503, error: "INTERNAL_KEY not configured" };
  }

  if (provided !== expected) {
    return { ok: false, status: 403, error: "Forbidden" };
  }

  return { ok: true };
}

async function v1ChatCompletionsHandler(req, context) {
  if (req.method === "OPTIONS") {
    return {
      status: 200,
      headers: withCors({}),
      body: "",
    };
  }

  // Check internal-only gate if enabled
  const authCheck = requireInternal(req);
  if (!authCheck.ok) {
    return jsonResponse(authCheck.status, {
      ok: false,
      error: authCheck.error,
    });
  }

    const handler_version = getHandlerVersion();

    // Capture ingress snapshot at the very top, before any mutation.
    const rawBodyText = await readRawBodyText(req);
    const parsed = safeJsonParse(rawBodyText);

    const ingressSnapshot = buildIngressSnapshot({
      req,
      rawBodyText,
      parsedBody: parsed.value,
      parseOk: parsed.ok,
    });

    setLatestIngressSnapshot(ingressSnapshot);

    const requestUrl = (() => {
      try {
        return new URL(req.url);
      } catch {
        return null;
      }
    })();

    const explain = requestUrl ? requestUrl.searchParams.get("explain") === "1" : false;

    if (explain) {
      if (!isDebugAuthorized(req)) {
        return jsonResponse(401, { ok: false, error: "unauthorized" });
      }

      const xaiUrl = getUpstreamXaiUrl(req);
      const xaiKey = getUpstreamXaiKey();

      const outboundHeaders = {
        "Content-Type": "application/json",
        Authorization: `Bearer ${xaiKey}`,
      };

      const outboundBodyJsonText = parsed.ok ? JSON.stringify(parsed.value) : rawBodyText;

      const egressSnapshot = buildEgressSnapshot({
        xaiUrl,
        method: "POST",
        outboundHeaders,
        outboundBodyJsonText,
        fetchResult: {
          fetch_ok: false,
          status: null,
          response_json_ok: false,
          response_text_preview: "explain_mode_no_fetch",
        },
      });

      setLatestEgressSnapshot(egressSnapshot);

      return jsonResponse(200, {
        ok: true,
        explain: true,
        handler_version,
        ingress_meta: ingressSnapshot.ingress,
        egress_meta: {
          xai_url: egressSnapshot.egress.xai_url,
          method: egressSnapshot.egress.method,
          headers_redacted: egressSnapshot.egress.headers_redacted,
          body: egressSnapshot.egress.body,
        },
      });
    }

    if (!parsed.ok) {
      return jsonResponse(400, {
        ok: false,
        error: "invalid_json_body",
      });
    }

    const xaiUrl = getUpstreamXaiUrl(req);
    const xaiKey = getUpstreamXaiKey();

    const outboundHeaders = {
      "Content-Type": "application/json",
      Authorization: `Bearer ${xaiKey}`,
    };

    // Convert incoming /chat/completions payload to /responses format
    const responsesPayload = convertToResponsesPayload(parsed.value);
    const outboundBodyJsonText = JSON.stringify(responsesPayload);

    let res;
    let text = "";
    let fetch_ok = false;
    let response_json_ok = false;
    let response_text_preview = "";
    let xai_request_id = null;
    let response_preview = null;
    let convertedResponse = null;

    try {
      res = await fetch(xaiUrl, {
        method: "POST",
        headers: outboundHeaders,
        body: outboundBodyJsonText,
      });

      fetch_ok = true;
      text = await res.text().catch(() => "");

      xai_request_id =
        res.headers.get("xai-request-id") ||
        res.headers.get("x-request-id") ||
        res.headers.get("request-id") ||
        null;

      try {
        const parsedJson = JSON.parse(text);
        response_json_ok = true;
        // Convert /responses format back to /chat/completions format for backward compatibility
        convertedResponse = convertToChatCompletionsResponse(parsedJson);
        const choices = Array.isArray(convertedResponse?.choices) ? convertedResponse.choices : null;
        response_preview = {
          has_choices: Array.isArray(choices),
          choices_len: Array.isArray(choices) ? choices.length : 0,
        };
      } catch {
        response_json_ok = false;
        response_text_preview = text.length > 500 ? text.slice(0, 500) : text;
      }

      const egressSnapshot = buildEgressSnapshot({
        xaiUrl,
        method: "POST",
        outboundHeaders,
        outboundBodyJsonText,
        fetchResult: {
          fetch_ok,
          status: res.status,
          xai_request_id,
          response_json_ok,
          response_preview,
          ...(response_json_ok ? {} : { response_text_preview }),
        },
      });

      setLatestEgressSnapshot(egressSnapshot);

      // Return converted /chat/completions format response if we successfully parsed and converted
      const responseBody = response_json_ok && convertedResponse
        ? JSON.stringify(convertedResponse)
        : text;

      return {
        status: res.status,
        headers: withCors({ "Content-Type": "application/json" }),
        body: responseBody,
      };
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e || "fetch_failed");

      const egressSnapshot = buildEgressSnapshot({
        xaiUrl,
        method: "POST",
        outboundHeaders,
        outboundBodyJsonText,
        fetchResult: {
          fetch_ok: false,
          status: null,
          xai_request_id: null,
          response_json_ok: false,
          response_text_preview: msg.length > 500 ? msg.slice(0, 500) : msg,
        },
      });

      setLatestEgressSnapshot(egressSnapshot);

      context.error("[v1/chat/completions] Upstream fetch failed (details redacted from response)");
      return jsonResponse(502, {
        ok: false,
        error: "upstream_fetch_failed",
      });
    }
}

app.http("v1-chat-completions", {
  methods: ["POST", "OPTIONS"],
  authLevel: "anonymous",
  route: "v1/chat/completions",
  handler: v1ChatCompletionsHandler,
});

module.exports = { handler: v1ChatCompletionsHandler };
