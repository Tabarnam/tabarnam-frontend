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

/**
 * Build the `tools` array for /v1/responses payloads.
 * Uses xAI's agentic web_search tool instead of deprecated search parameter.
 * See: https://docs.x.ai/docs/guides/tools/search-tools
 */
function buildToolsArray(search_parameters, { enableImageUnderstanding = false } = {}) {
  const tool = { type: "web_search" };

  if (search_parameters && typeof search_parameters === "object") {
    const excluded = Array.isArray(search_parameters.excluded_domains)
      ? search_parameters.excluded_domains
          .filter(d => typeof d === "string" && d.trim())
          .slice(0, 5)
      : [];

    if (excluded.length > 0) {
      tool.filters = { excluded_domains: excluded };
    }
  }

  // Enable Grok's image understanding for logo/image verification.
  // When active, Grok can use view_image on images found during web search
  // to confirm they are actual logos (not hero banners, product images, etc.).
  // See: https://docs.x.ai/docs/guides/tools/search-tools
  if (enableImageUnderstanding) {
    tool.enable_image_understanding = true;
  }

  return [tool];
}

function normalizeHeaderKey(key) {
  return asString(key).trim().toLowerCase();
}

/**
 * Extract Retry-After header value as milliseconds.
 * xAI sends this as seconds on 429 responses.
 * Returns 0 if not present or invalid.
 */
