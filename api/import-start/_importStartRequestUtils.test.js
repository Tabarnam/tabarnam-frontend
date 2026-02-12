const assert = require("node:assert/strict");
const { test } = require("node:test");

const {
  isResponsesEndpoint,
  convertToResponsesPayload,
  extractXaiResponseText,
  safeJsonParse,
  isBinaryBody,
  binaryBodyToString,
  parseJsonBodyStrict,
  sanitizeTextPreview,
  toTextPreview,
  getBodyType,
  getBodyLen,
  getBodyKeysPreview,
  isProbablyStreamBody,
  toBufferChunk,
  isJsonContentType,
  toErrorString,
  getHeader,
  isDebugDiagnosticsEnabled,
  tryParseUrl,
  looksLikeCompanyUrlQuery,
  isAzureWebsitesUrl,
  joinUrlPath,
  toHostPathOnlyForLog,
  redactUrlQueryAndHash,
  getHostPathFromUrl,
  resolveXaiEndpointForModel,
  safeParseJsonObject,
  buildXaiExecutionPlan,
  ensureValidOutboundXaiBodyOrThrow,
  isProxyExplicitlyDisabled,
  isProxyExplicitlyEnabled,
  buildSaveReport,
  toStackFirstLine,
  extractXaiRequestId,
  readQueryParam,
  buildHexPreview,
} = require("./_importStartRequestUtils");

// ── isResponsesEndpoint ─────────────────────────────────────────────────────

test("isResponsesEndpoint true for /v1/responses URL", () => {
  assert.equal(isResponsesEndpoint("https://api.x.ai/v1/responses"), true);
});

test("isResponsesEndpoint false for /v1/chat/completions URL", () => {
  assert.equal(isResponsesEndpoint("https://api.x.ai/v1/chat/completions"), false);
});

test("isResponsesEndpoint handles null/empty", () => {
  assert.equal(isResponsesEndpoint(""), false);
  assert.equal(isResponsesEndpoint(null), false);
});

// ── convertToResponsesPayload ───────────────────────────────────────────────

test("convertToResponsesPayload converts messages to input format", () => {
  const result = convertToResponsesPayload({
    model: "grok-4-latest",
    messages: [
      { role: "system", content: "You are helpful." },
      { role: "user", content: "Hello" },
    ],
  });
  assert.equal(result.model, "grok-4-latest");
  assert.ok(Array.isArray(result.input));
  assert.equal(result.input.length, 2);
  assert.equal(result.input[0].role, "system");
});

test("convertToResponsesPayload passes through if already has input", () => {
  const payload = { model: "grok-4-latest", input: [{ role: "user", content: "Hi" }] };
  assert.strictEqual(convertToResponsesPayload(payload), payload);
});

test("convertToResponsesPayload includes search when search_parameters present", () => {
  const result = convertToResponsesPayload({
    messages: [{ role: "user", content: "search" }],
    search_parameters: { mode: "on" },
  });
  assert.deepEqual(result.search, { mode: "on" });
});

// ── extractXaiResponseText ──────────────────────────────────────────────────

test("extractXaiResponseText extracts from responses format", () => {
  const data = {
    output: [{ content: [{ type: "output_text", text: "Hello world" }] }],
  };
  assert.equal(extractXaiResponseText(data), "Hello world");
});

test("extractXaiResponseText extracts from chat/completions format", () => {
  const data = {
    choices: [{ message: { content: "Hello world" } }],
  };
  assert.equal(extractXaiResponseText(data), "Hello world");
});

test("extractXaiResponseText returns empty for invalid input", () => {
  assert.equal(extractXaiResponseText(null), "");
  assert.equal(extractXaiResponseText({}), "");
});

// ── safeJsonParse ───────────────────────────────────────────────────────────

test("safeJsonParse parses valid JSON", () => {
  assert.deepEqual(safeJsonParse('{"a":1}'), { a: 1 });
});

test("safeJsonParse returns null for invalid JSON", () => {
  assert.equal(safeJsonParse("not json"), null);
  assert.equal(safeJsonParse(""), null);
  assert.equal(safeJsonParse(null), null);
});

// ── isBinaryBody ────────────────────────────────────────────────────────────

test("isBinaryBody returns true for Buffer", () => {
  assert.equal(isBinaryBody(Buffer.from("test")), true);
});

