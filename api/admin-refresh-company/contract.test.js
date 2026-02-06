const test = require("node:test");
const assert = require("node:assert/strict");

const { _test } = require("./index.js");

function makeReq({
  url = "https://example.test/api/xadmin-api-refresh-company",
  method = "POST",
  json,
  body,
  rawBody,
} = {}) {
  const req = {
    method,
    url,
    headers: new Headers(),
  };

  if (typeof json === "function") req.json = json;
  if (body !== undefined) req.body = body;
  if (rawBody !== undefined) req.rawBody = rawBody;

  return req;
}

function makeCompaniesContainer(docById) {
  return {
    items: {
      query: (spec) => ({
        fetchAll: async () => {
          const id = spec?.parameters?.find((p) => p?.name === "@id")?.value;
          const doc = id ? docById[String(id)] : null;
          return { resources: doc ? [doc] : [] };
        },
      }),
    },
  };
}

test("/api/xadmin-api-refresh-company returns HTTP 200 JSON if company_id missing", async () => {
  const res = await _test.adminRefreshCompanyHandler(
    makeReq({ json: async () => ({}) }),
    { log() {} }
  );

  // SAFE refresh contract: always 200 JSON (never hard errors that strand the UI).
  assert.equal(res.status, 200);
  const body = JSON.parse(res.body);
  assert.equal(body.ok, false);
  assert.equal(body.root_cause, "client_bad_request");
  assert.equal(body.error, "company_id required");
});

test("/api/xadmin-api-refresh-company returns 200 with ok/proposed for stubbed upstream", async () => {
  const companiesContainer = makeCompaniesContainer({
    company_1: {
      id: "company_1",
      company_name: "Acme Corp",
      website_url: "https://acme.example",
      normalized_domain: "acme.example",
    },
  });

  // The unified enrichment engine uses xaiLiveSearch which checks for a global stub.
  // Provide a deterministic response that mimics Grok returning all fields as JSON.
  const unifiedResponse = JSON.stringify({
    tagline: "We build things",
    headquarters_location: "Austin, TX",
    manufacturing_locations: ["United States"],
    industries: ["Manufacturing"],
    product_keywords: ["widgets", "gadgets"],
    reviews: [],
  });

  const originalStub = globalThis.__xaiLiveSearchStub;
  globalThis.__xaiLiveSearchStub = async () => ({
    ok: true,
    resp: {
      data: {
        output: [{ content: [{ type: "output_text", text: unifiedResponse }] }],
      },
    },
    diagnostics: { elapsed_ms: 100, timeout_ms: 60000 },
  });

  try {
    const res = await _test.adminRefreshCompanyHandler(
      makeReq({ json: async () => ({ company_id: "company_1" }) }),
      { log() {} },
      {
        companiesContainer,
        xaiUrl: "https://xai.test/v1/responses",
        xaiKey: "xai_test_key",
      }
    );

    assert.equal(res.status, 200);
    const body = JSON.parse(res.body);
    assert.equal(body.ok, true);
    assert.equal(body.company_id, "company_1");
    assert.ok(body.proposed && typeof body.proposed === "object");
    assert.equal(body.proposed.company_name, "Acme Corp");
  } finally {
    // Restore original stub state
    if (originalStub === undefined) {
      delete globalThis.__xaiLiveSearchStub;
    } else {
      globalThis.__xaiLiveSearchStub = originalStub;
    }
  }
});
