// Phase 4.35 — tests for the Recent Activity endpoint helpers.
//
// Like other endpoint tests in this repo, we stub the `_app` registration
// so requiring the module doesn't try to bind a real route, then exercise
// the exported `_test.handleGet`/`handlePost`/`projectRow` helpers.

const test = require("node:test");
const assert = require("node:assert");

// Stub `_app` before the endpoint file requires it.
require.cache[require.resolve("./_app")] = {
  id: require.resolve("./_app"),
  filename: require.resolve("./_app"),
  loaded: true,
  exports: { app: { http: () => {} }, hasRoute: () => false },
};

const mod = require("./xadmin-api-recent-activity");
const { projectRow, ALLOWED_SUMMARY_ACTIONS } = mod._test;

test("Phase 4.35: ALLOWED_SUMMARY_ACTIONS holds exactly the two summary action types", () => {
  // Lock the contract — any new summary action must be added intentionally
  // here AND in the frontend renderer's switch in RecentActivityPanel.jsx.
  assert.deepStrictEqual(
    [...ALLOWED_SUMMARY_ACTIONS].sort(),
    ["apply_batch_fields_summary", "bulk_import_summary"].sort()
  );
});

test("Phase 4.35: projectRow strips diff payload and exposes summary/company_id", () => {
  // Batch summary row.
  const summaryRow = projectRow({
    id: "audit_batch_abc",
    company_id: "_batch_summary",
    action: "bulk_import_summary",
    created_at: "2026-06-07T20:00:00.000Z",
    actor_email: "admin@example.com",
    actor_user_id: "user-1",
    source: "admin-ui",
    request_id: "req-1",
    batch_id: "batch-1",
    summary: { count: 20, first: "Adox", last: "Shanghai" },
    // Anything else (e.g. a stray diff) is ignored — projectRow whitelists.
    diff: { tagline: { before: "x", after: "y" } },
  });
  assert.strictEqual(summaryRow.action, "bulk_import_summary");
  assert.strictEqual(summaryRow.company_id, null, "_batch_summary sentinel is hidden in projection");
  assert.deepStrictEqual(summaryRow.summary, { count: 20, first: "Adox", last: "Shanghai" });
  assert.strictEqual(summaryRow.batch_id, "batch-1");
  assert.strictEqual(summaryRow.actor_email, "admin@example.com");
  assert.deepStrictEqual(summaryRow.changed_fields, []);
  // projectRow must not leak the raw diff into the global feed projection.
  assert.strictEqual(summaryRow.diff, undefined);
});

test("Phase 4.35: projectRow surfaces company_id and changed_fields for per-company rows", () => {
  const perCompanyRow = projectRow({
    id: "audit_company_1_xyz",
    company_id: "company_1",
    action: "update",
    created_at: "2026-06-07T20:05:00.000Z",
    actor_email: "admin@example.com",
    actor_user_id: "user-1",
    changed_fields: ["tagline", "industries"],
    diff: {
      tagline: { before: "old", after: "new" },
      industries: { before: ["a"], after: ["a", "b"] },
    },
  });
  assert.strictEqual(perCompanyRow.company_id, "company_1");
  assert.strictEqual(perCompanyRow.action, "update");
  assert.deepStrictEqual(perCompanyRow.changed_fields, ["tagline", "industries"]);
  assert.strictEqual(perCompanyRow.summary, null);
  assert.strictEqual(perCompanyRow.diff, undefined, "per-company diff must not appear in global feed");
});

test("Phase 4.35: projectRow tolerates malformed input", () => {
  assert.strictEqual(projectRow(null), null);
  assert.strictEqual(projectRow(undefined), null);
  assert.strictEqual(projectRow("string"), null);
  assert.strictEqual(projectRow(42), null);

  // Object with all fields missing — every output field has a safe default.
  const empty = projectRow({});
  assert.ok(empty);
  assert.strictEqual(empty.id, "");
  assert.strictEqual(empty.action, "");
  assert.strictEqual(empty.summary, null);
  assert.deepStrictEqual(empty.changed_fields, []);
});

test("Phase 4.35: handlePost rejects unknown actions", async () => {
  const { handlePost } = mod._test;
  const fakeReq = {
    headers: { get: () => "" },
    json: async () => ({ action: "delete_everything", summary: {} }),
  };
  const res = await handlePost(fakeReq, { log: () => {} });
  assert.strictEqual(res.status, 400);
  const body = JSON.parse(res.body);
  assert.strictEqual(body.ok, false);
  assert.match(body.error, /must be one of/);
});

test("Phase 4.35: handlePost rejects missing/empty action", async () => {
  const { handlePost } = mod._test;
  const fakeReq = {
    headers: { get: () => "" },
    json: async () => ({ summary: {} }),
  };
  const res = await handlePost(fakeReq, { log: () => {} });
  assert.strictEqual(res.status, 400);
  const body = JSON.parse(res.body);
  assert.strictEqual(body.ok, false);
});

test("Phase 4.35: handleGet returns 503 when Cosmos is not configured", async () => {
  // The test harness sets no COSMOS_DB_ENDPOINT, so the container helper
  // returns null. handleGet should fail cleanly with 503 — not throw.
  const { handleGet } = mod._test;
  const fakeReq = { query: {}, headers: { get: () => "" } };
  const res = await handleGet(fakeReq, { log: () => {} });
  assert.strictEqual(res.status, 503);
  const body = JSON.parse(res.body);
  assert.strictEqual(body.ok, false);
  assert.deepStrictEqual(body.items, []);
});
