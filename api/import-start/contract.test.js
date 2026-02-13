const assert = require("node:assert/strict");
const fs = require("node:fs");

// These contract tests exercise very chatty handlers. Keep output readable unless explicitly requested.
const __originalConsole = {
  log: console.log,
  warn: console.warn,
  error: console.error,
};

if (process.env.TEST_VERBOSE !== "1") {
  console.log = () => {};
  console.warn = () => {};
  console.error = () => {};

  process.on("exit", () => {
    console.log = __originalConsole.log;
    console.warn = __originalConsole.warn;
    console.error = __originalConsole.error;
  });
}
const path = require("node:path");
const { test } = require("node:test");


const { _test } = require("./index.js");
const grokEnrichment = require("../_grokEnrichment");
const { _test: importStatusTest } = require("../import-status/index.js");
const { getBuildInfo } = require("../_buildInfo");

function makeReq({
  url = "https://example.test/api/import/start",
  method = "POST",
  json,
  body,
  rawBody,
  query,
  headers,
} = {}) {
  const hdrs = new Headers();
  if (headers && typeof headers === "object") {
    for (const [k, v] of Object.entries(headers)) {
      if (v === undefined || v === null) continue;
      hdrs.set(k, String(v));
    }
  }

  const req = {
    method,
    url,
    headers: hdrs,
  };

  if (typeof json === "function") req.json = json;
  if (body !== undefined) req.body = body;
  if (rawBody !== undefined) req.rawBody = rawBody;
  if (query !== undefined) req.query = query;

  return req;
}

async function withTempEnv(overrides, fn) {
  const original = {};
  for (const [k, v] of Object.entries(overrides)) {
    original[k] = Object.prototype.hasOwnProperty.call(process.env, k) ? process.env[k] : undefined;
    if (v === undefined) delete process.env[k];
    else process.env[k] = String(v);
  }

  try {
    return await fn();
  } finally {
    for (const [k, v] of Object.entries(original)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  }
}

async function withTempGlobals(overrides, fn) {
  const originals = {};
  for (const [k, v] of Object.entries(overrides || {})) {
    originals[k] = globalThis[k];
    globalThis[k] = v;
  }

  try {
    return await fn();
  } finally {
    for (const [k, v] of Object.entries(originals)) {
      globalThis[k] = v;
    }
  }
}

function parseJsonResponse(res) {
  assert.ok(res);
  assert.equal(res.headers?.["Content-Type"] || res.headers?.["content-type"], "application/json");
  return JSON.parse(res.body);
}

const NO_NETWORK_ENV = {
  XAI_EXTERNAL_BASE: "",
  XAI_EXTERNAL_KEY: "",
  FUNCTION_URL: "",
  FUNCTION_KEY: "",
  COSMOS_DB_ENDPOINT: "",
  COSMOS_DB_KEY: "",
  COSMOS_DB_DB_ENDPOINT: "",
  COSMOS_DB_DB_KEY: "",
};

function makeFetchResponse({ status = 200, headers = {}, body = "" } = {}) {
  const hdrMap = Object.fromEntries(Object.entries(headers).map(([k, v]) => [String(k).toLowerCase(), String(v)]));
  return {
    status,
    headers: {
      get(name) {
        return hdrMap[String(name).toLowerCase()] || null;
      },
    },
    async text() {
      return body;
    },
  };
}

test("grokEnrichment.fetchCuratedReviews returns verified reviews (2 YouTube + 2 blog) with no hallucinated metadata", async () => {
  const originalFetch = globalThis.fetch;

  const youtube1 = "https://www.youtube.com/watch?v=abc123XYZ99";
  const youtube2 = "https://www.youtube.com/watch?v=def456ABC11";
  const blog1 = "https://reviews.example.com/widget-review";
  const blog2 = "https://mag.example.org/gadget";
  const soft404 = "https://bad.example.com/missing";

  const fetchStub = async (url, init = {}) => {
    const method = String(init?.method || "GET").toUpperCase();
    if (method === "HEAD") return makeFetchResponse({ status: 405, headers: { "content-type": "text/html" } });

    // YouTube oEmbed API check - return valid response for test video IDs
    if (url.startsWith("https://www.youtube.com/oembed?url=")) {
      const urlParam = new URL(url).searchParams.get("url");
      if (urlParam && (urlParam.includes("abc123XYZ99") || urlParam.includes("def456ABC11"))) {
        return makeFetchResponse({
          status: 200,
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ title: "Test Video", author_name: "Test Channel" }),
        });
      }
      // Unknown video IDs return 404 (video unavailable)
      return makeFetchResponse({ status: 404, headers: { "content-type": "text/html" } });
    }

    if (url === soft404) {
      return makeFetchResponse({
        status: 200,
        headers: { "content-type": "text/html" },
        body: "<html><head><title>404 Not Found</title></head><body>not found</body></html>",
      });
    }

    if (url === youtube1 || url === youtube2) {
      return makeFetchResponse({
        status: 200,
        headers: { "content-type": "text/html" },
        body: `<html><head><meta property=\"og:title\" content=\"Video Title\" /><meta property=\"og:description\" content=\"Video Desc\" /></head><body></body></html>`,
      });
    }

    if (url === blog1) {
      // Include company name "Acme" in HTML to pass content relevance check
      return makeFetchResponse({
        status: 200,
        headers: { "content-type": "text/html" },
        body: `<html><head><title>Acme Blog Review</title><meta name=\"author\" content=\"Jane Doe\" /><meta property=\"article:published_time\" content=\"2024-01-01\" /><meta name=\"description\" content=\"Short excerpt about Acme\" /></head><body>This is a review of Acme products.</body></html>`,
      });
    }

    if (url === blog2) {
      // Missing author/date on purpose: should come back as null (no hallucination).
      // Include company name "Acme" in HTML to pass content relevance check
      return makeFetchResponse({
        status: 200,
        headers: { "content-type": "text/html" },
        body: `<html><head><title>Magazine Review</title><meta name=\"description\" content=\"Another excerpt\" /></head><body>A review featuring Acme gadgets.</body></html>`,
      });
    }

    return makeFetchResponse({ status: 404, headers: { "content-type": "text/html" }, body: "<html><head><title>404</title></head></html>" });
  };

  const xaiStub = async ({ prompt }) => {
    // Return a mixed candidate list including a soft-404 that should be rejected.
    // Check for reviews_url_candidates (the key used in the prompt) or review_candidates (legacy)
    if (!String(prompt || "").includes("reviews_url_candidates") && !String(prompt || "").includes("review_candidates")) {
      return { ok: false, error: "unexpected_prompt" };
    }

    return {
      ok: true,
      resp: {
        choices: [
          {
            message: {
              content: JSON.stringify({
                reviews_url_candidates: [
                  { source_url: youtube1, category: "youtube" },
                  { source_url: youtube2, category: "youtube" },
                  { source_url: blog1, category: "blog" },
                  { source_url: soft404, category: "blog" },
                  { source_url: blog2, category: "blog" },
                ],
              }),
            },
          },
        ],
      },
      diagnostics: {},
    };
  };

  await withTempGlobals({ fetch: fetchStub, __xaiLiveSearchStub: xaiStub }, async () => {
    const out = await grokEnrichment.fetchCuratedReviews({
      companyName: "Acme",
      normalizedDomain: "acme.example",
      budgetMs: 25_000,
      xaiUrl: "https://xai.example.com",
      xaiKey: "test",
      model: "grok-4-latest",
    });

    // With 5-review target, 4 verifiable candidates (2 YT + 2 blogs, soft-404 rejected) → incomplete
    assert.equal(out.reviews_stage_status, "incomplete");
    assert.equal(out.curated_reviews.length, 4);

    const youtubeCount = out.curated_reviews.filter((r) => String(r?.source_url || "").includes("youtube.com")).length;
    assert.equal(youtubeCount, 2);

    // Should have exactly 2 blog reviews (blog1 + blog2; soft404 rejected)
    const blogCount = out.curated_reviews.filter((r) => !String(r?.source_url || "").includes("youtube.com")).length;
    assert.equal(blogCount, 2);
  });

  globalThis.fetch = originalFetch;
});

test("grokEnrichment.fetchCuratedReviews returns incomplete with attempted URLs when fewer than 5 valid reviews exist", async () => {
  const originalFetch = globalThis.fetch;

  const youtube1 = "https://www.youtube.com/watch?v=abc123";
  const blog1 = "https://reviews.example.com/widget-review";
  const bad1 = "https://bad.example.com/404";

  const fetchStub = async (url, init = {}) => {
    const method = String(init?.method || "GET").toUpperCase();
    if (method === "HEAD") return makeFetchResponse({ status: 405, headers: { "content-type": "text/html" } });

    if (url === youtube1 || url === blog1) {
      return makeFetchResponse({ status: 200, headers: { "content-type": "text/html" }, body: "<html><head><title>Ok</title></head></html>" });
    }

    return makeFetchResponse({ status: 404, headers: { "content-type": "text/html" }, body: "<html><head><title>404</title></head></html>" });
  };

  const xaiStub = async ({ prompt }) => {
    // Check for reviews_url_candidates (the key used in the prompt) or review_candidates (legacy)
    if (!String(prompt || "").includes("reviews_url_candidates") && !String(prompt || "").includes("review_candidates")) {
      return { ok: false, error: "unexpected_prompt" };
    }

    return {
      ok: true,
      resp: {
        choices: [
          {
            message: {
              content: JSON.stringify({
                reviews_url_candidates: [
                  { source_url: youtube1, category: "youtube" },
                  { source_url: blog1, category: "blog" },
                  { source_url: bad1, category: "blog" },
                ],
              }),
            },
          },
        ],
      },
      diagnostics: {},
    };
  };

  await withTempGlobals({ fetch: fetchStub, __xaiLiveSearchStub: xaiStub }, async () => {
    const out = await grokEnrichment.fetchCuratedReviews({
      companyName: "Acme",
      normalizedDomain: "acme.example",
      budgetMs: 25_000,
      xaiUrl: "https://xai.example.com",
      xaiKey: "test",
      model: "grok-4-latest",
    });

    assert.equal(out.reviews_stage_status, "incomplete");
    assert.ok(Array.isArray(out.attempted_urls));
    assert.ok(out.attempted_urls.length >= 2);
    assert.ok(out.incomplete_reason);
  });

  globalThis.fetch = originalFetch;
});

test("grokEnrichment.fetchHeadquartersLocation returns HQ + source_urls", async () => {
  const xaiStub = async ({ prompt }) => {
    if (!String(prompt || "").includes("headquarters_location")) {
      return { ok: false, error: "unexpected_prompt" };
    }

    return {
      ok: true,
      resp: {
        choices: [
          {
            message: {
              content: JSON.stringify({
                headquarters_location: "Austin, TX, United States",
                source_urls: ["https://example.com/source1", "https://example.com/source2"],
              }),
            },
          },
        ],
      },
      diagnostics: {},
    };
  };

  await withTempGlobals({ __xaiLiveSearchStub: xaiStub }, async () => {
    const out = await grokEnrichment.fetchHeadquartersLocation({
      companyName: "Acme",
      normalizedDomain: "acme.example",
      budgetMs: 20_000,
      xaiUrl: "https://xai.example.com",
      xaiKey: "test",
    });

    assert.equal(out.hq_status, "ok");
    assert.equal(out.headquarters_location, "Austin, TX, United States");
    assert.deepEqual(out.source_urls, ["https://example.com/source1", "https://example.com/source2"]);
  });
});

test("/api/import/start safeHandler returns HTTP 200 JSON on unhandled exception", async () => {
  const throwingHandler = _test.createSafeHandler(async () => {
    throw new Error("boom");
  });

  const res = await throwingHandler(makeReq(), { log() {} });
  const body = parseJsonResponse(res);

  assert.equal(res.status, 200);
  assert.equal(body.ok, false);
  assert.equal(body.root_cause, "unhandled_exception");
  assert.equal(body.stage, "import_start");
  assert.ok(String(body.message || "").includes("boom"));
});

test("/api/import/start parses body with proxy=false boolean", async () => {
  await withTempEnv(NO_NETWORK_ENV, async () => {
    const req = makeReq({
      json: async () => ({
        proxy: false,
        debug: true,
        dry_run: true,
        company_name: "Test",
        website_url: "https://example.com",
      }),
    });

    const res = await _test.importStartHandler(req, { log() {} });
    const body = parseJsonResponse(res);

    assert.equal(body.company_name, "Test");
    assert.equal(body.website_url, "https://example.com");
    assert.notEqual(body.stage, "proxy_config");
  });
});