test("isBinaryBody returns true for Uint8Array", () => {
  assert.equal(isBinaryBody(new Uint8Array([1, 2, 3])), true);
});

test("isBinaryBody returns true for ArrayBuffer", () => {
  assert.equal(isBinaryBody(new ArrayBuffer(4)), true);
});

test("isBinaryBody returns false for non-binary", () => {
  assert.equal(isBinaryBody("string"), false);
  assert.equal(isBinaryBody({}), false);
  assert.equal(isBinaryBody(null), false);
});

// ── binaryBodyToString ──────────────────────────────────────────────────────

test("binaryBodyToString converts Buffer to string", () => {
  assert.equal(binaryBodyToString(Buffer.from("hello")), "hello");
});

test("binaryBodyToString converts Uint8Array to string", () => {
  assert.equal(binaryBodyToString(new Uint8Array(Buffer.from("hello"))), "hello");
});

test("binaryBodyToString passes through strings", () => {
  assert.equal(binaryBodyToString("hello"), "hello");
});

// ── parseJsonBodyStrict ─────────────────────────────────────────────────────

test("parseJsonBodyStrict parses valid JSON object", () => {
  const result = parseJsonBodyStrict('{"key":"value"}');
  assert.equal(result.ok, true);
  assert.deepEqual(result.value, { key: "value" });
});

test("parseJsonBodyStrict returns empty object for empty string", () => {
  const result = parseJsonBodyStrict("");
  assert.equal(result.ok, true);
  assert.deepEqual(result.value, {});
});

test("parseJsonBodyStrict returns error for invalid JSON", () => {
  const result = parseJsonBodyStrict("{bad json}");
  assert.equal(result.ok, false);
  assert.ok(result.error);
});

test("parseJsonBodyStrict returns empty object for non-object JSON", () => {
  const result = parseJsonBodyStrict('"just a string"');
  assert.equal(result.ok, true);
  assert.deepEqual(result.value, {});
});

// ── sanitizeTextPreview ─────────────────────────────────────────────────────

test("sanitizeTextPreview redacts Bearer tokens", () => {
  const result = sanitizeTextPreview("Bearer sk-12345abc");
  assert.equal(result, "Bearer [REDACTED]");
});

test("sanitizeTextPreview redacts API keys", () => {
  const result = sanitizeTextPreview("api_key: my-secret-key");
  assert.equal(result, "api_key: [REDACTED]");
});

test("sanitizeTextPreview redacts x-functions-key", () => {
  const result = sanitizeTextPreview("x-functions-key: abc123");
  assert.equal(result, "x-functions-key: [REDACTED]");
});

test("sanitizeTextPreview handles empty input", () => {
  assert.equal(sanitizeTextPreview(""), "");
  assert.equal(sanitizeTextPreview(null), "");
});

// ── toTextPreview ───────────────────────────────────────────────────────────

test("toTextPreview truncates long strings", () => {
  const long = "a".repeat(600);
  const result = toTextPreview(long, 500);
  assert.equal(result.length, 500);
});

test("toTextPreview stringifies objects", () => {
  const result = toTextPreview({ key: "value" });
  assert.ok(result.includes("key"));
});

test("toTextPreview returns empty for null", () => {
  assert.equal(toTextPreview(null), "");
});

// ── getBodyType ─────────────────────────────────────────────────────────────

test("getBodyType identifies Buffer", () => {
  assert.equal(getBodyType(Buffer.from("")), "Buffer");
});

test("getBodyType identifies null and undefined", () => {
  assert.equal(getBodyType(null), "null");
  assert.equal(getBodyType(undefined), "undefined");
});

test("getBodyType identifies plain objects", () => {
  assert.equal(getBodyType({}), "Object");
});

// ── getBodyLen ──────────────────────────────────────────────────────────────

test("getBodyLen returns string length", () => {
  assert.equal(getBodyLen("hello"), 5);
});

test("getBodyLen returns buffer length", () => {
  assert.equal(getBodyLen(Buffer.from("test")), 4);
});

test("getBodyLen returns object key count", () => {
  assert.equal(getBodyLen({ a: 1, b: 2 }), 2);
});

test("getBodyLen returns 0 for null/undefined", () => {
  assert.equal(getBodyLen(null), 0);
  assert.equal(getBodyLen(undefined), 0);
});

