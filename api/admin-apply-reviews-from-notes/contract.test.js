const assert = require("node:assert/strict");

const { _test } = require("./index.js");

function makeReq({
  url = "https://example.test/api/admin/companies/company_1/apply-reviews-from-notes",
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

function applyPatchOps(doc, ops) {
  for (const op of ops || []) {
    if (!op || op.op !== "set") continue;
    const path = String(op.path || "");
    const key = path.startsWith("/") ? path.slice(1) : path;
    doc[key] = op.value;
  }
}

function makeCompaniesContainer({ initialDocsById }) {
  const docsById = { ...initialDocsById };

  return {
    read: async () => ({ resource: { partitionKey: { paths: ["/normalized_domain"] } } }),
    items: {
      query: (spec) => ({
        fetchAll: async () => {
          const id = spec?.parameters?.find((p) => p?.name === "@id")?.value;
          const doc = id ? docsById[String(id)] : null;
          return { resources: doc ? [doc] : [] };
        },
      }),
      upsert: async (doc) => {
        docsById[String(doc.id)] = doc;
        return { resource: doc };
      },
    },
    item: (id) => ({
      patch: async (ops) => {
        const doc = docsById[String(id)];
        if (!doc) throw new Error("Not found");
        applyPatchOps(doc, ops);
        docsById[String(id)] = doc;
        return { resource: doc };
      },
    }),
    _getDoc: (id) => docsById[String(id)],
  };
}

test("/api/admin/companies/{id}/apply-reviews-from-notes parses JSON array of strings", async () => {
  const companiesContainer = makeCompaniesContainer({
    initialDocsById: {
      company_1: {
        id: "company_1",
        company_id: "company_1",
        normalized_domain: "acme.example",
        notes: '["Nice towels","Fast shipping"]',
        curated_reviews: [],
      },
    },
  });

  const res = await _test.adminApplyReviewsFromNotesHandler(
    makeReq({ body: { mode: "append", dry_run: true } }),
    { log() {}, bindingData: { company_id: "company_1" } },
    { companiesContainer, nowIso: () => "2026-01-10T00:00:00.000Z" }
  );

  assert.equal(res.status, 200);
  const body = JSON.parse(res.body);
  assert.equal(body.ok, true);
  assert.equal(body.parsed_count, 2);
  assert.equal(body.saved_count, 2);
  assert.equal(body.review_count, 2);
  assert.ok(Array.isArray(body.preview));
  assert.equal(body.preview.length, 2);
});

test("/api/admin/companies/{id}/apply-reviews-from-notes parses YAML-ish blocks with multiline text", async () => {
  const notes = `Rating: 5\nTitle: Amazing robe\nAuthor: Jordan\nDate: 2026-01-08\nText: Super soft and thick.\n  Would buy again.\nURL: https://example.com/reviews/123\n\nRating: 4\nText: Nice quality, runs a bit large.`;

  const companiesContainer = makeCompaniesContainer({
    initialDocsById: {
      company_1: {
        id: "company_1",
        company_id: "company_1",
        normalized_domain: "acme.example",
        notes,
        curated_reviews: [],
      },
    },
  });

  const res = await _test.adminApplyReviewsFromNotesHandler(
    makeReq({ body: { dry_run: true } }),
    { log() {}, bindingData: { company_id: "company_1" } },
    { companiesContainer, nowIso: () => "2026-01-10T00:00:00.000Z" }
  );

  const body = JSON.parse(res.body);
  assert.equal(body.ok, true);
  assert.equal(body.parsed_count, 2);
  assert.equal(body.saved_count, 2);
  assert.equal(body.review_count, 2);
  assert.ok(body.preview[0].text.includes("Would buy again."));
  assert.equal(body.preview[0].url, "https://example.com/reviews/123");
});

test("/api/admin/companies/{id}/apply-reviews-from-notes parses delimited blocks", async () => {
  const notes = `---\n5 | Amazing quality | Jordan | 2026-01-08\nSuper soft and thick. Would buy again.\nURL: https://example.com/r/1\n---\n4 | (no title) | (anonymous) | 2026-01-07\nNice quality, runs a bit large.`;

  const companiesContainer = makeCompaniesContainer({
    initialDocsById: {
      company_1: {
        id: "company_1",
        company_id: "company_1",
        normalized_domain: "acme.example",
        notes,
        curated_reviews: [],
      },
    },
  });

  const res = await _test.adminApplyReviewsFromNotesHandler(
    makeReq({ body: { dry_run: true } }),
    { log() {}, bindingData: { company_id: "company_1" } },
    { companiesContainer, nowIso: () => "2026-01-10T00:00:00.000Z" }
  );

  const body = JSON.parse(res.body);
  assert.equal(body.ok, true);
  assert.equal(body.parsed_count, 2);
  assert.equal(body.saved_count, 2);
  assert.equal(body.review_count, 2);
  assert.equal(body.preview[0].title, "Amazing quality");
  assert.equal(body.preview[1].title, "");
  assert.equal(body.preview[1].author, "");
});

test("append mode dedupes against existing curated_reviews", async () => {
  const notes = '[{"rating":5,"title":"Great","author":"Sam","date":"2025-12-01","text":"Loved it"},{"rating":4,"text":"Good value"}]';

  const companiesContainer = makeCompaniesContainer({
    initialDocsById: {
      company_1: {
        id: "company_1",
        company_id: "company_1",
        normalized_domain: "acme.example",
        notes,
        curated_reviews: [],
        review_cursor: { source: "xai_reviews" },
      },
    },
  });

  const ctx = { log() {}, bindingData: { company_id: "company_1" } };

  const first = await _test.adminApplyReviewsFromNotesHandler(
    makeReq({ body: { mode: "append", dry_run: false } }),
    ctx,
    { companiesContainer, nowIso: () => "2026-01-10T00:00:00.000Z" }
  );

  const firstBody = JSON.parse(first.body);
  assert.equal(firstBody.ok, true);
  assert.equal(firstBody.saved_count, 2);
  assert.equal(firstBody.review_count, 2);

  const second = await _test.adminApplyReviewsFromNotesHandler(
    makeReq({ body: { mode: "append", dry_run: false } }),
    ctx,
    { companiesContainer, nowIso: () => "2026-01-10T00:00:01.000Z" }
  );

  const secondBody = JSON.parse(second.body);
  assert.equal(secondBody.ok, true);
  assert.equal(secondBody.parsed_count, 2);
  assert.equal(secondBody.saved_count, 0);
  assert.equal(secondBody.review_count, 2);

  const updatedDoc = companiesContainer._getDoc("company_1");
  assert.equal(Array.isArray(updatedDoc.curated_reviews) ? updatedDoc.curated_reviews.length : 0, 2);
  assert.equal(updatedDoc.review_cursor.source, "manual_notes");
  assert.equal(updatedDoc.review_cursor.last_success_at, "2026-01-10T00:00:01.000Z");
});

test("replace mode overwrites curated_reviews", async () => {
  const notes = '["Only one"]';

  const companiesContainer = makeCompaniesContainer({
    initialDocsById: {
      company_1: {
        id: "company_1",
        company_id: "company_1",
        normalized_domain: "acme.example",
        notes,
        curated_reviews: [{ id: "r1", title: "Old", text: "Old", author: "", date: "" }],
      },
    },
  });

  const res = await _test.adminApplyReviewsFromNotesHandler(
    makeReq({ body: { mode: "replace", dry_run: false } }),
    { log() {}, bindingData: { company_id: "company_1" } },
    { companiesContainer, nowIso: () => "2026-01-10T00:00:00.000Z" }
  );

  const body = JSON.parse(res.body);
  assert.equal(body.ok, true);
  assert.equal(body.saved_count, 1);
  assert.equal(body.review_count, 1);

  const updatedDoc = companiesContainer._getDoc("company_1");
  assert.equal(updatedDoc.curated_reviews.length, 1);
  assert.equal(updatedDoc.curated_reviews[0].text, "Only one");
});
