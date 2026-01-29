/**
 * Centralized xAI API helper
 * Standardizes all xAI calls through a single interface
 * to prevent future API deprecation breakage and ensure consistent timeout behavior.
 */

const { getXAIEndpoint, getXAIKey } = require("./_shared");

function stripTrailingSlashes(v) {
  return String(v || "").replace(/\/+$/, "");
}

function getXaiBase() {
  const endpoint = stripTrailingSlashes(getXAIEndpoint());
  if (endpoint) return endpoint;
  return stripTrailingSlashes(process.env.XAI_BASE_URL || "https://api.x.ai");
}

function getXaiResponsesUrl() {
  const base = getXaiBase();
  return `${base}/v1/responses`;
}

function isAzureWebsitesUrl(rawUrl) {
  const raw = String(rawUrl || "").trim();
  if (!raw) return false;
  try {
    const u = new URL(raw);
    return /\.azurewebsites\.net$/i.test(String(u.hostname || ""));
  } catch {
    return false;
  }
}

/**
 * Make a standardized request to the xAI Responses API.
 * 
 * @param {Object} payload - The request payload (model, input, store, etc.)
 * @param {Object} options - Optional configuration
 * @param {number} options.timeoutMs - Request timeout in milliseconds (default: 45000)
 * @returns {Promise<{ok: boolean, status: number, json: Object}>}
 */
async function xaiResponses(payload, { timeoutMs = 45000 } = {}) {
  if (!process.env.XAI_API_KEY && !process.env.XAI_EXTERNAL_KEY) {
    throw new Error("Missing XAI_API_KEY or XAI_EXTERNAL_KEY environment variable");
  }

  const url = getXaiResponsesUrl();
  const key = getXAIKey();

  if (!key) {
    throw new Error("Failed to resolve xAI API key");
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  try {
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
    let json;
    try {
      json = JSON.parse(text);
    } catch {
      json = { raw: text };
    }

    return { ok: res.ok, status: res.status, json };
  } finally {
    clearTimeout(timer);
  }
}

module.exports = {
  getXaiBase,
  getXaiResponsesUrl,
  xaiResponses,
};