// ── getBodyKeysPreview ──────────────────────────────────────────────────────

test("getBodyKeysPreview returns keys for plain object", () => {
  assert.deepEqual(getBodyKeysPreview({ a: 1, b: 2 }), ["a", "b"]);
});

test("getBodyKeysPreview returns null for array", () => {
  assert.equal(getBodyKeysPreview([1, 2]), null);
});

test("getBodyKeysPreview returns null for non-object", () => {
  assert.equal(getBodyKeysPreview(null), null);
  assert.equal(getBodyKeysPreview("string"), null);
});

test("getBodyKeysPreview caps at maxKeys", () => {
  const obj = Object.fromEntries(Array.from({ length: 30 }, (_, i) => [`k${i}`, i]));
  const result = getBodyKeysPreview(obj, 5);
  assert.equal(result.length, 5);
});

// ── isProbablyStreamBody ────────────────────────────────────────────────────

test("isProbablyStreamBody detects stream-like objects", () => {
  assert.equal(isProbablyStreamBody({ getReader: () => {} }), true);
  assert.equal(isProbablyStreamBody({ on: () => {} }), true);
  assert.equal(isProbablyStreamBody({ [Symbol.asyncIterator]: () => {} }), true);
});

test("isProbablyStreamBody returns false for plain objects", () => {
  assert.equal(isProbablyStreamBody({}), false);
  assert.equal(isProbablyStreamBody(null), false);
});

// ── toBufferChunk ───────────────────────────────────────────────────────────

test("toBufferChunk converts string to Buffer", () => {
  const result = toBufferChunk("hello");
  assert.ok(Buffer.isBuffer(result));
  assert.equal(result.toString(), "hello");
});

test("toBufferChunk passes through Buffer", () => {
  const buf = Buffer.from("test");
  assert.strictEqual(toBufferChunk(buf), buf);
});

test("toBufferChunk returns null for null", () => {
  assert.equal(toBufferChunk(null), null);
});

// ── isJsonContentType ───────────────────────────────────────────────────────

test("isJsonContentType recognizes application/json", () => {
  assert.equal(isJsonContentType("application/json"), true);
  assert.equal(isJsonContentType("application/json; charset=utf-8"), true);
});

test("isJsonContentType recognizes +json suffix", () => {
  assert.equal(isJsonContentType("application/vnd.api+json"), true);
});

test("isJsonContentType rejects non-JSON types", () => {
  assert.equal(isJsonContentType("text/html"), false);
  assert.equal(isJsonContentType(""), false);
});

// ── toErrorString ───────────────────────────────────────────────────────────

test("toErrorString extracts message from Error", () => {
  assert.equal(toErrorString(new Error("oops")), "oops");
});

test("toErrorString passes through strings", () => {
  assert.equal(toErrorString("direct string"), "direct string");
});

test("toErrorString returns 'Unknown error' for falsy", () => {
  assert.equal(toErrorString(null), "Unknown error");
  assert.equal(toErrorString(undefined), "Unknown error");
});

// ── getHeader ───────────────────────────────────────────────────────────────

test("getHeader reads from Map-like headers", () => {
  const req = { headers: { get: (name) => name === "content-type" ? "application/json" : null } };
  assert.equal(getHeader(req, "content-type"), "application/json");
});

test("getHeader reads from plain object headers", () => {
  const req = { headers: { "content-type": "text/html" } };
  assert.equal(getHeader(req, "content-type"), "text/html");
});

test("getHeader returns null for missing header", () => {
  assert.equal(getHeader({ headers: {} }, "missing"), null);
});

test("getHeader returns null for null req", () => {
  assert.equal(getHeader(null, "test"), null);
});

// ── isDebugDiagnosticsEnabled ───────────────────────────────────────────────

test("isDebugDiagnosticsEnabled detects truthy x-debug header values", () => {
  assert.equal(isDebugDiagnosticsEnabled({ headers: { "x-debug": "1" } }), true);
  assert.equal(isDebugDiagnosticsEnabled({ headers: { "x-debug": "true" } }), true);
  assert.equal(isDebugDiagnosticsEnabled({ headers: { "x-debug": "yes" } }), true);
  assert.equal(isDebugDiagnosticsEnabled({ headers: { "x-debug": "on" } }), true);
});

