let axios;
try {
  axios = require("axios");
} catch {
  axios = null;
}

const { getXAIEndpoint, getXAIKey, resolveXaiEndpointForModel } = require("./_shared");

function asString(value) {
  return typeof value === "string" ? value : value == null ? "" : String(value);
}

function isAzureWebsitesUrl(rawUrl) {
  const raw = asString(rawUrl).trim();
  if (!raw) return false;
  try {
    const u = new URL(raw);
    return /\.azurewebsites\.net$/i.test(String(u.hostname || ""));
  } catch {
    return false;
  }
}

// Check if the URL is an xAI /responses endpoint (vs /chat/completions)
function isResponsesEndpoint(rawUrl) {
  const raw = asString(rawUrl).trim().toLowerCase();
  return raw.includes("/v1/responses") || raw.includes("/responses");
}

function normalizeHeaderKey(key) {
  return asString(key).trim().toLowerCase();
}

function pickUpstreamRequestId(headers) {
  if (!headers) return null;

  const candidates = [
    "x-request-id",
    "x-requestid",
    "x-ms-request-id",
    "x-correlation-id",
    "x-amzn-requestid",
    "request-id",
    "requestid",
  ];

  try {
    // Fetch Headers.
    if (typeof headers.get === "function") {
      for (const c of candidates) {
        const v = asString(headers.get(c)).trim();
        if (v) return v;
      }
      return null;
    }

    // Axios headers object.
    if (headers && typeof headers === "object") {
      const entries = Object.entries(headers);
      for (const c of candidates) {
        const needle = normalizeHeaderKey(c);
        const hit = entries.find(([k]) => normalizeHeaderKey(k) === needle);
        if (!hit) continue;
        const v = asString(hit[1]).trim();
        if (v) return v;
      }
    }
  } catch {
    return null;
  }

  return null;
}

function isTimeoutLikeMessage(message) {
  const m = asString(message).toLowerCase();
  if (!m) return false;
  return /\b(canceled|cancelled|timeout|timed out|abort|aborted)\b/i.test(m);
}

// Hard timeout wrapper to prevent indefinite hangs when AbortController doesn't trigger
// This is a safety net for cases where the upstream connection hangs without the abort signal firing
function withHardTimeout(promise, ms, label = "operation") {
  const timeoutMs = Math.max(1000, Math.trunc(Number(ms) || 60000));
  let timeoutId;
  const timeoutPromise = new Promise((_, reject) => {
    timeoutId = setTimeout(() => {
      reject(new Error(`Hard timeout (${timeoutMs}ms) exceeded for ${label}`));
    }, timeoutMs);
  });
  return Promise.race([promise, timeoutPromise]).finally(() => {
    if (timeoutId) clearTimeout(timeoutId);
  });
}

function extractTextFromXaiResponse(resp) {
  const r = resp && typeof resp === "object" ? resp : {};

  // Axios response shape.
  const data = r.data && typeof r.data === "object" ? r.data : null;
  if (data) {
    // Try /responses format first: data.output[0].content[...].text
    if (Array.isArray(data.output)) {
      const firstOutput = data.output[0];
      if (firstOutput?.content) {
        const textItem = Array.isArray(firstOutput.content)
          ? firstOutput.content.find(c => c?.type === "output_text") || firstOutput.content[0]
          : firstOutput.content;
        if (textItem?.text && typeof textItem.text === "string" && textItem.text.trim()) {
          return textItem.text;
        }
      }
    }

    // Try /chat/completions format
    const content = data?.choices?.[0]?.message?.content;
    if (typeof content === "string" && content.trim()) return content;

    const alt = data?.output_text;
    if (typeof alt === "string" && alt.trim()) return alt;

    // Some xAI proxies return the content directly.
    const direct = data?.content;
    if (typeof direct === "string" && direct.trim()) return direct;
  }

  // Raw object shapes - try /responses format first
  if (Array.isArray(r.output)) {
    const firstOutput = r.output[0];
    if (firstOutput?.content) {
      const textItem = Array.isArray(firstOutput.content)
        ? firstOutput.content.find(c => c?.type === "output_text") || firstOutput.content[0]
        : firstOutput.content;
      if (textItem?.text && typeof textItem.text === "string" && textItem.text.trim()) {
        return textItem.text;
      }
    }
  }

  // Raw object shapes - /chat/completions format
  const content = r?.choices?.[0]?.message?.content;
  if (typeof content === "string" && content.trim()) return content;

  const outputText = r?.output_text;
  if (typeof outputText === "string" && outputText.trim()) return outputText;

  if (typeof r === "string") return r;

  try {
    return JSON.stringify(r);
  } catch {
    return "";
  }
}