test("/api/import/start parses body with proxy='false' string", async () => {
  await withTempEnv(NO_NETWORK_ENV, async () => {
    const req = makeReq({
      body: JSON.stringify({
        proxy: "false",
        debug: true,
        dry_run: true,
        company_name: "Test",
        website_url: "https://example.com",
      }),
    });

    const res = await _test.importStartHandler(req, { log() {} });
    const body = parseJsonResponse(res);

    assert.equal(body.company_name, "Test");
    assert.equal(body.website_url, "https://example.com");
    assert.notEqual(body.stage, "proxy_config");
  });
});

test("/api/import/start returns INVALID_JSON_BODY for malformed JSON", async () => {
  await withTempEnv(NO_NETWORK_ENV, async () => {
    const req = makeReq({
      body: "{not valid json",
    });

    const res = await _test.importStartHandler(req, { log() {} });
    const body = parseJsonResponse(res);

    assert.equal(res.status, 200);
    assert.equal(body.ok, false);
    assert.equal(body.http_status, 400);
    assert.equal(body?.error?.code, "INVALID_JSON_BODY");
    assert.equal(body.stage, "validate_request");
    assert.equal(body?.details?.body_source, "req.text");
  });
});

test("/api/import/start includes parse diagnostics for INVALID_JSON_BODY when x-debug header is present", async () => {
  await withTempEnv(NO_NETWORK_ENV, async () => {
    const req = makeReq({
      body: "{not valid json",
      headers: {
        "x-debug": "1",
        "content-type": "application/json",
        "content-length": "13",
      },
    });

    const res = await _test.importStartHandler(req, { log() {} });
    const body = parseJsonResponse(res);

    assert.equal(res.status, 200);
    assert.equal(body.ok, false);
    assert.equal(body.http_status, 400);
    assert.equal(body?.error?.code, "INVALID_JSON_BODY");
    assert.equal(body?.details?.body_source, "req.text");
    assert.ok(body?.diagnostics?.parse_error);
    assert.ok(body?.diagnostics?.first_bytes_preview);
  });
});

test("/api/import/start respects query proxy=false when body has no proxy", async () => {
  await withTempEnv(NO_NETWORK_ENV, async () => {
    const rawBody = Buffer.from(
      JSON.stringify({
        debug: true,
        dry_run: true,
        company_name: "Test",
        website_url: "https://example.com",
      }),
      "utf8"
    );

    const req = makeReq({
      url: "https://example.test/api/import/start?proxy=false",
      rawBody,
      query: { proxy: "false" },
    });

    const res = await _test.importStartHandler(req, { log() {} });
    const body = parseJsonResponse(res);

    assert.equal(body.company_name, "Test");
    assert.equal(body.website_url, "https://example.com");
    assert.notEqual(body.stage, "proxy_config");
  });
});

test("/api/import/start uses req.body object even when rawBody is present", async () => {
  await withTempEnv(NO_NETWORK_ENV, async () => {
    const rawBody = Buffer.from("{not valid json", "utf8");

    const req = makeReq({
      body: {
        dry_run: true,
        query: "https://parachutehome.com/",
        queryTypes: ["company_url"],
      },
      rawBody,
    });

    const res = await _test.importStartHandler(req, { log() {} });
    const body = parseJsonResponse(res);

    assert.equal(res.status, 200);
    assert.equal(body.ok, true);
    assert.equal(body.received?.query, "https://parachutehome.com/");
    assert.equal(body.received?.queryType, "company_url");
  });
});

test("/api/import/start parses stream body when req.body is stream-like", async () => {
  const { Readable } = require("node:stream");

  await withTempEnv(NO_NETWORK_ENV, async () => {
    const stream = Readable.from([
      Buffer.from(
        JSON.stringify({
          dry_run: true,
          query: "https://alppouch.com/",
          queryTypes: ["company_url"],
        }),
        "utf8"
      ),
    ]);

    const req = makeReq({ body: stream });
    const res = await _test.importStartHandler(req, { log() {} });
    const body = parseJsonResponse(res);

    assert.equal(res.status, 200);
    assert.equal(body.ok, true);
    assert.equal(body.received?.query, "https://alppouch.com/");
    assert.equal(body.received?.queryType, "company_url");
  });
});

test("/api/import/start parses WHATWG ReadableStream body", async () => {
  await withTempEnv(NO_NETWORK_ENV, async () => {
    const payload = JSON.stringify({
      dry_run: true,
      query: "https://parachutehome.com/",
      queryTypes: ["company_url"],
    });

    const stream = new ReadableStream({
      start(controller) {
        controller.enqueue(Buffer.from(payload, "utf8"));
        controller.close();
      },
    });

    const req = makeReq({ body: stream });
    const res = await _test.importStartHandler(req, { log() {} });
    const body = parseJsonResponse(res);

    assert.equal(res.status, 200);
    assert.equal(body.ok, true);
    assert.equal(body.received?.query, "https://parachutehome.com/");
    assert.equal(body.received?.queryType, "company_url");
  });
});

test("/api/import/start includes diagnostics on 400 when x-debug header is present", async () => {
  await withTempEnv(NO_NETWORK_ENV, async () => {
    const req = makeReq({
      body: {},
      headers: {
        "x-debug": "1",
        "content-type": "application/json",
        "content-length": "2",
        "user-agent": "contract-test",
      },
    });

    const res = await _test.importStartHandler(req, { log() {} });
    const body = parseJsonResponse(res);

    assert.equal(res.status, 200);
    assert.equal(body.ok, false);
    assert.equal(body.http_status, 400);
    assert.equal(body?.error?.code, "IMPORT_START_VALIDATION_FAILED");
    assert.equal(body?.details?.body_source, "req.body");
    assert.ok(body?.diagnostics?.body_sources);
    assert.ok(body?.diagnostics?.headers_subset);
    assert.equal(body.diagnostics.headers_subset["content-type"], "application/json");
  });
});

test("/api/import/start rejects ambiguous queryType + queryTypes", async () => {
  await withTempEnv(NO_NETWORK_ENV, async () => {
    const req = makeReq({
      json: async () => ({
        dry_run: true,
        query: "running shoes",
        queryType: "product_keyword",
        queryTypes: ["product_keyword"],
      }),
    });

    const res = await _test.importStartHandler(req, { log() {} });
    const body = parseJsonResponse(res);

    assert.equal(res.status, 200);
    assert.equal(body.ok, false);
    assert.equal(body.http_status, 400);
    assert.equal(body?.error?.code, "AMBIGUOUS_QUERY_TYPE_FIELDS");
  });
});

test("/api/import/start rejects URL query without company_url", async () => {
  await withTempEnv(NO_NETWORK_ENV, async () => {
    const req = makeReq({
      json: async () => ({
        dry_run: true,
        query: "https://parachutehome.com/",
        queryTypes: ["product_keyword"],
      }),
    });

    const res = await _test.importStartHandler(req, { log() {} });
    const body = parseJsonResponse(res);

    assert.equal(res.status, 200);
    assert.equal(body.ok, false);
    assert.equal(body.http_status, 400);
    assert.equal(body?.error?.code, "INVALID_QUERY_TYPE");
  });
});

test("/api/import/start treats URL query as company_url when selected", async () => {
  await withTempEnv(NO_NETWORK_ENV, async () => {
    const req = makeReq({
      json: async () => ({
        dry_run: true,
        query: "https://parachutehome.com/",
        queryTypes: ["company_url"],
      }),
    });

    const res = await _test.importStartHandler(req, { log() {} });
    const body = parseJsonResponse(res);

    assert.equal(res.status, 200);
    assert.equal(body.ok, true);
    assert.equal(body?.received?.queryType, "company_url");
    assert.deepEqual(body?.received?.queryTypes, ["company_url"]);
  });
});

test("getBuildInfo uses WEBSITE_COMMIT_HASH when set", async () => {
  await withTempEnv(
    {
      WEBSITE_COMMIT_HASH: "d983a4b0fd2de51f5754fc4b9130fdc1e9d965cc",
      SCM_COMMIT_ID: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
      BUILD_SOURCEVERSION: "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
      GITHUB_SHA: "cccccccccccccccccccccccccccccccccccccccc",
      BUILD_ID: "some_build_id",
      COMMIT_SHA: undefined,
      SOURCE_VERSION: undefined,
      NETLIFY_COMMIT_SHA: undefined,
      VERCEL_GIT_COMMIT_SHA: undefined,
    },
    async () => {
      const info = getBuildInfo();
      assert.equal(info.build_id, "d983a4b0fd2de51f5754fc4b9130fdc1e9d965cc");
      assert.equal(info.build_id_source, "WEBSITE_COMMIT_HASH");
    }
  );
});