test("isDebugDiagnosticsEnabled returns false for missing/false values", () => {
  assert.equal(isDebugDiagnosticsEnabled({ headers: {} }), false);
  assert.equal(isDebugDiagnosticsEnabled({ headers: { "x-debug": "false" } }), false);
});

// ── tryParseUrl ─────────────────────────────────────────────────────────────

test("tryParseUrl parses full URL", () => {
  const u = tryParseUrl("https://example.com/path");
  assert.equal(u.hostname, "example.com");
});

test("tryParseUrl adds https for bare hostname", () => {
  const u = tryParseUrl("example.com");
  assert.equal(u.hostname, "example.com");
});

test("tryParseUrl returns null for empty/invalid", () => {
  assert.equal(tryParseUrl(""), null);
  assert.equal(tryParseUrl(null), null);
});

// ── looksLikeCompanyUrlQuery ────────────────────────────────────────────────

test("looksLikeCompanyUrlQuery true for valid company URLs", () => {
  assert.equal(looksLikeCompanyUrlQuery("https://acme.com"), true);
  assert.equal(looksLikeCompanyUrlQuery("acme.com"), true);
  assert.equal(looksLikeCompanyUrlQuery("https://www.example.co.uk"), true);
});

test("looksLikeCompanyUrlQuery false for localhost", () => {
  assert.equal(looksLikeCompanyUrlQuery("http://localhost:3000"), false);
  assert.equal(looksLikeCompanyUrlQuery("app.localhost"), false);
});

test("looksLikeCompanyUrlQuery false for empty/invalid", () => {
  assert.equal(looksLikeCompanyUrlQuery(""), false);
  assert.equal(looksLikeCompanyUrlQuery("not a url"), false);
});

// ── isAzureWebsitesUrl ──────────────────────────────────────────────────────

test("isAzureWebsitesUrl detects Azure domains", () => {
  assert.equal(isAzureWebsitesUrl("https://myapp.azurewebsites.net"), true);
});

test("isAzureWebsitesUrl rejects non-Azure domains", () => {
  assert.equal(isAzureWebsitesUrl("https://example.com"), false);
});

// ── joinUrlPath ─────────────────────────────────────────────────────────────

test("joinUrlPath joins paths correctly", () => {
  assert.equal(joinUrlPath("/api", "/v1/endpoint"), "/api/v1/endpoint");
  assert.equal(joinUrlPath("/api/", "v1/endpoint"), "/api/v1/endpoint");
  assert.equal(joinUrlPath("", "/v1/endpoint"), "/v1/endpoint");
});

test("joinUrlPath collapses double slashes", () => {
  assert.equal(joinUrlPath("/api/", "/v1/"), "/api/v1/");
});

// ── toHostPathOnlyForLog ────────────────────────────────────────────────────

test("toHostPathOnlyForLog extracts host+path from URL", () => {
  assert.equal(toHostPathOnlyForLog("https://api.x.ai/v1/chat?key=val"), "api.x.ai/v1/chat");
});

test("toHostPathOnlyForLog strips scheme for non-URL strings", () => {
  assert.equal(toHostPathOnlyForLog("https://example.com/path?q=1"), "example.com/path");
});

// ── redactUrlQueryAndHash ───────────────────────────────────────────────────

test("redactUrlQueryAndHash strips query and hash", () => {
  const result = redactUrlQueryAndHash("https://example.com/path?secret=abc#section");
  assert.equal(result, "https://example.com/path");
});

test("redactUrlQueryAndHash handles URL without query", () => {
  const result = redactUrlQueryAndHash("https://example.com/path");
  assert.equal(result, "https://example.com/path");
});

// ── getHostPathFromUrl ──────────────────────────────────────────────────────

test("getHostPathFromUrl extracts host and path", () => {
  const result = getHostPathFromUrl("https://api.x.ai/v1/chat");
  assert.equal(result.host, "api.x.ai");
  assert.equal(result.path, "/v1/chat");
});

test("getHostPathFromUrl returns nulls for invalid URL", () => {
  const result = getHostPathFromUrl("");
  assert.equal(result.host, null);
  assert.equal(result.path, null);
});

// ── resolveXaiEndpointForModel ──────────────────────────────────────────────

test("resolveXaiEndpointForModel appends /v1/chat/completions for standard models", () => {
  const result = resolveXaiEndpointForModel("https://api.x.ai", "grok-4-latest");
  assert.ok(result.includes("/v1/chat/completions"));
});

