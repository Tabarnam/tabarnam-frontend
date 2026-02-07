const assert = require("node:assert/strict");
const { test } = require("node:test");

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

test("parseNotesToCandidates parses Grok-style output with Source and Text fields", () => {
  const input = [
    "Source: YouTube",
    "Author: Studio H",
    "URL: https://www.youtube.com/watch?v=9KNsKJgWnG0",
    "Title: Joey On The Hill: Herbaria Soap Factory",
    "Date: Jun 19, 2024",
    "Text: Herbaria Soap Factory produces all-natural soaps.",
    "",
    "",
    "Source: Vegan Beauty Review",
    "Author: Sunny",
    "URL: https://veganbeautyreview.com/herbaria-review",
    "Title: Herbaria Soaps Review",
    "Date: November 27, 2007",
    "Text: Herbaria Soaps are vegan, made with olive and hemp seed oils.",
  ].join("\n");

  const { candidates, format } = _test.parseNotesToCandidates(input);
  assert.equal(format, "yaml");
  assert.equal(candidates.length, 2);

  assert.equal(candidates[0].source_name, "YouTube");
  assert.equal(candidates[0].author, "Studio H");
  assert.equal(candidates[0].url, "https://www.youtube.com/watch?v=9KNsKJgWnG0");
  assert.equal(candidates[0].title, "Joey On The Hill: Herbaria Soap Factory");
  assert.equal(candidates[0].date, "Jun 19, 2024");
  assert.equal(candidates[0].text, "Herbaria Soap Factory produces all-natural soaps.");

  assert.equal(candidates[1].source_name, "Vegan Beauty Review");
  assert.equal(candidates[1].author, "Sunny");
});

test("parseNotesToCandidates handles markdown bold headers from Grok output", () => {
  const input = [
    "**Review 1**",
    "Source: YouTube",
    "Author: Studio H",
    "URL: https://www.youtube.com/watch?v=abc123",
    "Title: Test Video",
    "Date: Jan 1, 2025",
    "Text: Great review of the product.",
    "",
    "",
    "**Review 2**",
    "Source: Some Blog",
    "Author: Jane Doe",
    "URL: https://blog.example.com/review",
    "Title: Blog Post Title",
    "Date: Feb 15, 2025",
    "Text: Detailed blog review.",
  ].join("\n");

  const { candidates, format } = _test.parseNotesToCandidates(input);
  assert.equal(format, "yaml");
  assert.equal(candidates.length, 2);
  assert.equal(candidates[0].source_name, "YouTube");
  assert.equal(candidates[0].text, "Great review of the product.");
  assert.equal(candidates[1].source_name, "Some Blog");
  assert.equal(candidates[1].text, "Detailed blog review.");
});

test("Excerpt field maps to text in YAML-ish format", () => {
  const input = [
    "Source: YouTube",
    "Author: Test Author",
    "URL: https://example.com/review",
    "Title: Test Review",
    "Date: Jan 1, 2025",
    "Excerpt: This is the excerpt content.",
  ].join("\n");

  const { candidates } = _test.parseNotesToCandidates(input);
  assert.equal(candidates.length, 1);
  assert.equal(candidates[0].text, "This is the excerpt content.");
});

test("normalizeManualReview propagates source_name", () => {
  const result = _test.normalizeManualReview({
    source_name: "YouTube",
    text: "Great video review.",
    title: "Test",
    author: "Reviewer",
    date: "2025-01-01",
    url: "https://youtube.com/watch?v=abc",
  });

  assert.equal(result.source_name, "YouTube");
  assert.equal(result.source, "YouTube");
  assert.equal(result.text, "Great video review.");
});

test("normalizeManualReview defaults source to manual_notes when no source_name", () => {
  const result = _test.normalizeManualReview({
    text: "Just a review.",
    title: "Title",
    author: "",
    date: "",
  });

  assert.equal(result.source_name, "");
  assert.equal(result.source, "manual_notes");
});

test("full pipeline: Grok output saves source_name to curated_reviews", async () => {
  const notes = [
    "Source: YouTube",
    "Author: Studio H",
    "URL: https://www.youtube.com/watch?v=9KNsKJgWnG0",
    "Title: Herbaria Soap Factory",
    "Date: Jun 19, 2024",
    "Text: Herbaria produces all-natural soaps using traditional methods.",
  ].join("\n");

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
    makeReq({ body: { mode: "append", dry_run: false } }),
    { log() {}, bindingData: { company_id: "company_1" } },
    { companiesContainer, nowIso: () => "2026-01-10T00:00:00.000Z" }
  );

  const body = JSON.parse(res.body);
  assert.equal(body.ok, true);
  assert.equal(body.saved_count, 1);

  const doc = companiesContainer._getDoc("company_1");
  assert.equal(doc.curated_reviews.length, 1);
  assert.equal(doc.curated_reviews[0].source_name, "YouTube");
  assert.equal(doc.curated_reviews[0].source, "YouTube");
  assert.equal(doc.curated_reviews[0].author, "Studio H");
  assert.equal(doc.curated_reviews[0].title, "Herbaria Soap Factory");
});
