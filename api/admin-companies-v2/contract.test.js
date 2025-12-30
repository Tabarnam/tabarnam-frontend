const test = require("node:test");
const assert = require("node:assert/strict");

const { _test } = require("./index.js");

function parseJson(res) {
  assert.ok(res);
  assert.equal(res.headers?.["Content-Type"] || res.headers?.["content-type"], "application/json");
  return JSON.parse(res.body);
}

function makeReq({ method = "GET", url = "https://example.test/api/xadmin-api-companies", query, json } = {}) {
  const req = {
    method,
    url,
    headers: new Headers(),
    query: query || {},
  };

  if (typeof json === "function") req.json = json;

  return req;
}

function makeMemoryContainer() {
  const store = new Map();

  function getParam(spec, name) {
    const params = Array.isArray(spec?.parameters) ? spec.parameters : [];
    const found = params.find((p) => p && p.name === name);
    return found ? found.value : undefined;
  }

  function searchableText(doc) {
    const fields = [
      doc?.company_name,
      doc?.name,
      doc?.company_id,
      doc?.id,
      doc?.normalized_domain,
      doc?.website_url,
      doc?.url,
      doc?.canonical_url,
      doc?.website,
    ];

    return fields
      .map((v) => (typeof v === "string" ? v : v == null ? "" : String(v)))
      .filter(Boolean)
      .join(" ")
      .toLowerCase();
  }

  function runQuery(spec) {
    const sql = String(spec?.query || "");

    if (sql.includes("WHERE c.id = @id")) {
      const id = String(getParam(spec, "@id") || "");
      const doc = store.get(id) || null;

      if (!doc) return [];

      const filtersDeleted = sql.includes("c.is_deleted") && sql.includes("IS_DEFINED");
      if (filtersDeleted && doc.is_deleted === true) return [];

      return [doc];
    }

    if (sql.includes("SELECT TOP @take * FROM c")) {
      const qRaw = getParam(spec, "@q");
      const q = qRaw == null ? "" : String(qRaw).toLowerCase();
      const includeDeleted = !sql.includes("NOT IS_DEFINED(c.is_deleted)") && !sql.includes("c.is_deleted != true");

      const all = Array.from(store.values());
      const filtered = all.filter((doc) => {
        if (!includeDeleted && doc.is_deleted === true) return false;
        if (!q) return true;
        return searchableText(doc).includes(q);
      });

      return filtered;
    }

    if (sql.includes("SELECT TOP 1 c.id")) {
      const id = String(getParam(spec, "@id") || "");
      const doc = store.get(id);
      return doc ? [{ id: doc.id }] : [];
    }

    return [];
  }

  return {
    read: async () => ({ resource: { partitionKey: { paths: ["/normalized_domain"] } } }),
    items: {
      query: (spec) => ({
        fetchAll: async () => ({ resources: runQuery(spec) }),
      }),
      upsert: async (doc) => {
        const next = doc && typeof doc === "object" ? { ...doc } : doc;
        if (next && typeof next === "object" && typeof next.id === "string") {
          store.set(next.id, next);
        }
        return { statusCode: 200, resource: next };
      },
    },
    item: (id) => ({
      replace: async (doc) => {
        const next = doc && typeof doc === "object" ? { ...doc } : doc;
        if (next && typeof next === "object") store.set(String(id), next);
        return { resource: next };
      },
      delete: async () => {
        store.delete(String(id));
        return { statusCode: 200 };
      },
    }),
    _dump: () => Array.from(store.values()),
  };
}

test("xadmin-api-companies: GET is 404 and search excludes after DELETE", async () => {
  const container = makeMemoryContainer();

  const marker = "contract_delete_marker";
  const companyId = `company_${marker}`;

  const createRes = await _test.adminCompaniesHandler(
    makeReq({
      method: "POST",
      url: "https://example.test/api/xadmin-api-companies",
      json: async () => ({
        id: companyId,
        company_id: companyId,
        company_name: `Test ${marker}`,
        name: `Test ${marker}`,
        website_url: "https://example.com",
      }),
    }),
    { log() {} },
    { container }
  );

  assert.equal(createRes.status, 200);
  const createBody = parseJson(createRes);
  assert.equal(createBody.ok, true);
  assert.equal(createBody.company?.id, companyId);

  const delRes = await _test.adminCompaniesHandler(
    makeReq({
      method: "DELETE",
      url: `https://example.test/api/xadmin-api-companies/${encodeURIComponent(companyId)}`,
      json: async () => ({ actor: "contract_test" }),
    }),
    { log() {}, bindingData: { id: companyId } },
    { container }
  );

  assert.equal(delRes.status, 200);
  const delBody = parseJson(delRes);
  assert.equal(delBody.ok, true);

  const getRes = await _test.adminCompaniesHandler(
    makeReq({
      method: "GET",
      url: `https://example.test/api/xadmin-api-companies/${encodeURIComponent(companyId)}`,
    }),
    { log() {}, bindingData: { id: companyId } },
    { container }
  );

  // Contract option A (preferred): deleted company is not retrievable and yields 404.
  assert.equal(getRes.status, 404);

  const searchRes = await _test.adminCompaniesHandler(
    makeReq({
      method: "GET",
      url: `https://example.test/api/xadmin-api-companies?q=${encodeURIComponent(marker)}`,
      query: { q: marker },
    }),
    { log() {} },
    { container }
  );

  assert.equal(searchRes.status, 200);
  const searchBody = parseJson(searchRes);
  const items = Array.isArray(searchBody.items) ? searchBody.items : [];

  // Search must not return an active company after delete.
  assert.ok(items.length === 0 || items.every((it) => it && it.is_deleted === true));
});

