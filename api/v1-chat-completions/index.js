// api/v1-chat-completions/index.js
// Chat ingress endpoint for the dedicated worker.
// Route: /api/v1/chat/completions

const { app } = require("@azure/functions");

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

function resolveXaiChatCompletionsUrl(rawBase) {
  const base = String(rawBase || "").trim();
  if (!base) return "https://api.x.ai/v1/chat/completions";

  try {
    const u = new URL(base);
    const path = String(u.pathname || "");
    const lower = path.toLowerCase();

    if (/\/v1\/chat\/completions\/?$/.test(lower)) {
      u.search = "";
      return u.toString();
    }

    // Normalize bases like https://api.x.ai or https://api.x.ai/v1
    let basePath = path.replace(/\/+$/, "");
    if (basePath.toLowerCase().endsWith("/v1")) basePath = basePath.slice(0, -3);

    u.pathname = `${basePath}/v1/chat/completions`.replace(/\/{2,}/g, "/");
    // Ensure no query params are carried through.
    u.search = "";

    return u.toString();
  } catch {
    // If it's not a valid URL, fall back to the canonical external API.
    return "https://api.x.ai/v1/chat/completions";
  }
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
    process.env.XAI_UPSTREAM_BASE,
    process.env.XAI_BASE,
    process.env.XAI_EXTERNAL_BASE,
    process.env.FUNCTION_URL,
  ];

  for (const c of candidates) {
    const raw = String(c || "").trim();
    if (!raw) continue;
    const resolved = resolveXaiChatCompletionsUrl(raw);
    try {
      const u = new URL(resolved);
      // Avoid accidentally pointing to ourselves and causing recursion.
      if (requestHost && u.host === requestHost) continue;
      return resolved;
    } catch {
      continue;
    }
  }

  return "https://api.x.ai/v1/chat/completions";
}

function getUpstreamXaiKey() {
  return (
    (process.env.XAI_UPSTREAM_KEY || "").trim() ||
    (process.env.XAI_KEY || "").trim() ||
    (process.env.XAI_EXTERNAL_KEY || "").trim() ||
    (process.env.FUNCTION_KEY || "").trim() ||
    (process.env.XAI_API_KEY || "").trim() ||
    ""
  );
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

app.http("v1-chat-completions", {
  methods: ["POST", "OPTIONS"],
  authLevel: "anonymous",
  route: "v1/chat/completions",
  handler: async (req, context) => {
    if (req.method === "OPTIONS") {
      return {
        status: 204,
        headers: withCors({}),
      };
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

    // Capture from the exact JSON string passed to fetch().
    const outboundBodyJsonText = JSON.stringify(parsed.value);

    let res;
    let text = "";
    let fetch_ok = false;
    let response_json_ok = false;
    let response_text_preview = "";
    let xai_request_id = null;
    let response_preview = null;

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
        const choices = Array.isArray(parsedJson?.choices) ? parsedJson.choices : null;
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

      return {
        status: res.status,
        headers: withCors({ "Content-Type": res.headers.get("content-type") || "application/json" }),
        body: text,
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
  },
});
