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
} = {}) {
  const req = {
    method,
    url,
    headers: new Headers(),
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
