const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { test } = require("node:test");

const { _test } = require("./index.js");
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

    assert.equal(res.status, 400);
    assert.equal(body?.error?.code, "INVALID_JSON_BODY");
    assert.equal(body.stage, "validate_request");
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

    assert.equal(res.status, 400);
    assert.equal(body?.error?.code, "INVALID_JSON_BODY");
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

    assert.equal(res.status, 400);
    assert.equal(body?.error?.code, "IMPORT_START_VALIDATION_FAILED");
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

    assert.equal(res.status, 400);
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

    assert.equal(res.status, 400);
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