function pickRetryAfterMs(headers) {
  if (!headers) return 0;
  try {
    let raw = null;
    if (typeof headers.get === "function") {
      raw = headers.get("retry-after");
    } else if (headers && typeof headers === "object") {
      const entries = Object.entries(headers);
      const hit = entries.find(([k]) => normalizeHeaderKey(k) === "retry-after");
      if (hit) raw = hit[1];
    }
    if (raw == null) return 0;
    const secs = Number(raw);
    if (Number.isFinite(secs) && secs > 0) return Math.min(Math.ceil(secs * 1000), 120_000);
    return 0;
  } catch {
    return 0;
  }
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

  // Normalize: handle both axios-wrapped (r.data) and raw objects
  const data = r.data && typeof r.data === "object" ? r.data : null;
  const obj = data || r;

  // 1. Top-level output_text or text convenience field (xAI /v1/responses)
  if (typeof obj.output_text === "string" && obj.output_text.trim()) {
    return obj.output_text;
  }
  if (typeof obj.text === "string" && obj.text.trim()) {
    return obj.text;
  }

  // 2. /v1/responses format: iterate output array BACKWARDS.
  //    With tools: [{ type: "web_search" }], the output array contains:
  //      output[0] = web_search_call (tool invocation — no text)
  //      output[N] = message or output_text block (actual text)
  //    The text is always in the LAST output item, not the first.
  if (Array.isArray(obj.output)) {
    for (let i = obj.output.length - 1; i >= 0; i--) {
      const item = obj.output[i];
      if (!item) continue;

      // Direct output_text block in output array (no message wrapper)
      if (item.type === "output_text" && typeof item.text === "string" && item.text.trim()) {
        return item.text;
      }

      // Message wrapper with content array
      if (Array.isArray(item.content)) {
        const textItem = item.content.find(c => c?.type === "output_text");
        if (textItem?.text && typeof textItem.text === "string" && textItem.text.trim()) {
          return textItem.text;
        }
      }

      // Fallback: content is a single object with text
      if (item.content && typeof item.content === "object" && !Array.isArray(item.content)) {
        if (typeof item.content.text === "string" && item.content.text.trim()) {
          return item.content.text;
        }
      }

      // Defensive: content is a direct string (some xAI response variants)
      if (typeof item.content === "string" && item.content.trim()) {
        return item.content;
      }
    }
  }

  // 3. /v1/chat/completions format (legacy)
  const content = obj?.choices?.[0]?.message?.content;
  if (typeof content === "string" && content.trim()) return content;

  // 4. Direct content field (some xAI proxies)
  if (typeof obj.content === "string" && obj.content.trim()) return obj.content;

  // 5. String passthrough
  if (typeof r === "string") return r;

  // Warn when all extraction paths failed — helps diagnose unexpected xAI response formats
  try { console.warn(`[extractTextFromXaiResponse] all paths failed, keys=${Object.keys(obj).join(",")}`); } catch {}

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
  useTools = false,
  enableImageUnderstanding = false,
  signal, // Optional: external AbortSignal — cancels fetch when worker is orphaned
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

  // Link external abort signal (from worker orphan detection) to our internal controller.
  // When the handler's AbortController fires, this immediately cancels the in-flight fetch.
  if (signal) {
    if (signal.aborted) { controller.abort(); }
    else { signal.addEventListener("abort", () => controller.abort(), { once: true }); }
  }

  try {
    // Detect if we're using the /responses endpoint (newer xAI API) vs /chat/completions
    const useResponsesFormat = isResponsesEndpoint(url);

    // Build payload in the appropriate format for the endpoint.
    // For /v1/responses, translate search_parameters into tools automatically.
    // search_parameters.mode: "on" is the /v1/chat/completions way to enable search;
    // for /v1/responses, the equivalent is tools: [{ type: "web_search" }].
    const shouldEnableTools = useTools || (
      useResponsesFormat &&
      search_parameters &&
      typeof search_parameters === "object" &&
      (search_parameters.mode === "on" || Object.keys(search_parameters).length > 0)
    );

    const payload = useResponsesFormat
      ? {
          model: resolvedModel,
          input: [{ role: "user", content: asString(prompt) }],
          ...(shouldEnableTools ? { tools: buildToolsArray(search_parameters, { enableImageUnderstanding }) } : {}),
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
            retry_after_ms: pickRetryAfterMs(res.headers),
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
          retry_after_ms: pickRetryAfterMs(resp?.headers),
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

/**
 * Streaming variant of xaiLiveSearch with a hard tool-call cap.
 * Uses SSE streaming to count web_search/browse_page calls in real time
 * and aborts the connection when the cap is exceeded.
 *
 * Falls back to null if streaming is unsupported (non-responses endpoint).
 * Caller should fall back to xaiLiveSearch when this returns null.
 *
 * @param {object} opts
 * @param {number} opts.maxToolCalls - Hard cap on web_search/browse_page calls (default 5)
 * @returns {Promise<object|null>} Same shape as xaiLiveSearch result, or null if unsupported
 */
async function xaiLiveSearchStreaming({
  prompt,
  timeoutMs = 210000,
  model = process.env.XAI_SEARCH_MODEL || process.env.XAI_CHAT_MODEL || process.env.XAI_MODEL || "grok-4-latest",
  xaiUrl,
  xaiKey,
  search_parameters,
  enableImageUnderstanding = false,
  signal,
  maxToolCalls = 5,
} = {}) {
  const configuredModel = asString(
    process.env.XAI_SEARCH_MODEL || process.env.XAI_CHAT_MODEL || process.env.XAI_MODEL || ""
  ).trim();
  const resolvedModel = asString(model).trim() || configuredModel || "grok-4-latest";
  const resolvedBase = asString(xaiUrl).trim() || asString(getXAIEndpoint()).trim();
  const key = asString(xaiKey).trim() || asString(getXAIKey()).trim();
  const url = resolveXaiEndpointForModel(resolvedBase, resolvedModel);

  if (!url || !key) {
    return { ok: false, error: "missing_xai_config", diagnostics: { streaming: true } };
  }

  // Streaming only supported for /v1/responses endpoint
  if (!isResponsesEndpoint(url)) {
    console.log("[xaiLiveSearchStreaming] Not a /v1/responses endpoint — returning null for fallback");
    return null;
  }

  const startedAt = Date.now();
  const controller = new AbortController();
  let abortTimerFired = false;
  const timeoutUsedMs = Math.max(1000, Math.trunc(Number(timeoutMs) || 210000));
  const timer = setTimeout(() => { abortTimerFired = true; controller.abort(); }, timeoutUsedMs);

  // Link external abort signal
  if (signal) {
    if (signal.aborted) { controller.abort(); }
    else { signal.addEventListener("abort", () => controller.abort(), { once: true }); }
  }

  try {
    const headers = { "Content-Type": "application/json" };
    if (isAzureWebsitesUrl(url)) {
      headers["x-functions-key"] = key;
    } else {
      headers.Authorization = `Bearer ${key}`;
    }

    const payload = {
      model: resolvedModel,
      input: [{ role: "user", content: asString(prompt) }],
      tools: buildToolsArray(search_parameters, { enableImageUnderstanding }),
      stream: true,
    };

    const res = await fetch(url, {
      method: "POST",
      headers,
      body: JSON.stringify(payload),
      signal: controller.signal,
    });

    if (!res.ok) {
      return {
        ok: false,
        error: `upstream_http_${res.status}`,
        diagnostics: {
          elapsed_ms: Date.now() - startedAt,
          upstream_http_status: res.status,
          streaming: true,
        },
      };
    }

    // Parse SSE stream
    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    let toolCalls = 0;
    let accumulatedText = "";
    const outputItems = [];
    let abortedByToolCap = false;
    let completedResponse = null;

    try {
      reading:
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });

        // Process complete SSE events (separated by double newline)
        let boundary;
        while ((boundary = buffer.indexOf("\n\n")) !== -1) {
          const block = buffer.slice(0, boundary);
          buffer = buffer.slice(boundary + 2);

          let eventType = "";
          let dataStr = "";
          for (const line of block.split("\n")) {
            if (line.startsWith("event: ")) eventType = line.slice(7).trim();
            else if (line.startsWith("data: ")) dataStr += line.slice(6);
            else if (line.startsWith("data:")) dataStr += line.slice(5);
          }

          if (!dataStr || dataStr.trim() === "[DONE]") continue;

          let parsed;
          try { parsed = JSON.parse(dataStr); } catch { continue; }

          // response.completed contains the full output array
          if (eventType === "response.completed" || (parsed.type === "response.completed")) {
            completedResponse = parsed.response || parsed;
            break reading;
          }

          // Detect tool calls (web_search_call items in output)
          const item = parsed.item || parsed;
          if (
            (eventType === "response.output_item.added" || eventType === "") &&
            (item.type === "web_search_call" || item.type === "browse_page_call")
          ) {
            toolCalls++;
            outputItems.push({ type: item.type, id: item.id || null });
            console.log(`[xaiLiveSearchStreaming] ${item.type} #${toolCalls} detected`);

            if (toolCalls > maxToolCalls) {
              console.log(`[xaiLiveSearchStreaming] ABORTING: tool call ${toolCalls} exceeds cap ${maxToolCalls}`);
              abortedByToolCap = true;
              controller.abort();
              break reading;
            }
          }

          // Accumulate text deltas
          if (
            eventType === "response.output_text.delta" ||
            parsed.type === "response.output_text.delta"
          ) {
            const delta = parsed.delta || "";
            if (typeof delta === "string") accumulatedText += delta;
          }

          // Also catch output_text items directly
          if (item.type === "output_text" && typeof item.text === "string") {
            accumulatedText += item.text;
          }
        }
      }
    } finally {
      try { reader.releaseLock(); } catch {}
    }

    const elapsedMs = Date.now() - startedAt;

    // If we got a completed response, use it directly (model stayed within budget)
    if (completedResponse) {
      return {
        ok: true,
        resp: completedResponse,
        diagnostics: {
          elapsed_ms: elapsedMs,
          tool_calls_counted: toolCalls,
          streaming: true,
          aborted_by_us: false,
          abort_timer_fired: abortTimerFired,
        },
      };
    }

    // If aborted by tool cap, build partial response from accumulated data
    if (abortedByToolCap) {
      const hasText = accumulatedText.length > 0;
      // Never include raw outputItems (tool call metadata like ws_...call_... IDs)
      // in the response — they get serialized as garbage by extractTextFromXaiResponse.
      // Only include the actual accumulated text content.
      const resp = {
        output: hasText
          ? [{ type: "output_text", text: accumulatedText }]
          : [],
      };
      console.log(
        `[xaiLiveSearchStreaming] Tool cap abort: ${toolCalls} calls, ` +
        `${accumulatedText.length} chars text, ok=${hasText}`
      );
      return {
        ok: hasText,
        resp,
        error: hasText ? undefined : "tool_cap_abort_no_text",
        error_code: hasText ? undefined : "tool_cap_abort",
        diagnostics: {
          elapsed_ms: elapsedMs,
          tool_calls_counted: toolCalls,
          tool_cap_aborted: true,
          text_length: accumulatedText.length,
          streaming: true,
          aborted_by_us: true,
          abort_timer_fired: abortTimerFired,
        },
      };
    }

    // Stream ended without completed event — use accumulated text
    const resp = {
      output: [
        ...outputItems,
        ...(accumulatedText ? [{ type: "output_text", text: accumulatedText }] : []),
      ],
    };
    return {
      ok: accumulatedText.length > 50,
      resp,
      diagnostics: {
        elapsed_ms: elapsedMs,
        tool_calls_counted: toolCalls,
        streaming: true,
        aborted_by_us: false,
        abort_timer_fired: abortTimerFired,
      },
    };
  } catch (err) {
    const message = asString(err?.message || err) || "streaming_failed";
    const elapsedMs = Date.now() - startedAt;
    return {
      ok: false,
      error: message,
      error_code:
        isTimeoutLikeMessage(message) || abortTimerFired || controller.signal.aborted
          ? "upstream_timeout"
          : "streaming_error",
      diagnostics: {
        elapsed_ms: elapsedMs,
        tool_calls_counted: 0,
        streaming: true,
        aborted_by_us: Boolean(controller.signal.aborted),
        abort_timer_fired: abortTimerFired,
      },
    };
  } finally {
    clearTimeout(timer);
  }
}

module.exports = {
  xaiLiveSearch,
  xaiLiveSearchStreaming,
  extractTextFromXaiResponse,
};