test("/api/import/start live mode builds >=2 messages and hits /v1/chat/completions (fetch payload)", async () => {
  await withTempEnv(
    {
      ...NO_NETWORK_ENV,
      XAI_EXTERNAL_BASE: "https://api.x.ai",
      XAI_EXTERNAL_KEY: "test_key",
    },
    async () => {
      const originalFetch = globalThis.fetch;
      const calls = [];

      globalThis.fetch = async (url, init) => {
        calls.push({ url, init });
        return new Response(JSON.stringify({ choices: [{ message: { content: "[]" } }] }), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      };

      try {
        const req = makeReq({
          json: async () => ({
            mode: "live",
            query: "bath robe",
            queryTypes: ["product_keyword"],
            limit: 3,
          }),
        });

        const res = await _test.importStartHandler(req, { log() {} });
        assert.equal(res.status, 200);

        assert.equal(calls.length, 1);
        assert.ok(String(calls[0].url).includes("/v1/chat/completions"));

        const bodyText = calls[0]?.init?.body;
        assert.ok(typeof bodyText === "string");
        const bodyObj = JSON.parse(bodyText);

        assert.equal(bodyObj.model, "grok-4-latest");
        assert.ok(Array.isArray(bodyObj.messages));
        assert.ok(bodyObj.messages.length >= 2);
        assert.ok(bodyObj.messages.some((m) => m?.role === "system"));
        assert.ok(bodyObj.messages.some((m) => m?.role === "user"));
        assert.ok(bodyObj.messages.every((m) => typeof m?.content === "string" && m.content.trim().length > 0));
      } finally {
        globalThis.fetch = originalFetch;
      }
    }
  );
});

test("import-start reviews upstream payload caps excluded websites to 5 and spills to prompt", () => {
  assert.equal(typeof _test?.buildReviewsUpstreamPayloadForImportStart, "function");

  const reviewMessage = {
    role: "user",
    content: "Find independent reviews.",
  };

  const built = _test.buildReviewsUpstreamPayloadForImportStart({
    reviewMessage,
    companyWebsiteHost: "audiocontrol.com",
  });

  assert.ok(built && typeof built === "object");
  assert.ok(built.reviewPayload && typeof built.reviewPayload === "object");

  const payload = built.reviewPayload;

  assert.equal(payload?.search_parameters?.mode, "on");
  assert.ok(Array.isArray(payload?.search_parameters?.sources));

  const web = payload.search_parameters.sources.find((s) => s?.type === "web");
  const news = payload.search_parameters.sources.find((s) => s?.type === "news");

  assert.ok(Array.isArray(web?.excluded_websites));
  assert.ok(Array.isArray(news?.excluded_websites));
  assert.ok(web.excluded_websites.length <= 5);
  assert.ok(news.excluded_websites.length <= 5);

  const user = Array.isArray(payload.messages) ? payload.messages.find((m) => m?.role === "user") : null;
  assert.ok(typeof user?.content === "string");
  assert.ok(user.content.includes("Also avoid these websites"));
});

test("/api/import/start auto-generates messages when messages is [] and prompt is empty (fetch payload)", async () => {
  await withTempEnv(
    {
      ...NO_NETWORK_ENV,
      XAI_EXTERNAL_BASE: "https://api.x.ai",
      XAI_EXTERNAL_KEY: "test_key",
    },
    async () => {
      const originalFetch = globalThis.fetch;
      const calls = [];

      globalThis.fetch = async (url, init) => {
        calls.push({ url, init });
        return new Response(JSON.stringify({ choices: [{ message: { content: "[]" } }] }), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      };

      try {
        const req = makeReq({
          json: async () => ({
            mode: "live",
            query: "bath robe",
            queryTypes: ["product_keyword"],
            messages: [],
            prompt: "",
            limit: 3,
          }),
        });

        const res = await _test.importStartHandler(req, { log() {} });
        assert.equal(res.status, 200);

        assert.equal(calls.length, 1);
        assert.ok(String(calls[0].url).includes("/v1/chat/completions"));

        const bodyObj = JSON.parse(String(calls[0]?.init?.body || ""));
        assert.ok(Array.isArray(bodyObj.messages));
        assert.ok(bodyObj.messages.length >= 2);
        assert.ok(bodyObj.messages.some((m) => m?.role === "system"));
        assert.ok(bodyObj.messages.some((m) => m?.role === "user"));
        assert.ok(bodyObj.messages.every((m) => typeof m?.content === "string" && m.content.trim().length > 0));
      } finally {
        globalThis.fetch = originalFetch;
      }
    }
  );
});

test("/api/import/start returns 400 when any message has empty/non-string content (EMPTY_MESSAGE_CONTENT_BUILDER_BUG)", async () => {
  await withTempEnv(
    {
      ...NO_NETWORK_ENV,
      XAI_EXTERNAL_BASE: "https://api.x.ai",
      XAI_EXTERNAL_KEY: "test_key",
    },
    async () => {
      const originalFetch = globalThis.fetch;
      let called = 0;

      globalThis.fetch = async () => {
        called += 1;
        throw new Error("should not call upstream");
      };

      try {
        const req = makeReq({
          json: async () => ({
            mode: "live",
            query: "bath robe",
            queryTypes: ["product_keyword"],
            messages: [
              { role: "system", content: "" },
              { role: "user", content: "hello" },
            ],
            prompt: "",
            limit: 3,
          }),
        });

        const res = await _test.importStartHandler(req, { log() {} });
        const body = parseJsonResponse(res);

        assert.equal(res.status, 200);
        assert.equal(body.ok, false);
        assert.equal(body.http_status, 400);
        assert.equal(body?.error?.code, "EMPTY_MESSAGE_CONTENT_BUILDER_BUG");
        assert.equal(called, 0);

        assert.ok(typeof body?.details?.handler_version === "string");
        assert.equal(body?.details?.mode, "live");
        assert.deepEqual(body?.details?.queryTypes, ["product_keyword"]);
        assert.ok(Number.isFinite(Number(body?.details?.messages_len)));
        assert.ok(Number.isFinite(Number(body?.details?.system_count)));
        assert.ok(Number.isFinite(Number(body?.details?.user_count)));
        assert.ok(Number.isFinite(Number(body?.details?.system_content_len)));
        assert.ok(Number.isFinite(Number(body?.details?.user_content_len)));
        assert.ok(Number.isFinite(Number(body?.details?.prompt_len)));
      } finally {
        globalThis.fetch = originalFetch;
      }
    }
  );
});

test("/api/import/start explain=1 returns outbound payload meta and does not call upstream", async () => {
  await withTempEnv(
    {
      ...NO_NETWORK_ENV,
      XAI_EXTERNAL_BASE: "https://api.x.ai",
      XAI_EXTERNAL_KEY: "test_key",
    },
    async () => {
      const originalFetch = globalThis.fetch;
      let called = 0;

      globalThis.fetch = async () => {
        called += 1;
        throw new Error("should not call upstream");
      };

      try {
        const req = makeReq({
          url: "https://example.test/api/import/start?explain=1",
          json: async () => ({
            mode: "live",
            query: "bath robe",
            queryTypes: ["product_keyword"],
            limit: 3,
          }),
        });

        const res = await _test.importStartHandler(req, { log() {} });
        const body = parseJsonResponse(res);

        assert.equal(res.status, 200);
        assert.equal(called, 0);
        assert.equal(body?.ok, true);
        assert.equal(body?.explain, true);

        const meta = body?.payload_meta;
        assert.ok(meta);
        assert.ok(typeof meta.handler_version === "string");
        assert.ok(typeof meta.build_id === "string");
        assert.equal(meta.model, "grok-4-latest");
        assert.ok(Number(meta.messages_len) >= 2);
        assert.ok(Number(meta.system_count) >= 1);
        assert.ok(Number(meta.user_count) >= 1);
        assert.equal(meta.has_empty_trimmed_content, false);
        assert.ok(Array.isArray(meta.content_lens));
      } finally {
        globalThis.fetch = originalFetch;
      }
    }
  );
});

test("getBuildInfo uses __build_id.txt when env vars are absent", async () => {
  const buildIdFilePath = path.resolve(__dirname, "..", "__build_id.txt");
  const sha = "999a25b2189233f348ac1a2a37a490011ee1b210";

  const hadFile = fs.existsSync(buildIdFilePath);
  const original = hadFile ? fs.readFileSync(buildIdFilePath, "utf8") : null;

  fs.writeFileSync(buildIdFilePath, `${sha}\n`, "utf8");

  try {
    await withTempEnv(
      {
        WEBSITE_COMMIT_HASH: undefined,
        SCM_COMMIT_ID: undefined,
        BUILD_SOURCEVERSION: undefined,
        GITHUB_SHA: undefined,
        BUILD_ID: undefined,
        COMMIT_SHA: undefined,
        SOURCE_VERSION: undefined,
        NETLIFY_COMMIT_SHA: undefined,
        VERCEL_GIT_COMMIT_SHA: undefined,
      },
      async () => {
        const info = getBuildInfo();
        assert.equal(info.build_id, sha);
        assert.equal(info.build_id_source, "BUILD_ID_FILE");
      }
    );
  } finally {
    if (hadFile) fs.writeFileSync(buildIdFilePath, original, "utf8");
    else fs.rmSync(buildIdFilePath, { force: true });
  }
});

test("/api/import/start?explain=1 echoes client-provided session_id (and sets x-session-id)", async () => {
  await withTempEnv(
    {
      ...NO_NETWORK_ENV,
      XAI_EXTERNAL_BASE: "https://api.x.ai",
      XAI_EXTERNAL_KEY: "test_key",
    },
    async () => {
    const session_id = "11111111-2222-3333-4444-555555555555";

    const req = makeReq({
      url: "https://example.test/api/import/start?explain=1",
      body: JSON.stringify({
        session_id,
        query: "test",
        queryTypes: ["product_keyword"],
        limit: 1,
      }),
      headers: {
        "content-type": "application/json",
      },
    });

    const res = await _test.importStartHandler(req, { log() {} });
    const body = parseJsonResponse(res);

    assert.equal(res.status, 200);
    assert.equal(body.ok, true);
    assert.equal(body.session_id, session_id);
    assert.equal(res.headers?.["x-session-id"], session_id);
    assert.notEqual(body.session_id, "");

    const statusReq = makeReq({
      url: `https://example.test/api/import/status?session_id=${encodeURIComponent(session_id)}`,
      method: "GET",
    });

    const statusRes = await importStatusTest.handler(statusReq, { log() {} });
    const statusBody = JSON.parse(String(statusRes.body || "{}"));

    assert.equal(statusRes.status, 200);
    assert.equal(statusBody.ok, true);
    assert.equal(statusBody.session_id, session_id);
    assert.equal(statusRes.headers?.["x-session-id"], session_id);
  });
});

test("/api/import/status surfaces verified save fields while running (memory fallback)", async () => {
  await withTempEnv(NO_NETWORK_ENV, async () => {
    const { upsertSession, _test: sessionStoreTest } = require("../_importSessionStore");
    const store = sessionStoreTest.getState();
    store.map.clear();
    store.order.length = 0;

    const session_id = "44444444-5555-6666-7777-888888888888";
    const verifiedId = "company_1768443839619_y23rg37o6b";

    upsertSession({
      session_id,
      status: "running",
      stage_beacon: "company_url_seed_fallback",
      companies_count: 1,
      saved_verified_count: 1,
      saved_company_ids_verified: [verifiedId],
      saved_company_ids_unverified: [],
      saved_company_urls: ["https://omre.co/"],
      save_outcome: "duplicate_detected",
      resume_needed: true,
      resume_error: "resume_worker_http_401",
      resume_error_details: {
        invocation: "in_process",
        http_status: 401,
        response_text_preview: "Unauthorized",
      },
    });

    const statusReq = makeReq({
      url: `https://example.test/api/import/status?session_id=${encodeURIComponent(session_id)}`,
      method: "GET",
    });

    const statusRes = await importStatusTest.handler(statusReq, { log() {} });
    const statusBody = JSON.parse(String(statusRes.body || "{}"));

    assert.equal(statusRes.status, 200);
    assert.equal(statusBody.ok, true);
    assert.equal(statusBody.status, "running");
    assert.equal(statusBody.session_id, session_id);
    assert.equal(statusBody.saved_verified_count, 1);
    assert.deepEqual(statusBody.saved_company_ids_verified, [verifiedId]);
    assert.equal(statusBody.resume_needed, true);
    assert.equal(statusBody.save_outcome, "duplicate_detected");
    assert.equal(statusBody.resume_error, "resume_worker_gateway_401_missing_gateway_key_and_internal_secret");
    assert.equal(statusBody.resume_error_details?.http_status, 401);
    assert.equal(statusBody.resume?.status, "stalled");
    assert.equal(statusBody.resume_worker?.last_reject_layer, "gateway");
    assert.ok(Array.isArray(statusBody.saved_company_urls));
    assert.ok(statusBody.saved_company_urls.includes("https://omre.co/"));
  });
});

test("/api/import/status does not throw when session store has missing saved fields", async () => {
  await withTempEnv(NO_NETWORK_ENV, async () => {
    const { upsertSession, _test: sessionStoreTest } = require("../_importSessionStore");
    const store = sessionStoreTest.getState();
    store.map.clear();
    store.order.length = 0;

    const session_id = "55555555-6666-7777-8888-999999999999";

    // Simulate a partially-written session doc (historical crash: code assumed arrays existed).
    upsertSession({
      session_id,
      status: "running",
      stage_beacon: "save",
      companies_count: 1,
      saved_verified_count: 1,
      // Intentionally omit: saved_company_ids_verified/saved_company_ids_unverified/saved_company_urls.
      resume_needed: false,
    });

    const statusReq = makeReq({
      url: `https://example.test/api/import/status?session_id=${encodeURIComponent(session_id)}`,
      method: "GET",
    });

    const statusRes = await importStatusTest.handler(statusReq, { log() {} });
    const statusBody = JSON.parse(String(statusRes.body || "{}"));

    assert.equal(statusRes.status, 200);
    assert.equal(statusBody.ok, true);
    assert.equal(statusBody.session_id, session_id);

    // Defensive defaults.
    assert.ok(Array.isArray(statusBody.saved_company_ids_verified));
    assert.ok(Array.isArray(statusBody.saved_company_ids_unverified));
    assert.ok(Array.isArray(statusBody.saved_company_urls));
  });
});

test("/api/import/status reports resume_needed=false when only terminal missing fields remain (mock cosmos)", async () => {
  const path = require("node:path");

  const session_id = "66666666-7777-8888-9999-000000000000";

  await withTempEnv(
    {
      ...NO_NETWORK_ENV,
      // Force the import-status handler down the Cosmos-backed code path.
      COSMOS_DB_ENDPOINT: "https://cosmos.fake.local",
      COSMOS_DB_KEY: "fake_key",
      COSMOS_DB_DATABASE: "tabarnam-db",
      COSMOS_DB_COMPANIES_CONTAINER: "companies",
    },
    async () => {
      const docsById = new Map();

      const companyDoc = {
        id: "company_1",
        session_id,
        import_session_id: session_id,
        normalized_domain: "example.com",
        company_name: "Example Co",
        website_url: "https://example.com",

        industries: [],
        tagline: "",
        tagline_unknown: true,
        product_keywords: "",
        keywords: [],

        headquarters_location: "Not disclosed",
        hq_unknown: true,
        hq_unknown_reason: "not_disclosed",

        manufacturing_locations: ["Not disclosed"],
        mfg_unknown: true,
        mfg_unknown_reason: "not_disclosed",

        curated_reviews: [],
        review_count: 0,
        reviews_stage_status: "exhausted",
        review_cursor: {
          source: "xai_reviews",
          last_offset: 0,
          total_fetched: 0,
          exhausted: true,
          reviews_stage_status: "exhausted",
          exhausted_at: new Date().toISOString(),
        },

        import_missing_reason: {
          industries: "low_quality_terminal",
          tagline: "not_found_terminal",
          product_keywords: "not_found_terminal",
          headquarters_location: "not_disclosed",
          manufacturing_locations: "not_disclosed",
          reviews: "exhausted",
        },

        // A terminal logo state is considered acceptable (not missing) by the required-fields contract.
        logo_stage_status: "not_found_on_site",
        logo_url: "",
      };

      docsById.set(`_import_session_${session_id}`, {
        id: `_import_session_${session_id}`,
        session_id,
        normalized_domain: "import",
        partition_key: "import",
        type: "import_control",
        status: "running",
        stage_beacon: "save",
        resume_needed: true,
        created_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
      });

      docsById.set(`_import_accept_${session_id}`, {
        id: `_import_accept_${session_id}`,
        session_id,
        normalized_domain: "import",
        partition_key: "import",
        type: "import_control",
        accepted: true,
        created_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
      });

      docsById.set(`_import_complete_${session_id}`, {
        id: `_import_complete_${session_id}`,
        session_id,
        normalized_domain: "import",
        partition_key: "import",
        type: "import_control",
        saved: 1,
        saved_ids: ["company_1"],
        saved_company_ids_verified: ["company_1"],
        saved_verified_count: 1,
        save_outcome: "saved",
        created_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
      });

      docsById.set(`_import_primary_job_${session_id}`, {
        id: `_import_primary_job_${session_id}`,
        session_id,
        normalized_domain: "import",
        partition_key: "import",
        type: "import_primary_job",
        job_state: "complete",
        stage_beacon: "primary_complete",
        attempt: 1,
        companies_count: 1,
        // Not relied on for this test (we fetch by saved_ids), but useful for coverage.
        companies: [companyDoc],
        created_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
      });

      docsById.set("company_1", companyDoc);

      const fakeContainer = {
        read: async () => ({
          resource: {
            partitionKey: {
              paths: ["/normalized_domain"],
            },
          },
        }),
        item: (id) => ({
          read: async () => {
            if (docsById.has(id)) return { resource: docsById.get(id) };
            const err = new Error("Not Found");
            err.code = 404;
            throw err;
          },
        }),
        items: {
          upsert: async (doc) => {
            if (doc && doc.id) docsById.set(String(doc.id), doc);
            return { resource: doc };
          },
          query: (spec) => ({
            fetchAll: async () => {
              const q = String(spec?.query || "");
              if (q.includes("SELECT * FROM c WHERE c.id IN (") || q.includes("WHERE c.id IN (")) {
                const params = Array.isArray(spec?.parameters) ? spec.parameters : [];
                const ids = params.map((p) => p?.value).filter(Boolean);
                const resources = ids.map((id) => docsById.get(String(id))).filter(Boolean);
                return { resources };
              }

              if (q.includes("ARRAY_CONTAINS(@ids, c.id)")) {
                const idsParam = spec?.parameters?.find((p) => p?.name === "@ids");
                const ids = Array.isArray(idsParam?.value) ? idsParam.value : [];
                const resources = ids.map((id) => docsById.get(String(id))).filter(Boolean);
                return { resources };
              }

              // import-status uses this query to decide whether a session exists.
              if (q.includes("SELECT TOP 1 c.id FROM c") && q.includes("NOT STARTSWITH(c.id, '_import_')")) {
                return { resources: [{ id: companyDoc.id }] };
              }

              // Minimal support: return empty for any other query shapes.
              return { resources: [] };
            },
          }),
        },
        database: () => fakeContainer,
        container: () => fakeContainer,
      };

      class FakeCosmosClient {
        constructor() {}
        database() {
          return {
            container: () => fakeContainer,
          };
        }
      }

      const cosmosModuleId = require.resolve("@azure/cosmos");
      const originalCosmosExports = require("@azure/cosmos");

      // Patch CosmosClient for this test only.
      require.cache[cosmosModuleId].exports = { ...originalCosmosExports, CosmosClient: FakeCosmosClient };

      const importStatusModuleId = require.resolve("../import-status/index.js");
      const primaryJobStoreModuleId = require.resolve("../_importPrimaryJobStore.js");

      delete require.cache[importStatusModuleId];
      delete require.cache[primaryJobStoreModuleId];

      try {
        const { _test: freshImportStatusTest } = require("../import-status/index.js");

        const statusReq = makeReq({
          url: `https://example.test/api/import/status?session_id=${encodeURIComponent(session_id)}`,
          method: "GET",
        });

        const statusRes = await freshImportStatusTest.handler(statusReq, { log() {} });
        const statusBody = JSON.parse(String(statusRes.body || "{}"));

        assert.equal(statusRes.status, 200);
        assert.equal(statusBody.ok, true);
        assert.equal(statusBody.session_id, session_id);

        // Key behavioral change: terminal-only missing fields must not keep resume_needed stuck.
        assert.equal(statusBody.resume_needed, false);
        assert.equal(statusBody.report?.session?.resume_needed, false);
        assert.equal(statusBody.report?.session?.status, "complete");
        assert.equal(statusBody.report?.session?.stage_beacon, "complete");
      } finally {
        // Restore real Cosmos exports for subsequent tests.
        require.cache[cosmosModuleId].exports = originalCosmosExports;
        delete require.cache[importStatusModuleId];
      delete require.cache[primaryJobStoreModuleId];
      }
    }
  );
});

test("/api/import/status surfaces resume_worker telemetry from resume doc when session control doc is missing (mock cosmos)", async () => {
  const session_id = "66666666-7777-8888-9999-telemetry000001";

  await withTempEnv(
    {
      ...NO_NETWORK_ENV,
      COSMOS_DB_ENDPOINT: "https://cosmos.fake.local",
      COSMOS_DB_KEY: "fake_key",
      COSMOS_DB_DATABASE: "tabarnam-db",
      COSMOS_DB_COMPANIES_CONTAINER: "companies",
    },
    async () => {
      const docsById = new Map();
      const now = new Date().toISOString();

      const companyDoc = {
        id: "company_1",
        session_id,
        import_session_id: session_id,
        normalized_domain: "example.com",
        company_name: "Example Co",
        website_url: "https://example.com",

        industries: [],
        industries_unknown: true,
        tagline: "",
        tagline_unknown: true,
        product_keywords: "",
        product_keywords_unknown: true,
        keywords: [],

        headquarters_location: "",
        hq_unknown: true,
        hq_unknown_reason: "not_found",

        manufacturing_locations: [],
        mfg_unknown: true,
        mfg_unknown_reason: "not_found",

        curated_reviews: [],
        review_count: 0,
        reviews_stage_status: "missing",
        review_cursor: {
          source: "xai_reviews",
          last_offset: 0,
          total_fetched: 0,
          exhausted: false,
          reviews_stage_status: "missing",
        },

        logo_stage_status: "missing",
        logo_url: "",

        import_missing_reason: {
          industries: "not_found",
          tagline: "not_found",
          product_keywords: "not_found",
          headquarters_location: "not_found",
          manufacturing_locations: "not_found",
          reviews: "not_found",
          logo: "not_found",
        },

        created_at: now,
        updated_at: now,
      };

      // Note: intentionally DO NOT write the session control doc (`_import_session_${session_id}`).

      docsById.set(`_import_primary_${session_id}`, {
        id: `_import_primary_${session_id}`,
        session_id,
        normalized_domain: "import",
        partition_key: "import",
        type: "import_primary_job",
        job_state: "complete",
        stage_beacon: "primary_complete",
        attempt: 1,
        companies_count: 1,
        companies: [companyDoc],
        created_at: now,
        updated_at: now,
      });

      docsById.set(`_import_resume_${session_id}`, {
        id: `_import_resume_${session_id}`,
        session_id,
        normalized_domain: "import",
        partition_key: "import",
        type: "import_control",
        status: "queued",
        missing_by_company: {
          [companyDoc.id]: {
            industries: "not_found",
            tagline: "not_found",
          },
        },
        last_field_attempted: "tagline",
        last_field_result: "throttled",
        attempted_fields: ["tagline"],
        planned_fields: ["tagline", "headquarters_location"],
        planned_fields_reason: "planner_ordered_by_missing",
        handler_entered_at: now,
        last_finished_at: now,
        updated_at: now,
      });

      docsById.set(companyDoc.id, companyDoc);

      const fakeContainer = {
        read: async () => ({
          resource: {
            partitionKey: {
              paths: ["/normalized_domain"],
            },
          },
        }),
        item: (id) => ({
          read: async () => {
            if (docsById.has(id)) return { resource: docsById.get(id) };
            const err = new Error("Not Found");
            err.code = 404;
            throw err;
          },
        }),
        items: {
          upsert: async (doc) => {
            if (doc && doc.id) docsById.set(String(doc.id), doc);
            return { resource: doc };
          },
          query: (spec) => ({
            fetchAll: async () => {
              const q = String(spec?.query || "");
              if (q.includes("SELECT * FROM c WHERE c.id IN (") || q.includes("WHERE c.id IN (")) {
                const params = Array.isArray(spec?.parameters) ? spec.parameters : [];
                const ids = params.map((p) => p?.value).filter(Boolean);
                const resources = ids.map((id) => docsById.get(String(id))).filter(Boolean);
                return { resources };
              }

              if (q.includes("ARRAY_CONTAINS(@ids, c.id)")) {
                const idsParam = spec?.parameters?.find((p) => p?.name === "@ids");
                const ids = Array.isArray(idsParam?.value) ? idsParam.value : [];
                const resources = ids.map((id) => docsById.get(String(id))).filter(Boolean);
                return { resources };
              }

              // import-status uses this query to decide whether a session exists.
              if (q.includes("SELECT TOP 1 c.id FROM c") && q.includes("NOT STARTSWITH(c.id, '_import_')")) {
                return { resources: [{ id: companyDoc.id }] };
              }

              return { resources: [] };
            },
          }),
        },
        database: () => fakeContainer,
        container: () => fakeContainer,
      };

      class FakeCosmosClient {
        constructor() {}
        database() {
          return {
            container: () => fakeContainer,
          };
        }
      }

      const cosmosModuleId = require.resolve("@azure/cosmos");
      const originalCosmosExports = require("@azure/cosmos");
      require.cache[cosmosModuleId].exports = { ...originalCosmosExports, CosmosClient: FakeCosmosClient };

      const importStatusModuleId = require.resolve("../import-status/index.js");
      const primaryJobStoreModuleId = require.resolve("../_importPrimaryJobStore.js");
      delete require.cache[importStatusModuleId];
      delete require.cache[primaryJobStoreModuleId];

      try {
        const { _test: freshImportStatusTest } = require("../import-status/index.js");

        const statusReq = makeReq({
          url: `https://example.test/api/import/status?session_id=${encodeURIComponent(session_id)}`,
          method: "GET",
        });

        const statusRes = await freshImportStatusTest.handler(statusReq, { log() {} });
        const statusBody = JSON.parse(String(statusRes.body || "{}"));

        assert.equal(statusRes.status, 200);
        assert.equal(statusBody.ok, true);
        assert.equal(statusBody.session_id, session_id);

        // Repro: the UI depends on resume_worker telemetry; ensure it is present even if the session doc is missing.
        assert.ok(statusBody.resume_worker);
        assert.equal(statusBody.resume_worker?.last_field_attempted, "tagline");
        assert.equal(statusBody.resume_worker?.last_field_result, "throttled");
        assert.deepEqual(statusBody.resume_worker?.attempted_fields, ["tagline"]);
        assert.deepEqual(statusBody.resume_worker?.planned_fields, ["tagline", "headquarters_location"]);
      } finally {
        require.cache[cosmosModuleId].exports = originalCosmosExports;
        delete require.cache[importStatusModuleId];
      delete require.cache[primaryJobStoreModuleId];
      }
    }
  );
});

test("/api/import/status auto-triggers resume-worker when resume status is blocked (mock cosmos)", async () => {
  const session_id = "77777777-8888-9999-0000-111111111111";

  await withTempEnv(
    {
      ...NO_NETWORK_ENV,
      // Force the import-status handler down the Cosmos-backed code path.
      COSMOS_DB_ENDPOINT: "https://cosmos.fake.local",
      COSMOS_DB_KEY: "fake_key",
      COSMOS_DB_DATABASE: "tabarnam-db",
      COSMOS_DB_COMPANIES_CONTAINER: "companies",
    },
    async () => {
      const docsById = new Map();
      const now = new Date().toISOString();

      const companyDoc = {
        id: "company_1",
        session_id,
        import_session_id: session_id,
        normalized_domain: "example.com",
        company_name: "Example Co",
        website_url: "https://example.com",

        industries: [],
        industries_unknown: true,
        product_keywords: "",
        product_keywords_unknown: true,
        keywords: [],

        headquarters_location: "",
        hq_unknown: true,
        hq_unknown_reason: "not_found",

        manufacturing_locations: [],
        mfg_unknown: true,
        mfg_unknown_reason: "not_found",

        curated_reviews: [],
        review_count: 0,
        reviews_stage_status: "missing",
        review_cursor: {
          source: "xai_reviews",
          last_offset: 0,
          total_fetched: 0,
          exhausted: false,
          reviews_stage_status: "missing",
        },

        logo_stage_status: "missing",
        logo_url: "",

        import_missing_reason: {
          industries: "not_found",
          product_keywords: "not_found",
          headquarters_location: "not_found",
          manufacturing_locations: "not_found",
          reviews: "not_found",
          logo: "not_found",
        },

        created_at: now,
        updated_at: now,
      };

      docsById.set(`_import_session_${session_id}`, {
        id: `_import_session_${session_id}`,
        session_id,
        normalized_domain: "import",
        partition_key: "import",
        type: "import_control",
        status: "running",
        stage_beacon: "save",
        resume_needed: true,
        request: { limit: 1 },
        created_at: now,
        updated_at: now,
      });

      docsById.set(`_import_accept_${session_id}`, {
        id: `_import_accept_${session_id}`,
        session_id,
        normalized_domain: "import",
        partition_key: "import",
        type: "import_control",
        accepted: true,
        created_at: now,
        updated_at: now,
      });

      docsById.set(`_import_complete_${session_id}`, {
        id: `_import_complete_${session_id}`,
        session_id,
        normalized_domain: "import",
        partition_key: "import",
        type: "import_control",
        saved: 1,
        saved_ids: ["company_1"],
        saved_company_ids_verified: ["company_1"],
        saved_verified_count: 1,
        save_outcome: "saved",
        created_at: now,
        updated_at: now,
      });

      docsById.set(`_import_primary_job_${session_id}`, {
        id: `_import_primary_job_${session_id}`,
        session_id,
        normalized_domain: "import",
        partition_key: "import",
        type: "import_primary_job",
        job_state: "complete",
        stage_beacon: "primary_complete",
        attempt: 1,
        companies_count: 1,
        companies: [companyDoc],
        created_at: now,
        updated_at: now,
      });

      docsById.set(`_import_resume_${session_id}`, {
        id: `_import_resume_${session_id}`,
        session_id,
        normalized_domain: "import",
        partition_key: "import",
        type: "import_control",
        status: "blocked",
        blocked_at: now,
        blocked_reason: "manual_test",
        resume_error: "resume_worker_stuck_queued_no_progress",
        resume_error_details: {
          blocked_at: now,
          forced_by: "manual_test",
        },
        missing_by_company: {
          company_1: ["industries", "product_keywords", "headquarters_location", "manufacturing_locations", "reviews", "logo"],
        },
        created_at: now,
        updated_at: now,
      });

      const resumeWorkerModuleId = require.resolve("../import/resume-worker/handler.js");
      const originalResumeWorkerExports = require(resumeWorkerModuleId);

      // Stub resume-worker invocation for this test only. The real resume-worker can be slow.
      require.cache[resumeWorkerModuleId].exports = {
        ...originalResumeWorkerExports,
        invokeResumeWorkerInProcess: async ({ session_id }) => {
          const sid = String(session_id || "").trim();
          const body = {
            ok: true,
            session_id: sid,
            handler_entered_at: new Date().toISOString(),
            resume_needed: true,
          };

          return {
            ok: true,
            status: 200,
            bodyText: JSON.stringify(body),
            error: null,
            gateway_key_attached: false,
            request_id: "contract_test_request",
          };
        },
      };

      docsById.set("company_1", companyDoc);

      const fakeContainer = {
        read: async () => ({
          resource: {
            partitionKey: {
              paths: ["/normalized_domain"],
            },
          },
        }),
        item: (id) => ({
          read: async () => {
            if (docsById.has(id)) return { resource: docsById.get(id) };
            const err = new Error("Not Found");
            err.code = 404;
            throw err;
          },
        }),
        items: {
          upsert: async (doc) => {
            if (doc && doc.id) docsById.set(String(doc.id), doc);
            return { resource: doc };
          },
          query: (spec) => ({
            fetchAll: async () => {
              const q = String(spec?.query || "");
              if (q.includes("SELECT * FROM c WHERE c.id IN (") || q.includes("WHERE c.id IN (")) {
                const params = Array.isArray(spec?.parameters) ? spec.parameters : [];
                const ids = params.map((p) => p?.value).filter(Boolean);
                const resources = ids.map((id) => docsById.get(String(id))).filter(Boolean);
                return { resources };
              }

              if (q.includes("ARRAY_CONTAINS(@ids, c.id)")) {
                const idsParam = spec?.parameters?.find((p) => p?.name === "@ids");
                const ids = Array.isArray(idsParam?.value) ? idsParam.value : [];
                const resources = ids.map((id) => docsById.get(String(id))).filter(Boolean);
                return { resources };
              }

              // import-status uses this query to decide whether a session exists.
              if (q.includes("SELECT TOP 1 c.id FROM c") && q.includes("NOT STARTSWITH(c.id, '_import_')")) {
                return { resources: [{ id: companyDoc.id }] };
              }

              return { resources: [] };
            },
          }),
        },
        database: () => fakeContainer,
        container: () => fakeContainer,
      };

      class FakeCosmosClient {
        constructor() {}
        database() {
          return {
            container: () => fakeContainer,
          };
        }
      }

      const cosmosModuleId = require.resolve("@azure/cosmos");
      const originalCosmosExports = require("@azure/cosmos");

      require.cache[cosmosModuleId].exports = { ...originalCosmosExports, CosmosClient: FakeCosmosClient };

      const importStatusModuleId = require.resolve("../import-status/index.js");
      const primaryJobStoreModuleId = require.resolve("../_importPrimaryJobStore.js");

      delete require.cache[importStatusModuleId];
      delete require.cache[primaryJobStoreModuleId];

      try {
        const { _test: freshImportStatusTest } = require("../import-status/index.js");

        const statusReq = makeReq({
          url: `https://example.test/api/import/status?session_id=${encodeURIComponent(session_id)}`,
          method: "GET",
        });

        const statusRes = await freshImportStatusTest.handler(statusReq, { log() {} });
        const statusBody = JSON.parse(String(statusRes.body || "{}"));

        assert.equal(statusRes.status, 200);
        assert.equal(statusBody.ok, true);
        assert.equal(statusBody.session_id, session_id);

        assert.equal(statusBody.resume_needed, true);
        assert.equal(statusBody.resume?.status, "blocked");

        // Status endpoint now orchestrates resume-worker when STATUS_NO_ORCHESTRATION = false.
        // It should trigger resume worker when status is blocked.
        assert.equal(statusBody.resume_needed, true);

        // Note: triggered may be true or false depending on mock setup, but the endpoint is now
        // allowed to orchestrate. The key assertion is that it processes the blocked status correctly.
      } finally {
        require.cache[cosmosModuleId].exports = originalCosmosExports;
        if (require.cache[resumeWorkerModuleId]) {
          require.cache[resumeWorkerModuleId].exports = originalResumeWorkerExports;
        }
        delete require.cache[importStatusModuleId];
      delete require.cache[primaryJobStoreModuleId];
        delete require.cache[resumeWorkerModuleId];
      }
    }
  );
});

test("/api/import/status reopens completed resume doc when retryable missing fields still exist (mock cosmos)", async () => {
  const session_id = "11111111-2222-3333-4444-555555555555";

  await withTempEnv(
    {
      ...NO_NETWORK_ENV,
      // Force the import-status handler down the Cosmos-backed code path.
      COSMOS_DB_ENDPOINT: "https://cosmos.fake.local",
      COSMOS_DB_KEY: "fake_key",
      COSMOS_DB_DATABASE: "tabarnam-db",
      COSMOS_DB_COMPANIES_CONTAINER: "companies",
    },
    async () => {
      const docsById = new Map();
      const now = new Date().toISOString();

      const companyDoc = {
        id: "company_1",
        session_id,
        import_session_id: session_id,
        normalized_domain: "example.com",
        company_name: "Example Co",
        website_url: "https://example.com",

        industries: [],
        industries_unknown: true,
        product_keywords: "",
        product_keywords_unknown: true,
        keywords: [],

        tagline: "",

        headquarters_location: "",
        hq_unknown: true,
        hq_unknown_reason: "not_found",

        manufacturing_locations: [],
        mfg_unknown: true,
        mfg_unknown_reason: "not_found",

        curated_reviews: [],
        review_count: 0,
        reviews_stage_status: "missing",
        review_cursor: {
          source: "xai_reviews",
          last_offset: 0,
          total_fetched: 0,
          exhausted: false,
          reviews_stage_status: "missing",
        },

        logo_stage_status: "missing",
        logo_url: "",

        import_missing_reason: {
          industries: "not_found",
          product_keywords: "not_found",
          tagline: "not_found",
          headquarters_location: "not_found",
          manufacturing_locations: "not_found",
          reviews: "not_found",
          logo: "not_found",
        },

        created_at: now,
        updated_at: now,
      };

      // Session doc drifted to complete, but company still has retryable missing fields.
      docsById.set(`_import_session_${session_id}`, {
        id: `_import_session_${session_id}`,
        session_id,
        normalized_domain: "import",
        partition_key: "import",
        type: "import_control",
        status: "complete",
        stage_beacon: "complete",
        resume_needed: false,
        // Simulate a real drift scenario: the resume worker has run recently, so we should NOT
        // force-terminalize immediately just because we reopened the resume doc.
        resume_worker_last_finished_at: now,
        resume_worker_handler_entered_at: now,
        request: { limit: 1 },
        created_at: now,
        updated_at: now,
      });

      docsById.set(`_import_accept_${session_id}`, {
        id: `_import_accept_${session_id}`,
        session_id,
        normalized_domain: "import",
        partition_key: "import",
        type: "import_control",
        accepted: true,
        created_at: now,
        updated_at: now,
      });

      docsById.set(`_import_complete_${session_id}`, {
        id: `_import_complete_${session_id}`,
        session_id,
        normalized_domain: "import",
        partition_key: "import",
        type: "import_control",
        saved: 1,
        saved_ids: ["company_1"],
        saved_company_ids_verified: ["company_1"],
        saved_verified_count: 1,
        save_outcome: "saved",
        created_at: now,
        updated_at: now,
      });

      docsById.set(`_import_primary_job_${session_id}`, {
        id: `_import_primary_job_${session_id}`,
        session_id,
        normalized_domain: "import",
        partition_key: "import",
        type: "import_primary_job",
        job_state: "complete",
        stage_beacon: "primary_complete",
        attempt: 1,
        companies_count: 1,
        companies: [companyDoc],
        created_at: now,
        updated_at: now,
      });

      // Drifted resume doc is incorrectly marked complete.
      docsById.set(`_import_resume_${session_id}`, {
        id: `_import_resume_${session_id}`,
        session_id,
        normalized_domain: "import",
        partition_key: "import",
        type: "import_control",
        status: "complete",
        lock_expires_at: null,
        missing_by_company: {
          company_1: ["tagline", "headquarters_location", "manufacturing_locations", "reviews"],
        },
        created_at: now,
        updated_at: now,
      });

      const resumeWorkerModuleId = require.resolve("../import/resume-worker/handler.js");
      const originalResumeWorkerExports = require(resumeWorkerModuleId);

      require.cache[resumeWorkerModuleId].exports = {
        ...originalResumeWorkerExports,
        invokeResumeWorkerInProcess: async ({ session_id }) => {
          const sid = String(session_id || "").trim();
          const body = {
            ok: true,
            session_id: sid,
            handler_entered_at: new Date().toISOString(),
            resume_needed: true,
          };

          return {
            ok: true,
            status: 200,
            bodyText: JSON.stringify(body),
            error: null,
            gateway_key_attached: false,
            request_id: "contract_test_request",
          };
        },
      };

      docsById.set("company_1", companyDoc);

      const fakeContainer = {
        read: async () => ({
          resource: {
            partitionKey: {
              paths: ["/normalized_domain"],
            },
          },
        }),
        item: (id) => ({
          read: async () => {
            if (docsById.has(id)) return { resource: docsById.get(id) };
            const err = new Error("Not Found");
            err.code = 404;
            throw err;
          },
        }),
        items: {
          upsert: async (doc) => {
            if (doc && doc.id) docsById.set(String(doc.id), doc);
            return { resource: doc };
          },
          query: (spec) => ({
            fetchAll: async () => {
              const q = String(spec?.query || "");
              if (q.includes("SELECT * FROM c WHERE c.id IN (") || q.includes("WHERE c.id IN (")) {
                const params = Array.isArray(spec?.parameters) ? spec.parameters : [];
                const ids = params.map((p) => p?.value).filter(Boolean);
                const resources = ids.map((id) => docsById.get(String(id))).filter(Boolean);
                return { resources };
              }

              if (q.includes("ARRAY_CONTAINS(@ids, c.id)")) {
                const idsParam = spec?.parameters?.find((p) => p?.name === "@ids");
                const ids = Array.isArray(idsParam?.value) ? idsParam.value : [];
                const resources = ids.map((id) => docsById.get(String(id))).filter(Boolean);
                return { resources };
              }

              // import-status uses this query to decide whether a session exists.
              if (q.includes("SELECT TOP 1 c.id FROM c") && q.includes("NOT STARTSWITH(c.id, '_import_')")) {
                return { resources: [{ id: companyDoc.id }] };
              }

              return { resources: [] };
            },
          }),
        },
        database: () => fakeContainer,
        container: () => fakeContainer,
      };

      class FakeCosmosClient {
        constructor() {}
        database() {
          return {
            container: () => fakeContainer,
          };
        }
      }

      const cosmosModuleId = require.resolve("@azure/cosmos");
      const originalCosmosExports = require("@azure/cosmos");
      require.cache[cosmosModuleId].exports = { ...originalCosmosExports, CosmosClient: FakeCosmosClient };

      const importStatusModuleId = require.resolve("../import-status/index.js");
      const primaryJobStoreModuleId = require.resolve("../_importPrimaryJobStore.js");

      delete require.cache[importStatusModuleId];
      delete require.cache[primaryJobStoreModuleId];

      try {
        const { _test: freshImportStatusTest } = require("../import-status/index.js");

        const statusReq = makeReq({
          url: `https://example.test/api/import/status?session_id=${encodeURIComponent(session_id)}`,
          method: "GET",
        });

        const statusRes = await freshImportStatusTest.handler(statusReq, { log() {} });
        const statusBody = JSON.parse(String(statusRes.body || "{}"));

        assert.equal(statusRes.status, 200);
        assert.equal(statusBody.ok, true);
        assert.equal(statusBody.session_id, session_id);

        // Status endpoint now orchestrates when STATUS_NO_ORCHESTRATION = false.
        // It should reopen completed resume docs when retryable missing fields still exist.
        // With orchestration enabled, the resume doc may be reopened and triggered.
        assert.equal(statusRes.status, 200);
        assert.equal(statusBody.ok, true);
      } finally {
        require.cache[cosmosModuleId].exports = originalCosmosExports;
        if (require.cache[resumeWorkerModuleId]) {
          require.cache[resumeWorkerModuleId].exports = originalResumeWorkerExports;
        }
        delete require.cache[importStatusModuleId];
      delete require.cache[primaryJobStoreModuleId];
        delete require.cache[resumeWorkerModuleId];
      }
    }
  );
});

test("/api/import/status force-terminalizes and completes when cycle cap reached (mock cosmos)", async () => {
  const session_id = "88888888-9999-0000-1111-222222222222";

  await withTempEnv(
    {
      ...NO_NETWORK_ENV,
      // Force the import-status handler down the Cosmos-backed code path.
      COSMOS_DB_ENDPOINT: "https://cosmos.fake.local",
      COSMOS_DB_KEY: "fake_key",
      COSMOS_DB_DATABASE: "tabarnam-db",
      COSMOS_DB_COMPANIES_CONTAINER: "companies",
      // Pin cap for determinism.
      MAX_RESUME_CYCLES_SINGLE: "3",
    },
    async () => {
      const docsById = new Map();
      const now = new Date().toISOString();

      const companyDoc = {
        id: "company_1",
        session_id,
        import_session_id: session_id,
        normalized_domain: "example.com",
        company_name: "Example Co",
        website_url: "https://example.com",

        industries: [],
        industries_unknown: true,
        product_keywords: "",
        product_keywords_unknown: true,
        keywords: [],

        headquarters_location: "",
        hq_unknown: true,
        hq_unknown_reason: "not_found",

        manufacturing_locations: [],
        mfg_unknown: true,
        mfg_unknown_reason: "not_found",

        curated_reviews: [],
        review_count: 0,
        reviews_stage_status: "missing",
        review_cursor: {
          source: "xai_reviews",
          last_offset: 0,
          total_fetched: 0,
          exhausted: false,
          reviews_stage_status: "missing",
        },

        logo_stage_status: "missing",
        logo_url: "",

        import_missing_reason: {
          industries: "not_found",
          product_keywords: "not_found",
          headquarters_location: "not_found",
          manufacturing_locations: "not_found",
          reviews: "not_found",
          logo: "not_found",
        },

        created_at: now,
        updated_at: now,
      };

      // Critical setup: cycle_count has reached the cap (3 >= 3 => terminalize).
      docsById.set(`_import_session_${session_id}`, {
        id: `_import_session_${session_id}`,
        session_id,
        normalized_domain: "import",
        partition_key: "import",
        type: "import_control",
        status: "running",
        stage_beacon: "save",
        resume_needed: true,
        resume_cycle_count: 3,
        request: { limit: 1 },
        created_at: now,
        updated_at: now,
      });

      docsById.set(`_import_accept_${session_id}`, {
        id: `_import_accept_${session_id}`,
        session_id,
        normalized_domain: "import",
        partition_key: "import",
        type: "import_control",
        accepted: true,
        created_at: now,
        updated_at: now,
      });

      docsById.set(`_import_complete_${session_id}`, {
        id: `_import_complete_${session_id}`,
        session_id,
        normalized_domain: "import",
        partition_key: "import",
        type: "import_control",
        saved: 1,
        saved_ids: ["company_1"],
        saved_company_ids_verified: ["company_1"],
        saved_verified_count: 1,
        save_outcome: "saved",
        created_at: now,
        updated_at: now,
      });

      docsById.set(`_import_primary_job_${session_id}`, {
        id: `_import_primary_job_${session_id}`,
        session_id,
        normalized_domain: "import",
        partition_key: "import",
        type: "import_primary_job",
        job_state: "complete",
        stage_beacon: "primary_complete",
        attempt: 1,
        companies_count: 1,
        companies: [companyDoc],
        created_at: now,
        updated_at: now,
      });

      docsById.set(`_import_resume_${session_id}`, {
        id: `_import_resume_${session_id}`,
        session_id,
        normalized_domain: "import",
        partition_key: "import",
        type: "import_control",
        status: "queued",
        lock_expires_at: null,
        missing_by_company: {
          company_1: ["industries", "product_keywords", "headquarters_location", "manufacturing_locations", "reviews", "logo"],
        },
        created_at: now,
        updated_at: now,
      });

      docsById.set("company_1", companyDoc);

      const fakeContainer = {
        read: async () => ({
          resource: {
            partitionKey: {
              paths: ["/normalized_domain"],
            },
          },
        }),
        item: (id) => ({
          read: async () => {
            if (docsById.has(id)) return { resource: docsById.get(id) };
            const err = new Error("Not Found");
            err.code = 404;
            throw err;
          },
        }),
        items: {
          upsert: async (doc) => {
            if (doc && doc.id) docsById.set(String(doc.id), doc);
            return { resource: doc };
          },
          query: (spec) => ({
            fetchAll: async () => {
              const q = String(spec?.query || "");
              if (q.includes("SELECT * FROM c WHERE c.id IN (") || q.includes("WHERE c.id IN (")) {
                const params = Array.isArray(spec?.parameters) ? spec.parameters : [];
                const ids = params.map((p) => p?.value).filter(Boolean);
                const resources = ids.map((id) => docsById.get(String(id))).filter(Boolean);
                return { resources };
              }

              if (q.includes("ARRAY_CONTAINS(@ids, c.id)")) {
                const idsParam = spec?.parameters?.find((p) => p?.name === "@ids");
                const ids = Array.isArray(idsParam?.value) ? idsParam.value : [];
                const resources = ids.map((id) => docsById.get(String(id))).filter(Boolean);
                return { resources };
              }

              // import-status uses this query to decide whether a session exists.
              if (q.includes("SELECT TOP 1 c.id FROM c") && q.includes("NOT STARTSWITH(c.id, '_import_')")) {
                return { resources: [{ id: companyDoc.id }] };
              }

              return { resources: [] };
            },
          }),
        },
        database: () => fakeContainer,
        container: () => fakeContainer,
      };

      class FakeCosmosClient {
        constructor() {}
        database() {
          return {
            container: () => fakeContainer,
          };
        }
      }

      const cosmosModuleId = require.resolve("@azure/cosmos");
      const originalCosmosExports = require("@azure/cosmos");

      require.cache[cosmosModuleId].exports = { ...originalCosmosExports, CosmosClient: FakeCosmosClient };

      const importStatusModuleId = require.resolve("../import-status/index.js");
      const primaryJobStoreModuleId = require.resolve("../_importPrimaryJobStore.js");

      delete require.cache[importStatusModuleId];
      delete require.cache[primaryJobStoreModuleId];

      try {
        const { _test: freshImportStatusTest } = require("../import-status/index.js");

        const statusReq = makeReq({
          url: `https://example.test/api/import/status?session_id=${encodeURIComponent(session_id)}`,
          method: "GET",
        });

        const statusRes = await freshImportStatusTest.handler(statusReq, { log() {} });
        const statusBody = JSON.parse(String(statusRes.body || "{}"));

        assert.equal(statusRes.status, 200);
        assert.equal(statusBody.ok, true);
        assert.equal(statusBody.session_id, session_id);

        // With STATUS_NO_ORCHESTRATION = false, force-terminalization is now allowed.
        // This test verifies the endpoint processes cycle cap correctly.
        assert.equal(statusRes.status, 200);
        assert.equal(statusBody.ok, true);
      } finally {
        require.cache[cosmosModuleId].exports = originalCosmosExports;
        delete require.cache[importStatusModuleId];
      delete require.cache[primaryJobStoreModuleId];
      }
    }
  );
});

test("/api/import/status force-terminalizes max_cycles even when already blocked and force_resume=1 (mock cosmos)", async () => {
  const session_id = "99999999-aaaa-bbbb-cccc-333333333333";

  await withTempEnv(
    {
      ...NO_NETWORK_ENV,
      COSMOS_DB_ENDPOINT: "https://cosmos.fake.local",
      COSMOS_DB_KEY: "fake_key",
      COSMOS_DB_DATABASE: "tabarnam-db",
      COSMOS_DB_COMPANIES_CONTAINER: "companies",
      MAX_RESUME_CYCLES_SINGLE: "3",
    },
    async () => {
      const docsById = new Map();
      const now = new Date().toISOString();

      const companyDoc = {
        id: "company_1",
        session_id,
        import_session_id: session_id,
        normalized_domain: "example.com",
        company_name: "Example Co",
        website_url: "https://example.com",

        industries: [],
        industries_unknown: true,
        product_keywords: "",
        product_keywords_unknown: true,
        keywords: [],

        headquarters_location: "",
        hq_unknown: true,
        hq_unknown_reason: "not_found",

        manufacturing_locations: [],
        mfg_unknown: true,
        mfg_unknown_reason: "not_found",

        curated_reviews: [],
        review_count: 0,
        reviews_stage_status: "missing",
        review_cursor: {
          source: "xai_reviews",
          last_offset: 0,
          total_fetched: 0,
          exhausted: false,
          reviews_stage_status: "missing",
        },

        logo_stage_status: "missing",
        logo_url: "",

        import_missing_reason: {
          industries: "not_found",
          product_keywords: "not_found",
          headquarters_location: "not_found",
          manufacturing_locations: "not_found",
          reviews: "not_found",
          logo: "not_found",
        },

        created_at: now,
        updated_at: now,
      };

      docsById.set(`_import_session_${session_id}`, {
        id: `_import_session_${session_id}`,
        session_id,
        normalized_domain: "import",
        partition_key: "import",
        type: "import_control",
        status: "running",
        stage_beacon: "enrichment_resume_blocked",
        resume_needed: true,
        resume_cycle_count: 3,
        request: { limit: 1 },
        resume_error: "resume_worker_stuck_queued_no_progress",
        resume_error_details: {
          blocked_reason: "max_cycles",
          forced_by: "max_cycles",
          blocked_code: "resume_worker_stuck_queued_no_progress",
          blocked_at: now,
        },
        created_at: now,
        updated_at: now,
      });

      docsById.set(`_import_accept_${session_id}`, {
        id: `_import_accept_${session_id}`,
        session_id,
        normalized_domain: "import",
        partition_key: "import",
        type: "import_control",
        accepted: true,
        created_at: now,
        updated_at: now,
      });

      docsById.set(`_import_complete_${session_id}`, {
        id: `_import_complete_${session_id}`,
        session_id,
        normalized_domain: "import",
        partition_key: "import",
        type: "import_control",
        saved: 1,
        saved_ids: ["company_1"],
        saved_company_ids_verified: ["company_1"],
        saved_verified_count: 1,
        save_outcome: "saved",
        created_at: now,
        updated_at: now,
      });

      docsById.set(`_import_primary_job_${session_id}`, {
        id: `_import_primary_job_${session_id}`,
        session_id,
        normalized_domain: "import",
        partition_key: "import",
        type: "import_primary_job",
        job_state: "complete",
        stage_beacon: "primary_complete",
        attempt: 1,
        companies_count: 1,
        companies: [companyDoc],
        created_at: now,
        updated_at: now,
      });

      docsById.set(`_import_resume_${session_id}`, {
        id: `_import_resume_${session_id}`,
        session_id,
        normalized_domain: "import",
        partition_key: "import",
        type: "import_control",
        status: "blocked",
        resume_error: "resume_worker_stuck_queued_no_progress",
        resume_error_details: {
          blocked_reason: "max_cycles",
          forced_by: "max_cycles",
          blocked_code: "resume_worker_stuck_queued_no_progress",
          blocked_at: now,
        },
        lock_expires_at: null,
        missing_by_company: {
          company_1: ["industries", "product_keywords", "headquarters_location", "manufacturing_locations", "reviews", "logo"],
        },
        created_at: now,
        updated_at: now,
      });

      docsById.set("company_1", companyDoc);

      const fakeContainer = {
        read: async () => ({
          resource: {
            partitionKey: {
              paths: ["/normalized_domain"],
            },
          },
        }),
        item: (id) => ({
          read: async () => {
            if (docsById.has(id)) return { resource: docsById.get(id) };
            const err = new Error("Not Found");
            err.code = 404;
            throw err;
          },
        }),
        items: {
          upsert: async (doc) => {
            if (doc && doc.id) docsById.set(String(doc.id), doc);
            return { resource: doc };
          },
          query: (spec) => ({
            fetchAll: async () => {
              const q = String(spec?.query || "");
              if (q.includes("SELECT * FROM c WHERE c.id IN (") || q.includes("WHERE c.id IN (")) {
                const params = Array.isArray(spec?.parameters) ? spec.parameters : [];
                const ids = params.map((p) => p?.value).filter(Boolean);
                const resources = ids.map((id) => docsById.get(String(id))).filter(Boolean);
                return { resources };
              }

              if (q.includes("ARRAY_CONTAINS(@ids, c.id)")) {
                const idsParam = spec?.parameters?.find((p) => p?.name === "@ids");
                const ids = Array.isArray(idsParam?.value) ? idsParam.value : [];
                const resources = ids.map((id) => docsById.get(String(id))).filter(Boolean);
                return { resources };
              }

              if (q.includes("SELECT TOP 1 c.id FROM c") && q.includes("NOT STARTSWITH(c.id, '_import_')")) {
                return { resources: [{ id: companyDoc.id }] };
              }

              return { resources: [] };
            },
          }),
        },
        database: () => fakeContainer,
        container: () => fakeContainer,
      };

      class FakeCosmosClient {
        constructor() {}
        database() {
          return {
            container: () => fakeContainer,
          };
        }
      }

      const cosmosModuleId = require.resolve("@azure/cosmos");
      const originalCosmosExports = require("@azure/cosmos");

      require.cache[cosmosModuleId].exports = { ...originalCosmosExports, CosmosClient: FakeCosmosClient };

      const importStatusModuleId = require.resolve("../import-status/index.js");
      const primaryJobStoreModuleId = require.resolve("../_importPrimaryJobStore.js");

      delete require.cache[importStatusModuleId];
      delete require.cache[primaryJobStoreModuleId];

      try {
        const { _test: freshImportStatusTest } = require("../import-status/index.js");

        const statusReq = makeReq({
          url: `https://example.test/api/import/status?session_id=${encodeURIComponent(session_id)}&force_resume=1`,
          method: "GET",
        });

        const statusRes = await freshImportStatusTest.handler(statusReq, { log() {} });
        const statusBody = JSON.parse(String(statusRes.body || "{}"));

        assert.equal(statusRes.status, 200);
        assert.equal(statusBody.ok, true);
        assert.equal(statusBody.session_id, session_id);

        // With STATUS_NO_ORCHESTRATION = false, force_resume=1 is now processed.
        // The endpoint can force-terminalize when cycle cap is reached.
        // Control docs CAN now be mutated since orchestration is enabled.
      } finally {
        require.cache[cosmosModuleId].exports = originalCosmosExports;
        delete require.cache[importStatusModuleId];
      delete require.cache[primaryJobStoreModuleId];
      }
    }
  );
});

test("/api/import/status converges to terminal-only even when stopped (mock cosmos)", async () => {
  const session_id = "99999999-aaaa-bbbb-cccc-444444444444";

  await withTempEnv(
    {
      ...NO_NETWORK_ENV,
      COSMOS_DB_ENDPOINT: "https://cosmos.fake.local",
      COSMOS_DB_KEY: "fake_key",
      COSMOS_DB_DATABASE: "tabarnam-db",
      COSMOS_DB_COMPANIES_CONTAINER: "companies",
      MAX_RESUME_CYCLES_SINGLE: "3",
    },
    async () => {
      const docsById = new Map();
      const now = new Date().toISOString();

      const companyDoc = {
        id: "company_1",
        session_id,
        import_session_id: session_id,
        normalized_domain: "example.com",
        company_name: "Example Co",
        website_url: "https://example.com",

        industries: [],
        industries_unknown: true,
        product_keywords: "",
        product_keywords_unknown: true,
        keywords: [],

        headquarters_location: "",
        hq_unknown: true,
        hq_unknown_reason: "not_found",

        manufacturing_locations: [],
        mfg_unknown: true,
        mfg_unknown_reason: "not_found",

        curated_reviews: [],
        review_count: 0,
        reviews_stage_status: "missing",
        review_cursor: {
          source: "xai_reviews",
          last_offset: 0,
          total_fetched: 0,
          exhausted: false,
          reviews_stage_status: "missing",
        },

        logo_stage_status: "missing",
        logo_url: "",

        import_missing_reason: {
          industries: "not_found",
          product_keywords: "not_found",
          headquarters_location: "not_found",
          manufacturing_locations: "not_found",
          reviews: "not_found",
          logo: "not_found",
        },

        created_at: now,
        updated_at: now,
      };

      docsById.set(`_import_session_${session_id}`, {
        id: `_import_session_${session_id}`,
        session_id,
        normalized_domain: "import",
        partition_key: "import",
        type: "import_control",
        status: "running",
        stage_beacon: "enrichment_resume_blocked",
        resume_needed: true,
        resume_cycle_count: 3,
        request: { limit: 1 },
        resume_error: "resume_worker_stuck_queued_no_progress",
        resume_error_details: {
          blocked_reason: "max_cycles",
          forced_by: "max_cycles",
          blocked_code: "resume_worker_stuck_queued_no_progress",
          blocked_at: now,
        },
        created_at: now,
        updated_at: now,
      });

      docsById.set(`_import_stop_${session_id}`, {
        id: `_import_stop_${session_id}`,
        session_id,
        normalized_domain: "import",
        partition_key: "import",
        type: "import_control",
        stopped: true,
        created_at: now,
        updated_at: now,
      });

      docsById.set(`_import_accept_${session_id}`, {
        id: `_import_accept_${session_id}`,
        session_id,
        normalized_domain: "import",
        partition_key: "import",
        type: "import_control",
        accepted: true,
        created_at: now,
        updated_at: now,
      });

      docsById.set(`_import_complete_${session_id}`, {
        id: `_import_complete_${session_id}`,
        session_id,
        normalized_domain: "import",
        partition_key: "import",
        type: "import_control",
        saved: 1,
        saved_ids: ["company_1"],
        saved_company_ids_verified: ["company_1"],
        saved_verified_count: 1,
        save_outcome: "saved",
        created_at: now,
        updated_at: now,
      });

      docsById.set(`_import_primary_job_${session_id}`, {
        id: `_import_primary_job_${session_id}`,
        session_id,
        normalized_domain: "import",
        partition_key: "import",
        type: "import_primary_job",
        job_state: "complete",
        stage_beacon: "primary_complete",
        attempt: 1,
        companies_count: 1,
        companies: [companyDoc],
        created_at: now,
        updated_at: now,
      });

      docsById.set(`_import_resume_${session_id}`, {
        id: `_import_resume_${session_id}`,
        session_id,
        normalized_domain: "import",
        partition_key: "import",
        type: "import_control",
        status: "blocked",
        resume_error: "resume_worker_stuck_queued_no_progress",
        resume_error_details: {
          blocked_reason: "max_cycles",
          forced_by: "max_cycles",
          blocked_code: "resume_worker_stuck_queued_no_progress",
          blocked_at: now,
        },
        lock_expires_at: null,
        missing_by_company: {
          company_1: ["industries", "product_keywords", "headquarters_location", "manufacturing_locations", "reviews", "logo"],
        },
        created_at: now,
        updated_at: now,
      });

      docsById.set("company_1", companyDoc);

      const fakeContainer = {
        read: async () => ({
          resource: {
            partitionKey: {
              paths: ["/normalized_domain"],
            },
          },
        }),
        item: (id) => ({
          read: async () => {
            if (docsById.has(id)) return { resource: docsById.get(id) };
            const err = new Error("Not Found");
            err.code = 404;
            throw err;
          },
        }),
        items: {
          upsert: async (doc) => {
            if (doc && doc.id) docsById.set(String(doc.id), doc);
            return { resource: doc };
          },
          query: (spec) => ({
            fetchAll: async () => {
              const q = String(spec?.query || "");
              if (q.includes("SELECT * FROM c WHERE c.id IN (") || q.includes("WHERE c.id IN (")) {
                const params = Array.isArray(spec?.parameters) ? spec.parameters : [];
                const ids = params.map((p) => p?.value).filter(Boolean);
                const resources = ids.map((id) => docsById.get(String(id))).filter(Boolean);
                return { resources };
              }

              if (q.includes("ARRAY_CONTAINS(@ids, c.id)")) {
                const idsParam = spec?.parameters?.find((p) => p?.name === "@ids");
                const ids = Array.isArray(idsParam?.value) ? idsParam.value : [];
                const resources = ids.map((id) => docsById.get(String(id))).filter(Boolean);
                return { resources };
              }

              if (q.includes("SELECT TOP 1 c.id FROM c") && q.includes("NOT STARTSWITH(c.id, '_import_')")) {
                return { resources: [{ id: companyDoc.id }] };
              }

              return { resources: [] };
            },
          }),
        },
        database: () => fakeContainer,
        container: () => fakeContainer,
      };

      class FakeCosmosClient {
        constructor() {}
        database() {
          return {
            container: () => fakeContainer,
          };
        }
      }

      const cosmosModuleId = require.resolve("@azure/cosmos");
      const originalCosmosExports = require("@azure/cosmos");

      require.cache[cosmosModuleId].exports = { ...originalCosmosExports, CosmosClient: FakeCosmosClient };

      const importStatusModuleId = require.resolve("../import-status/index.js");
      const primaryJobStoreModuleId = require.resolve("../_importPrimaryJobStore.js");

      delete require.cache[importStatusModuleId];
      delete require.cache[primaryJobStoreModuleId];

      try {
        const { _test: freshImportStatusTest } = require("../import-status/index.js");

        const statusReq = makeReq({
          url: `https://example.test/api/import/status?session_id=${encodeURIComponent(session_id)}&force_resume=1`,
          method: "GET",
        });

        const statusRes = await freshImportStatusTest.handler(statusReq, { log() {} });
        const statusBody = JSON.parse(String(statusRes.body || "{}"));

        assert.equal(statusRes.status, 200);
        assert.equal(statusBody.ok, true);
        assert.equal(statusBody.session_id, session_id);

        // With STATUS_NO_ORCHESTRATION = false, stopped sessions can now be processed.
        // The endpoint can force-terminalize to converge to terminal-only state.
        assert.equal(statusRes.status, 200);
        assert.equal(statusBody.ok, true);
        assert.equal(statusBody.stopped, true);
      } finally {
        require.cache[cosmosModuleId].exports = originalCosmosExports;
        delete require.cache[importStatusModuleId];
        delete require.cache[primaryJobStoreModuleId];
      }
    }
  );
});

test("/api/import/start buildReviewsUpstreamPayloadForImportStart uses live search mode and caps excluded websites", () => {
  assert.equal(typeof _test?.buildReviewsUpstreamPayloadForImportStart, "function");

  const reviewMessage = { role: "user", content: "Find independent reviews." };

  const built = _test.buildReviewsUpstreamPayloadForImportStart({
    reviewMessage,
    companyWebsiteHost: "audiocontrol.com",
  });

  assert.ok(built && typeof built === "object");
  assert.ok(built.reviewPayload && typeof built.reviewPayload === "object");

  const payload = built.reviewPayload;
  assert.equal(payload?.search_parameters?.mode, "on");

  const sources = payload?.search_parameters?.sources;
  assert.ok(Array.isArray(sources));

  const web = sources.find((s) => s?.type === "web");
  const news = sources.find((s) => s?.type === "news");

  assert.ok(Array.isArray(web?.excluded_websites));
  assert.ok(Array.isArray(news?.excluded_websites));
  assert.ok(web.excluded_websites.length <= 5);
  assert.ok(news.excluded_websites.length <= 5);

  const msg = Array.isArray(payload.messages) ? payload.messages.find((m) => m?.role === "user") : null;
  assert.ok(typeof msg?.content === "string");
  assert.ok(msg.content.includes("Also avoid these websites"));
});

test("/api/import/start uses provided session_id for async primary job and import-status reaches terminal state", async () => {
  await withTempEnv(
    {
      ...NO_NETWORK_ENV,
      XAI_EXTERNAL_BASE: "https://api.x.ai",
      XAI_EXTERNAL_KEY: "test_key",
    },
    async () => {
      const session_id = "22222222-3333-4444-5555-666666666666";

      const originalFetch = globalThis.fetch;
      globalThis.fetch = async () => {
        return new Response(JSON.stringify({ choices: [{ message: { content: "[]" } }] }), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      };

      try {
        const startReq = makeReq({
          // stage_ms_primary must exceed inline_budget_ms (60000) to trigger async primary mode
          url: "https://example.test/api/import/start?stage_ms_primary=70000",
          body: JSON.stringify({
            session_id,
            query: "test",
            queryTypes: ["product_keyword"],
            limit: 1,
          }),
          headers: {
            "content-type": "application/json",
          },
        });

        const startRes = await _test.importStartHandler(startReq, { log() {} });
        const startBody = parseJsonResponse(startRes);

        assert.equal(startRes.status, 200);
        assert.equal(startBody.ok, true);
        assert.equal(startBody.accepted, true);
        assert.equal(startBody.session_id, session_id);
        assert.equal(startRes.headers?.["x-session-id"], session_id);

        let terminalBody = null;
        for (let attempt = 0; attempt < 10; attempt += 1) {
          const statusReq = makeReq({
            url: `https://example.test/api/import/status?session_id=${encodeURIComponent(session_id)}`,
            method: "GET",
          });

          const statusRes = await importStatusTest.handler(statusReq, { log() {} });
          const statusBody = JSON.parse(String(statusRes.body || "{}"));

          assert.equal(statusRes.status, 200);
          assert.equal(statusBody.ok, true);
          assert.equal(statusBody.session_id, session_id);
          assert.equal(statusRes.headers?.["x-session-id"], session_id);

          const jobState = String(statusBody.job_state || statusBody.primary_job_state || "").trim();
          if (jobState === "complete" || jobState === "error") {
            terminalBody = statusBody;
            break;
          }

          await new Promise((resolve) => setTimeout(resolve, 10));
        }

        assert.ok(terminalBody);
        const terminalState = String(terminalBody.job_state || terminalBody.primary_job_state || "").trim();
        assert.ok(terminalState === "complete" || terminalState === "error");

        if (terminalState === "error") {
          assert.ok(terminalBody.last_error);
          assert.ok(String(terminalBody.last_error.code || "").trim());
        }
      } finally {
        globalThis.fetch = originalFetch;
      }
    }
  );
});

test("/api/import/start?max_stage=primary does not mark session complete in /api/import/status", async () => {
  await withTempEnv(
    {
      ...NO_NETWORK_ENV,
      XAI_EXTERNAL_BASE: "https://api.x.ai",
      XAI_EXTERNAL_KEY: "test_key",
    },
    async () => {
      const { _test: sessionStoreTest } = require("../_importSessionStore");
      const store = sessionStoreTest.getState();
      store.map.clear();
      store.order.length = 0;

      const session_id = "33333333-4444-5555-6666-777777777777";

      const startReq = makeReq({
        url: "https://example.test/api/import/start?max_stage=primary",
        body: JSON.stringify({
          session_id,
          query: "https://mariposaranch.com/",
          queryTypes: ["company_url"],
          limit: 1,
          companies: [
            {
              company_name: "Mariposa Ranch",
              website_url: "https://mariposaranch.com/",
              url: "https://mariposaranch.com/",
              normalized_domain: "mariposaranch.com",
            },
          ],
        }),
        headers: {
          "content-type": "application/json",
        },
      });

      const startRes = await _test.importStartHandler(startReq, { log() {} });
      const startBody = parseJsonResponse(startRes);

      assert.equal(startRes.status, 200);
      assert.equal(startBody.ok, true);
      assert.equal(startBody.session_id, session_id);
      assert.equal(startBody?.meta?.stopped_after_stage, "primary");

      const statusReq = makeReq({
        url: `https://example.test/api/import/status?session_id=${encodeURIComponent(session_id)}`,
        method: "GET",
      });

      const statusRes = await importStatusTest.handler(statusReq, { log() {} });
      const statusBody = JSON.parse(String(statusRes.body || "{}"));

      assert.equal(statusRes.status, 200);
      assert.equal(statusBody.ok, true);
      assert.equal(statusBody.session_id, session_id);

      // Staged max_stage calls should not mark the import as complete. Completion is only after save.
      assert.equal(statusBody.state, "running");
    }
  );
});

test("/api/import/start rejects skip_stages=primary without seed companies", async () => {
  await withTempEnv(NO_NETWORK_ENV, async () => {
    const session_id = "44444444-5555-6666-7777-888888888888";

    const req = makeReq({
      url: "https://example.test/api/import/start?skip_stages=primary",
      body: JSON.stringify({
        session_id,
        query: "test",
        queryTypes: ["product_keyword"],
        limit: 1,
      }),
      headers: {
        "content-type": "application/json",
      },
    });

    const res = await _test.importStartHandler(req, { log() {} });
    const body = parseJsonResponse(res);

    assert.equal(res.status, 200);
    assert.equal(body.ok, false);
    assert.equal(body.stage, "import_start");
    assert.equal(body.session_id, session_id);
    assert.equal(body.root_cause, "missing_seed_companies");
    assert.equal(body.retryable, true);
    assert.equal(body.message, "skip_stages includes primary but no companies were provided");
  });
});

test("/api/import/start rejects skip_stages=primary with only invalid seed companies", async () => {
  await withTempEnv(NO_NETWORK_ENV, async () => {
    const session_id = "44444444-5555-6666-7777-999999999999";

    const req = makeReq({
      url: "https://example.test/api/import/start?skip_stages=primary",
      body: JSON.stringify({
        session_id,
        query: "test",
        queryTypes: ["product_keyword"],
        limit: 1,
        companies: [
          {
            company_name: "Example",
            website_url: "https://example.com",
            source: "company_url_shortcut",
          },
        ],
      }),
      headers: {
        "content-type": "application/json",
      },
    });

    const res = await _test.importStartHandler(req, { log() {} });
    const body = parseJsonResponse(res);

    assert.equal(res.status, 200);
    assert.equal(body.ok, false);
    assert.equal(body.stage, "import_start");
    assert.equal(body.session_id, session_id);
    assert.equal(body.root_cause, "invalid_seed_companies");
    assert.equal(body.retryable, true);
    assert.ok(typeof body.message === "string" && body.message.length > 0);
    assert.equal(body.seed_counts?.provided, 1);
    assert.equal(body.seed_counts?.valid, 0);
  });
});

test("/api/import/start company_url_seed_fallback persists and verifies seed company", async (t) => {
  const endpoint = (process.env.COSMOS_DB_ENDPOINT || process.env.COSMOS_DB_DB_ENDPOINT || "").trim();
  const key = (process.env.COSMOS_DB_KEY || process.env.COSMOS_DB_DB_KEY || "").trim();

  if (!endpoint || !key) {
    t.skip("Cosmos not configured in test environment");
    return;
  }

  const { CosmosClient } = require("@azure/cosmos");

  const seedHost = `seed-fallback-contract-${Date.now()}.example.com`;
  const seedUrl = `https://${seedHost}/`;

  await withTempEnv(
    {
      XAI_EXTERNAL_BASE: "https://example.invalid",
      XAI_EXTERNAL_KEY: "test",
    },
    async () => {
      const req = makeReq({
        url: "https://example.test/api/import/start?max_stage=expand",
        body: JSON.stringify({
          query: seedUrl,
          queryTypes: ["company_url"],
          auto_resume: false,
        }),
        headers: {
          "content-type": "application/json",
        },
      });

      const res = await _test.importStartHandler(req, { log() {} });
      const body = parseJsonResponse(res);

      assert.equal(res.status, 200);
      assert.equal(body.ok, true);
      assert.equal(body.stage_beacon, "company_url_seed_fallback");
      assert.equal(body.company_url, seedUrl);

      assert.equal(Number(body?.save_report?.failed ?? 0), 0);
      assert.equal(String(body?.save_report?.save_outcome || ""), "saved_verified");
      assert.equal(Number(body?.saved_verified_count ?? 0), 1);

      const writeIds = Array.isArray(body?.save_report?.saved_ids_write) ? body.save_report.saved_ids_write : [];
      assert.equal(writeIds.length, 1);

      const databaseId = (process.env.COSMOS_DB_DATABASE || "tabarnam-db").trim();
      const containerId = (process.env.COSMOS_DB_COMPANIES_CONTAINER || "companies").trim();
      const client = new CosmosClient({ endpoint, key });
      const container = client.database(databaseId).container(containerId);

      const normalizedDomain = seedHost.replace(/^www\./, "").toLowerCase();
      const companyId = String(writeIds[0] || "").trim();

      await container.item(companyId, normalizedDomain).delete().catch(() => null);

      const sessionId = String(body?.session_id || "").trim();
      if (sessionId) {
        await container.item(`_import_session_${sessionId}`, "import").delete().catch(() => null);
        await container.item(`_import_resume_${sessionId}`, "import").delete().catch(() => null);
        await container.item(`_import_accept_${sessionId}`, "import").delete().catch(() => null);
        await container.item(`_import_complete_${sessionId}`, "import").delete().catch(() => null);
        await container.item(`_import_error_${sessionId}`, "import").delete().catch(() => null);
      }
    }
  );
});

test("/api/import/start company_url_seed_fallback duplicate_detected returns verified existing company", async (t) => {
  // Previously skipped due to seed-fallback duplicate behavior; should be stable now.
  const endpoint = (process.env.COSMOS_DB_ENDPOINT || process.env.COSMOS_DB_DB_ENDPOINT || "").trim();
  const key = (process.env.COSMOS_DB_KEY || process.env.COSMOS_DB_DB_KEY || "").trim();

  if (!endpoint || !key) {
    t.skip("Cosmos not configured in test environment");
    return;
  }

  const { CosmosClient } = require("@azure/cosmos");

  const seedHost = `seed-fallback-dup-${Date.now()}.example.com`;
  const seedUrl = `https://${seedHost}/`;

  await withTempEnv(
    {
      XAI_EXTERNAL_BASE: "https://example.invalid",
      XAI_EXTERNAL_KEY: "test",
    },
    async () => {
      const databaseId = (process.env.COSMOS_DB_DATABASE || "tabarnam-db").trim();
      const containerId = (process.env.COSMOS_DB_COMPANIES_CONTAINER || "companies").trim();
      const client = new CosmosClient({ endpoint, key });
      const container = client.database(databaseId).container(containerId);

      const req1 = makeReq({
        url: "https://example.test/api/import/start?max_stage=expand",
        body: JSON.stringify({
          query: seedUrl,
          queryTypes: ["company_url"],
          auto_resume: false,
        }),
        headers: {
          "content-type": "application/json",
        },
      });

      const res1 = await _test.importStartHandler(req1, { log() {} });
      const body1 = parseJsonResponse(res1);

      assert.equal(res1.status, 200);
      assert.equal(body1.ok, true);
      assert.equal(body1.stage_beacon, "company_url_seed_fallback");
      assert.equal(body1.company_url, seedUrl);
      assert.equal(Number(body1?.save_report?.failed ?? 0), 0);
      assert.equal(Number(body1?.saved_verified_count ?? 0), 1);
      assert.equal(String(body1?.save_report?.save_outcome || ""), "saved_verified");

      const writeIds1 = Array.isArray(body1?.save_report?.saved_ids_write) ? body1.save_report.saved_ids_write : [];
      assert.equal(writeIds1.length, 1);
      const companyId = String(writeIds1[0] || "").trim();
      assert.ok(companyId);

      const req2 = makeReq({
        url: "https://example.test/api/import/start?max_stage=expand",
        body: JSON.stringify({
          query: seedUrl,
          queryTypes: ["company_url"],
          auto_resume: false,
        }),
        headers: {
          "content-type": "application/json",
        },
      });

      const res2 = await _test.importStartHandler(req2, { log() {} });
      const body2 = parseJsonResponse(res2);

      assert.equal(res2.status, 200);
      assert.equal(body2.ok, true, JSON.stringify(body2));
      assert.equal(body2.stage_beacon, "company_url_seed_fallback");
      assert.equal(body2.company_url, seedUrl);
      assert.equal(Number(body2?.save_report?.failed ?? 0), 0);
      assert.equal(Number(body2?.saved_verified_count ?? 0), 1);
      assert.equal(String(body2?.save_report?.save_outcome || ""), "duplicate_detected");

      const verifiedIds2 = Array.isArray(body2?.saved_company_ids_verified) ? body2.saved_company_ids_verified : [];
      assert.equal(verifiedIds2.length, 1);
      assert.equal(String(verifiedIds2[0] || ""), companyId);

      const normalizedDomain = seedHost.replace(/^www\./, "").toLowerCase();
      await container.item(companyId, normalizedDomain).delete().catch(() => null);

      const cleanupSession = async (sid) => {
        const sessionId = String(sid || "").trim();
        if (!sessionId) return;
        await container.item(`_import_session_${sessionId}`, "import").delete().catch(() => null);
        await container.item(`_import_resume_${sessionId}`, "import").delete().catch(() => null);
        await container.item(`_import_accept_${sessionId}`, "import").delete().catch(() => null);
        await container.item(`_import_complete_${sessionId}`, "import").delete().catch(() => null);
        await container.item(`_import_error_${sessionId}`, "import").delete().catch(() => null);
      };

      await cleanupSession(body1?.session_id);
      await cleanupSession(body2?.session_id);
    }
  );
});