test("xadmin-api-companies: PUT infers and persists display_name from name override", async () => {
  const container = makeMemoryContainer();

  const companyId = "company_display_name_contract";

  const createRes = await _test.adminCompaniesHandler(
    makeReq({
      method: "POST",
      url: "https://example.test/api/xadmin-api-companies",
      json: async () => ({
        id: companyId,
        company_id: companyId,
        company_name: "RovR Products",
        name: "RovR Products",
        website_url: "https://example.com",
      }),
    }),
    { log() {} },
    { container }
  );

  assert.equal(createRes.status, 200);

  const updateRes = await _test.adminCompaniesHandler(
    makeReq({
      method: "PUT",
      url: `https://example.test/api/xadmin-api-companies/${encodeURIComponent(companyId)}`,
      json: async () => ({
        id: companyId,
        company_id: companyId,
        company_name: "RovR Products",
        name: "RovR",
        website_url: "https://example.com",
      }),
    }),
    { log() {}, bindingData: { id: companyId } },
    { container }
  );

  assert.equal(updateRes.status, 200);
  const updateBody = parseJson(updateRes);
  assert.equal(updateBody.ok, true);
  assert.equal(updateBody.company?.display_name, "RovR");

  const stored = container._dump().find((d) => d && d.id === companyId);
  assert.ok(stored);
  assert.equal(stored.display_name, "RovR");

  const clearRes = await _test.adminCompaniesHandler(
    makeReq({
      method: "PUT",
      url: `https://example.test/api/xadmin-api-companies/${encodeURIComponent(companyId)}`,
      json: async () => ({
        id: companyId,
        company_id: companyId,
        company_name: "RovR Products",
        name: "RovR Products",
        website_url: "https://example.com",
      }),
    }),
    { log() {}, bindingData: { id: companyId } },
    { container }
  );

  assert.equal(clearRes.status, 200);
  const storedCleared = container._dump().find((d) => d && d.id === companyId);
  assert.ok(storedCleared);
  assert.ok(!("display_name" in storedCleared));
});

test("xadmin-api-companies: persists curated_reviews array", async () => {
  const container = makeMemoryContainer();

  const companyId = "company_curated_reviews_contract";

  const createRes = await _test.adminCompaniesHandler(
    makeReq({
      method: "POST",
      url: "https://example.test/api/xadmin-api-companies",
      json: async () => ({
        id: companyId,
        company_id: companyId,
        company_name: "Curated Reviews Co",
        name: "Curated Reviews Co",
        website_url: "https://example.com",
        curated_reviews: [
          {
            id: "curated_1",
            source: "professional_review",
            source_url: "https://example.com/review-1",
            title: "Review One",
            excerpt: "Good stuff",
            author: "Example Magazine",
            date: "2025-01-01",
            show_to_users: true,
            is_public: true,
          },
        ],
      }),
    }),
    { log() {} },
    { container }
  );

  assert.equal(createRes.status, 200);
  const createBody = parseJson(createRes);
  assert.equal(createBody.ok, true);
  assert.equal(Array.isArray(createBody.company?.curated_reviews), true);
  assert.equal(createBody.company.curated_reviews.length, 1);

  const updateRes = await _test.adminCompaniesHandler(
    makeReq({
      method: "PUT",
      url: `https://example.test/api/xadmin-api-companies/${encodeURIComponent(companyId)}`,
      json: async () => ({
        id: companyId,
        company_id: companyId,
        company_name: "Curated Reviews Co",
        name: "Curated Reviews Co",
        website_url: "https://example.com",
        curated_reviews: [
          ...(createBody.company.curated_reviews || []),
          {
            id: "curated_2",
            source: "professional_review",
            source_url: "https://example.com/review-2",
            title: "Review Two",
            excerpt: "Even better",
            author: "Example Lab",
            date: "2025-02-01",
            show_to_users: true,
            is_public: true,
          },
        ],
      }),
    }),
    { log() {}, bindingData: { id: companyId } },
    { container }
  );

  assert.equal(updateRes.status, 200);
  const updateBody = parseJson(updateRes);
  assert.equal(updateBody.ok, true);
  assert.equal(Array.isArray(updateBody.company?.curated_reviews), true);
  assert.equal(updateBody.company.curated_reviews.length, 2);

  const stored = container._dump().find((d) => d && d.id === companyId);
  assert.ok(stored);
  assert.equal(Array.isArray(stored.curated_reviews), true);
  assert.equal(stored.curated_reviews.length, 2);
});
