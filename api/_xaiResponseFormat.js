/**
 * _xaiResponseFormat.js
 *
 * Consolidated xAI /v1/responses format handling.
 * Single source of truth for:
 * - Detecting endpoint type (/v1/responses vs /v1/chat/completions)
 * - Building payloads in the correct format
 * - Extracting text from responses
 */

function asString(value) {
  return typeof value === "string" ? value : value == null ? "" : String(value);
}

/**
 * Detect if URL is /v1/responses endpoint (new format) vs /v1/chat/completions (legacy)
 * @param {string} rawUrl - The xAI API URL
 * @returns {boolean} - true if using /v1/responses format
 */
function isResponsesEndpoint(rawUrl) {
  const url = asString(rawUrl).trim().toLowerCase();
  return url.includes("/v1/responses") || url.includes("/responses");
}

/**
 * Convert a legacy chat/completions payload to /v1/responses format
 * @param {Object} chatPayload - Payload in {messages, max_tokens, ...} format
 * @param {Object} options - Optional settings {search: boolean}
 * @returns {Object} - Payload in {input, search: {mode}} format
 */
function convertToResponsesPayload(chatPayload, options = {}) {
  const { messages = [], model, max_tokens, temperature, search_parameters } = chatPayload || {};
  const { search = true } = options;

  // Convert messages array to input array
  const input = Array.isArray(messages)
    ? messages.map((m) => ({
        role: asString(m?.role) || "user",
        content: asString(m?.content),
      }))
    : [];

  const payload = {
    model: asString(model) || "grok-4-latest",
    input,
  };

  // Add search configuration if enabled
  if (search) {
    const mode = search_parameters?.mode || "on";
    payload.search = { mode };
  }

  return payload;
}

/**
 * Build a payload in the correct format for the endpoint
 * @param {Object} params - {url, model, prompt, systemPrompt, maxTokens, search}
 * @returns {Object} - Correctly formatted payload
 */
function buildXaiPayload({ url, model, prompt, systemPrompt, maxTokens = 900, search = true }) {
  const useResponsesFormat = isResponsesEndpoint(url);
  const resolvedModel = asString(model) || "grok-4-latest";

  if (useResponsesFormat) {
    // /v1/responses format
    const input = [];
    if (systemPrompt) {
      input.push({ role: "system", content: asString(systemPrompt) });
    }
    input.push({ role: "user", content: asString(prompt) });

    return {
      model: resolvedModel,
      input,
      ...(search ? { search: { mode: "on" } } : {}),
    };
  } else {
    // /v1/chat/completions format (legacy)
    const messages = [];
    if (systemPrompt) {
      messages.push({ role: "system", content: asString(systemPrompt) });
    }
    messages.push({ role: "user", content: asString(prompt) });

    return {
      model: resolvedModel,
      messages,
      max_tokens: Math.max(1, Math.trunc(Number(maxTokens) || 900)),
      temperature: 0.2,
      stream: false,
      ...(search ? { search_parameters: { mode: "on" } } : {}),
    };
  }
}

/**
 * Extract text content from xAI response (handles both formats)
 *
 * /v1/responses format:
 *   { output: [{ type: "message", content: [{ type: "output_text", text: "..." }] }] }
 *
 * /v1/chat/completions format:
 *   { choices: [{ message: { content: "..." } }] }
 *
 * @param {Object} resp - The xAI response (may be axios response with .data or raw)
 * @returns {string} - Extracted text content
 */
function extractTextFromXaiResponse(resp) {
  if (!resp || typeof resp !== "object") return "";

  // Handle axios response shape (has .data property)
  const data = resp.data && typeof resp.data === "object" ? resp.data : resp;

  // Try /v1/responses format first: data.output[0].content[...].text
  if (Array.isArray(data.output)) {
    const firstOutput = data.output[0];
    if (firstOutput?.content) {
      // content is an array like [{ type: "output_text", text: "..." }]
      if (Array.isArray(firstOutput.content)) {
        // Prefer output_text type, fall back to first item
        const textItem =
          firstOutput.content.find((c) => c?.type === "output_text") ||
          firstOutput.content[0];
        if (textItem?.text && typeof textItem.text === "string") {
          return textItem.text;
        }
      }
      // Handle case where content is a string (shouldn't happen but be safe)
      if (typeof firstOutput.content === "string") {
        return firstOutput.content;
      }
    }
  }

  // Try /v1/chat/completions format: data.choices[0].message.content
  if (Array.isArray(data.choices)) {
    const content = data.choices[0]?.message?.content;
    if (typeof content === "string" && content.trim()) {
      return content;
    }
  }

  // Fallback: try common alternative shapes
  const alt = data?.output_text;
  if (typeof alt === "string" && alt.trim()) return alt;

  const direct = data?.content;
  if (typeof direct === "string" && direct.trim()) return direct;

  // Last resort: if response is a string, return it
  if (typeof resp === "string") return resp;

  // Try to stringify for debugging (will be caught by caller)
  try {
    return JSON.stringify(data);
  } catch {
    return "";
  }
}

/**
 * Parse JSON from xAI response text, handling markdown code blocks
 * @param {string} text - Response text that may contain JSON
 * @returns {Object|null} - Parsed JSON or null
 */
function parseJsonFromResponse(text) {
  if (!text || typeof text !== "string") return null;

  let cleaned = text.trim();

  // Remove markdown code blocks if present
  if (cleaned.startsWith("```json")) {
    cleaned = cleaned.slice(7);
  } else if (cleaned.startsWith("```")) {
    cleaned = cleaned.slice(3);
  }
  if (cleaned.endsWith("```")) {
    cleaned = cleaned.slice(0, -3);
  }
  cleaned = cleaned.trim();

  // Try to parse as JSON
  try {
    return JSON.parse(cleaned);
  } catch {
    // Try to find JSON object in the text
    const jsonMatch = cleaned.match(/\{[\s\S]*\}/);
    if (jsonMatch) {
      try {
        return JSON.parse(jsonMatch[0]);
      } catch {
        return null;
      }
    }
    return null;
  }
}

module.exports = {
  isResponsesEndpoint,
  convertToResponsesPayload,
  buildXaiPayload,
  extractTextFromXaiResponse,
  parseJsonFromResponse,
};