async function xaiLiveSearch({
  prompt,
  maxTokens = 900,
  timeoutMs = 12000,
  attempt = 0,
  model = process.env.XAI_SEARCH_MODEL || process.env.XAI_CHAT_MODEL || process.env.XAI_MODEL || "grok-4-latest",
  xaiUrl,
  xaiKey,
  search_parameters,
} = {}) {
  const configuredModel = asString(
    process.env.XAI_SEARCH_MODEL || process.env.XAI_CHAT_MODEL || process.env.XAI_MODEL || ""
  ).trim();
  const resolvedModel = asString(model).trim() || configuredModel || "grok-4-latest";

  // Contract tests should never hit the real network, but they may want to exercise
  // higher-level enrichment logic. Allow a global stub to provide deterministic responses.
  const stub = globalThis && typeof globalThis.__xaiLiveSearchStub === "function" ? globalThis.__xaiLiveSearchStub : null;
  if (stub) {
    try {
      const stubResult = await stub({
        prompt: asString(prompt),
        maxTokens,
        timeoutMs,
        attempt,
        model: resolvedModel,
        xaiUrl,
        xaiKey,
        search_parameters,
      });
      if (stubResult && typeof stubResult === "object") return stubResult;
    } catch (e) {
      return {
        ok: false,
        error: asString(e?.message || e || "xai_test_stub_failed") || "xai_test_stub_failed",
        details: { reason: "xai_global_stub_threw", model: resolvedModel },
      };
    }
  }

  const isNodeTestRunner =
    (Array.isArray(process.execArgv) && process.execArgv.includes("--test")) ||
    (Array.isArray(process.argv) && process.argv.includes("--test"));

  if (isNodeTestRunner) {
    return {
      ok: false,
      error: "test_mode_xai_disabled",
      details: {
        reason: "node_test_runner",
        model: resolvedModel,
      },
    };
  }

  if (!configuredModel) {
    return {
      ok: false,
      error: "XAI_CHAT_MODEL_MISSING",
      details: {
        has_XAI_SEARCH_MODEL: Boolean(asString(process.env.XAI_SEARCH_MODEL).trim()),
        has_XAI_CHAT_MODEL: Boolean(asString(process.env.XAI_CHAT_MODEL).trim()),
        has_XAI_MODEL: Boolean(asString(process.env.XAI_MODEL).trim()),
      },
    };
  }

  const resolvedBase = asString(xaiUrl).trim() || asString(getXAIEndpoint()).trim();
  const key = asString(xaiKey).trim() || asString(getXAIKey()).trim();
  const url = resolveXaiEndpointForModel(resolvedBase, resolvedModel);

  if (!url || !key) {
    return {
      ok: false,
      error: "missing_xai_config",
      details: {
        has_url: Boolean(url),
        has_key: Boolean(key),
      },
    };
  }

  const startedAt = Date.now();

  const timeoutUsedMs = Math.max(1000, Math.trunc(Number(timeoutMs) || 12000));

  const controller = new AbortController();
  let abortTimerFired = false;
  const t = setTimeout(() => {
    abortTimerFired = true;
    controller.abort();
  }, timeoutUsedMs);

  try {
    // Detect if we're using the /responses endpoint (newer xAI API) vs /chat/completions
    const useResponsesFormat = isResponsesEndpoint(url);

    // Build payload in the appropriate format for the endpoint
    const payload = useResponsesFormat
      ? {
          // /v1/responses format
          model: resolvedModel,
          input: [{ role: "user", content: asString(prompt) }],
          search: search_parameters && typeof search_parameters === "object"
            ? { mode: search_parameters.mode || "on" }
            : { mode: "on" },
        }
      : {
          // /v1/chat/completions format
          model: resolvedModel,
          messages: [{ role: "user", content: asString(prompt) }],
          max_tokens: Math.max(1, Math.trunc(Number(maxTokens) || 900)),
          temperature: 0.2,
          stream: false,
          search_parameters: {
            ...(search_parameters && typeof search_parameters === "object" ? search_parameters : {}),
            mode: "on",
          },
        };

    if (!axios) {
      const headers = {
        "Content-Type": "application/json",
      };

      if (isAzureWebsitesUrl(url)) {
        headers["x-functions-key"] = key;
      } else {
        headers.Authorization = `Bearer ${key}`;
      }

      // Wrap fetch with hard timeout as safety net for cases where AbortController doesn't fire
      const hardTimeoutMs = timeoutUsedMs + 5000; // 5 seconds longer than soft timeout
      const res = await withHardTimeout(
        fetch(url, {
          method: "POST",
          headers,
          body: JSON.stringify(payload),
          signal: controller.signal,
        }),
        hardTimeoutMs,
        "xAI fetch"
      );

      const text = await res.text();
      const json = (() => {
        try {
          return JSON.parse(text);
        } catch {
          return null;
        }
      })();

      const resp = json || { text };

      const upstreamRequestId = pickUpstreamRequestId(res.headers);
      const elapsedMs = Date.now() - startedAt;

      if (!res.ok) {
        return {
          ok: false,
          error: `upstream_http_${res.status}`,
          resp,
          diagnostics: {
            elapsed_ms: elapsedMs,
            timeout_ms: timeoutUsedMs,
            aborted_by_us: Boolean(controller.signal.aborted),
            abort_timer_fired: abortTimerFired,
            upstream_http_status: Number(res.status || 0) || 0,
            upstream_request_id: upstreamRequestId,
          },
        };
      }

      return {
        ok: true,
        resp,
        diagnostics: {
          elapsed_ms: elapsedMs,
          timeout_ms: timeoutUsedMs,
          aborted_by_us: Boolean(controller.signal.aborted),
          abort_timer_fired: abortTimerFired,
          upstream_http_status: Number(res.status || 0) || 0,
          upstream_request_id: upstreamRequestId,
        },
      };
    }

    const headers = {};

    if (isAzureWebsitesUrl(url)) {
      headers["x-functions-key"] = key;
    } else {
      headers.Authorization = `Bearer ${key}`;
    }

    // Wrap axios with hard timeout as safety net
    const hardTimeoutMs = timeoutUsedMs + 5000;
    const resp = await withHardTimeout(
      axios.post(url, payload, {
        headers,
        signal: controller.signal,
        timeout: timeoutUsedMs,
        validateStatus: () => true,
      }),
      hardTimeoutMs,
      "xAI axios"
    );

    const status = Number(resp?.status || 0) || 0;
    const upstreamRequestId = pickUpstreamRequestId(resp?.headers);
    const elapsedMs = Date.now() - startedAt;

    if (status < 200 || status >= 300) {
      return {
        ok: false,
        error: `upstream_http_${status || 0}`,
        resp,
        diagnostics: {
          elapsed_ms: elapsedMs,
          timeout_ms: timeoutUsedMs,
          aborted_by_us: Boolean(controller.signal.aborted),
          abort_timer_fired: abortTimerFired,
          upstream_http_status: status,
          upstream_request_id: upstreamRequestId,
        },
      };
    }

    return {
      ok: true,
      resp,
      diagnostics: {
        elapsed_ms: elapsedMs,
        timeout_ms: timeoutUsedMs,
        aborted_by_us: Boolean(controller.signal.aborted),
        abort_timer_fired: abortTimerFired,
        upstream_http_status: status,
        upstream_request_id: upstreamRequestId,
      },
    };
  } catch (err) {
    const message = asString(err?.message || err) || "xai_request_failed";
    const elapsedMs = Date.now() - startedAt;

    return {
      ok: false,
      error: message,
      error_code:
        isTimeoutLikeMessage(message) || abortTimerFired || controller.signal.aborted ? "upstream_timeout" : "upstream_unreachable",
      attempt: Number(attempt) || 0,
      diagnostics: {
        elapsed_ms: elapsedMs,
        timeout_ms: timeoutUsedMs,
        aborted_by_us: Boolean(controller.signal.aborted),
        abort_timer_fired: abortTimerFired,
        upstream_http_status: 0,
        upstream_request_id: null,
      },
    };
  } finally {
    clearTimeout(t);
  }
}

module.exports = {
  xaiLiveSearch,
  extractTextFromXaiResponse,
};