test("resolveXaiEndpointForModel appends /v1/responses for vision models", () => {
  const result = resolveXaiEndpointForModel("https://api.x.ai", "grok-vision-latest");
  assert.ok(result.includes("/v1/responses"));
});

test("resolveXaiEndpointForModel preserves existing /v1/chat/completions path", () => {
  const result = resolveXaiEndpointForModel("https://api.x.ai/v1/chat/completions", "grok-4-latest");
  assert.ok(result.endsWith("/v1/chat/completions"));
});

test("resolveXaiEndpointForModel preserves proxy paths", () => {
  const result = resolveXaiEndpointForModel("https://proxy.example.com/proxy-xai", "grok-4-latest");
  assert.ok(result.includes("/proxy-xai"));
});

test("resolveXaiEndpointForModel normalizes api.x.ai/api misconfiguration", () => {
  const result = resolveXaiEndpointForModel("https://api.x.ai/api", "grok-4-latest");
  assert.ok(result.includes("/v1/chat/completions"));
  assert.ok(!result.includes("/api/v1"));
});

// ── safeParseJsonObject ─────────────────────────────────────────────────────

test("safeParseJsonObject parses valid JSON object", () => {
  assert.deepEqual(safeParseJsonObject('{"a":1}'), { a: 1 });
});

test("safeParseJsonObject returns null for non-object JSON", () => {
  assert.equal(safeParseJsonObject('"string"'), null);
  assert.equal(safeParseJsonObject("42"), null);
});

test("safeParseJsonObject returns null for invalid/empty", () => {
  assert.equal(safeParseJsonObject(""), null);
  assert.equal(safeParseJsonObject("{bad}"), null);
});

// ── buildXaiExecutionPlan ───────────────────────────────────────────────────

test("buildXaiExecutionPlan includes expand step when expand_if_few", () => {
  const plan = buildXaiExecutionPlan({ expand_if_few: true });
  assert.ok(plan.includes("xai_expand_fetch"));
});

test("buildXaiExecutionPlan excludes expand step by default", () => {
  const plan = buildXaiExecutionPlan({});
  assert.ok(!plan.includes("xai_expand_fetch"));
  assert.equal(plan.length, 4);
});

// ── ensureValidOutboundXaiBodyOrThrow ───────────────────────────────────────

test("ensureValidOutboundXaiBodyOrThrow throws for missing meta", () => {
  assert.throws(() => ensureValidOutboundXaiBodyOrThrow(null));
});

test("ensureValidOutboundXaiBodyOrThrow throws for too few messages", () => {
  assert.throws(() => ensureValidOutboundXaiBodyOrThrow({ messages_len: 1, system_count: 1, user_count: 0 }));
});

test("ensureValidOutboundXaiBodyOrThrow throws for missing system message", () => {
  assert.throws(() =>
    ensureValidOutboundXaiBodyOrThrow({ messages_len: 2, system_count: 0, user_count: 2 }),
  );
});

test("ensureValidOutboundXaiBodyOrThrow throws for empty content", () => {
  assert.throws(() =>
    ensureValidOutboundXaiBodyOrThrow({
      messages_len: 2,
      system_count: 1,
      user_count: 1,
      has_empty_trimmed_content: true,
    }),
  );
});

test("ensureValidOutboundXaiBodyOrThrow passes for valid meta", () => {
  assert.doesNotThrow(() =>
    ensureValidOutboundXaiBodyOrThrow({
      messages_len: 2,
      system_count: 1,
      user_count: 1,
      has_empty_trimmed_content: false,
    }),
  );
});

// ── isProxyExplicitlyDisabled / isProxyExplicitlyEnabled ────────────────────

test("isProxyExplicitlyDisabled recognizes disabled values", () => {
  assert.equal(isProxyExplicitlyDisabled(false), true);
  assert.equal(isProxyExplicitlyDisabled(0), true);
  assert.equal(isProxyExplicitlyDisabled("false"), true);
  assert.equal(isProxyExplicitlyDisabled("0"), true);
  assert.equal(isProxyExplicitlyDisabled("no"), true);
  assert.equal(isProxyExplicitlyDisabled("off"), true);
});

