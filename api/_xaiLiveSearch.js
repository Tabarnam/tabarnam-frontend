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

function extractTextFromXaiResponse(resp) {
  const r = resp && typeof resp === "object" ? resp : {};

  // Axios response shape.
  const data = r.data && typeof r.data === "object" ? r.data : null;
  if (data) {
    const content = data?.choices?.[0]?.message?.content;
    if (typeof content === "string" && content.trim()) return content;

    const alt = data?.output_text;
    if (typeof alt === "string" && alt.trim()) return alt;

    // Some xAI proxies return the content directly.
    const direct = data?.content;
    if (typeof direct === "string" && direct.trim()) return direct;
  }

  // Raw object shapes.
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
  model = "grok-2-latest",
  xaiUrl,
  xaiKey,
  search_parameters,
} = {}) {
  const resolvedBase = asString(xaiUrl).trim() || asString(getXAIEndpoint()).trim();
  const key = asString(xaiKey).trim() || asString(getXAIKey()).trim();
  const url = resolveXaiEndpointForModel(resolvedBase, model);

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

  const controller = new AbortController();
  const t = setTimeout(() => controller.abort(), Math.max(1000, Number(timeoutMs) || 12000));

  try {
    const payload = {
      model: asString(model).trim() || "grok-2-latest",
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

      const res = await fetch(url, {
        method: "POST",
        headers,
        body: JSON.stringify(payload),
        signal: controller.signal,
      });

      const text = await res.text();
      const json = (() => {
        try {
          return JSON.parse(text);
        } catch {
          return null;
        }
      })();

      const resp = json || { text };

      if (!res.ok) {
        return { ok: false, error: `upstream_http_${res.status}`, resp };
      }

      return { ok: true, resp };
    }

    const headers = {};

    if (isAzureWebsitesUrl(url)) {
      headers["x-functions-key"] = key;
    } else {
      headers.Authorization = `Bearer ${key}`;
    }

    const resp = await axios.post(url, payload, {
      headers,
      signal: controller.signal,
      timeout: Math.max(1000, Math.trunc(Number(timeoutMs) || 12000)),
      validateStatus: () => true,
    });

    const status = Number(resp?.status || 0) || 0;
    if (status < 200 || status >= 300) {
      return {
        ok: false,
        error: `upstream_http_${status || 0}`,
        resp,
      };
    }

    return { ok: true, resp };
  } catch (err) {
    return {
      ok: false,
      error: asString(err?.message || err) || "xai_request_failed",
      attempt: Number(attempt) || 0,
    };
  } finally {
    clearTimeout(t);
  }
}

module.exports = {
  xaiLiveSearch,
  extractTextFromXaiResponse,
};
