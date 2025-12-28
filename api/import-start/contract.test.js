const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { test } = require("node:test");


const { _test } = require("./index.js");
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

    assert.equal(res.status, 400);
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

    assert.equal(res.status, 400);
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

        assert.equal(res.status, 400);
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
          url: "https://example.test/api/import/start?stage_ms_primary=30000",
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

        assert.equal(startRes.status, 202);
        assert.equal(startBody.ok, true);
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