test("isProxyExplicitlyDisabled returns false for enabled/null values", () => {
  assert.equal(isProxyExplicitlyDisabled(true), false);
  assert.equal(isProxyExplicitlyDisabled(null), false);
  assert.equal(isProxyExplicitlyDisabled("true"), false);
});

test("isProxyExplicitlyEnabled recognizes enabled values", () => {
  assert.equal(isProxyExplicitlyEnabled(true), true);
  assert.equal(isProxyExplicitlyEnabled(1), true);
  assert.equal(isProxyExplicitlyEnabled("true"), true);
  assert.equal(isProxyExplicitlyEnabled("1"), true);
  assert.equal(isProxyExplicitlyEnabled("yes"), true);
  assert.equal(isProxyExplicitlyEnabled("on"), true);
});

test("isProxyExplicitlyEnabled returns false for disabled values", () => {
  assert.equal(isProxyExplicitlyEnabled(false), false);
  assert.equal(isProxyExplicitlyEnabled("false"), false);
  assert.equal(isProxyExplicitlyEnabled(""), false);
});

// ── buildSaveReport ─────────────────────────────────────────────────────────

test("buildSaveReport extracts numeric fields from save result", () => {
  const result = buildSaveReport({ saved: 3, skipped: 1, failed: 0, saved_ids: ["a", "b", "c"] });
  assert.equal(result.saved, 3);
  assert.equal(result.skipped, 1);
  assert.equal(result.failed, 0);
  assert.deepEqual(result.saved_ids, ["a", "b", "c"]);
});

test("buildSaveReport defaults arrays to empty", () => {
  const result = buildSaveReport({});
  assert.deepEqual(result.saved_ids, []);
  assert.deepEqual(result.saved_ids_verified, []);
  assert.deepEqual(result.skipped_duplicates, []);
  assert.deepEqual(result.failed_items, []);
});

test("buildSaveReport applies overrides", () => {
  const result = buildSaveReport({ saved: 5 }, { saved: 0, save_outcome: "error" });
  assert.equal(result.saved, 0);
  assert.equal(result.save_outcome, "error");
});

test("buildSaveReport handles null input", () => {
  const result = buildSaveReport(null);
  assert.equal(result.saved, 0);
  assert.equal(result.skipped, 0);
});

// ── toStackFirstLine ────────────────────────────────────────────────────────

test("toStackFirstLine extracts first stack line", () => {
  const err = new Error("test");
  const line = toStackFirstLine(err);
  assert.ok(line.includes("Error: test"));
});

test("toStackFirstLine returns empty for no stack", () => {
  assert.equal(toStackFirstLine({}), "");
  assert.equal(toStackFirstLine(null), "");
});

// ── extractXaiRequestId ─────────────────────────────────────────────────────

test("extractXaiRequestId extracts x-request-id", () => {
  assert.equal(extractXaiRequestId({ "x-request-id": "abc123" }), "abc123");
});

test("extractXaiRequestId falls back through header variants", () => {
  assert.equal(extractXaiRequestId({ "xai-request-id": "xai-123" }), "xai-123");
});

test("extractXaiRequestId returns null when no headers match", () => {
  assert.equal(extractXaiRequestId({}), null);
  assert.equal(extractXaiRequestId(null), null);
});

// ── readQueryParam ──────────────────────────────────────────────────────────

test("readQueryParam reads from plain query object", () => {
  assert.equal(readQueryParam({ query: { name: "value" } }, "name"), "value");
});

test("readQueryParam reads from Map-like query", () => {
  const query = { get: (name) => name === "key" ? "val" : null };
  assert.equal(readQueryParam({ query }, "key"), "val");
});

test("readQueryParam falls back to URL parsing", () => {
  assert.equal(readQueryParam({ url: "http://localhost?key=val", query: {} }, "key"), "val");
});

test("readQueryParam returns undefined when not found", () => {
  assert.equal(readQueryParam({ query: {} }, "missing"), undefined);
  assert.equal(readQueryParam(null, "key"), undefined);
});

// ── buildHexPreview ─────────────────────────────────────────────────────────

test("buildHexPreview returns hex string for buffer", () => {
  const result = buildHexPreview(Buffer.from("AB"));
  assert.equal(result, "4142");
});

test("buildHexPreview returns empty for empty buffer", () => {
  assert.equal(buildHexPreview(Buffer.alloc(0)), "");
});
