"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");

const { _test } = require("./index.js");

// Attribution on the editor write path.
//
// This path never stamped owner/imported_by, so every company added through
// the admin editor landed unattributed — which makes it invisible to any
// owner-scoped view of the catalog. These tests pin the contract:
//
//   CREATE  — stamp from the authenticated identity, unless the caller supplied
//             an explicit value (admins assign owner deliberately on create).
//   UPDATE  — never stamp. Back-filling attribution on edit would misattribute
//             the existing unattributed rows to whoever edits them next.
//
// Deliberate owner reassignment through the editor (an explicit owner in the
// payload on PUT) must keep working — that is the only supported way to move a
// company between people.

function makeReq({ method = "GET", url, query, json, adminEmail } = {}) {
  const req = {
    method,
    url: url || "https://example.test/api/xadmin-api-companies",
    headers: new Headers(),
    query: query || {},
  };

  if (typeof json === "function") req.json = json;
  if (adminEmail) req.__admin_email = adminEmail;

  return req;
}

function makeMemoryContainer() {
  const store = new Map();

  function getParam(spec, name) {
    const params = Array.isArray(spec?.parameters) ? spec.parameters : [];
    const found = params.find((p) => p && p.name === name);
    return found ? found.value : undefined;
  }

  function runQuery(spec) {
    const sql = String(spec?.query || "");

    if (sql.includes("WHERE c.id = @id")) {
      const doc = store.get(String(getParam(spec, "@id") || "")) || null;
      return doc ? [doc] : [];
    }

    // Domain dedup probe on POST — no pre-existing rows by domain in these tests.
    if (sql.includes("c.normalized_domain = @domain")) return [];

    return [];
  }

  return {
    items: {
      query(spec) {
        return { fetchAll: async () => ({ resources: runQuery(spec) }) };
      },
      async upsert(doc) {
        store.set(String(doc.id), JSON.parse(JSON.stringify(doc)));
        return { resource: store.get(String(doc.id)) };
      },
      async create(doc) {
        store.set(String(doc.id), JSON.parse(JSON.stringify(doc)));
        return { resource: store.get(String(doc.id)) };
      },
    },
    item() {
      return { async delete() {}, async read() { return { resource: null }; } };
    },
    _dump: () => Array.from(store.values()),
    _get: (id) => store.get(String(id)) || null,
  };
}

async function createCompany(container, { id, adminEmail, body = {} }) {
  return _test.adminCompaniesHandler(
    makeReq({
      method: "POST",
      adminEmail,
      json: async () => ({
        id,
        company_id: id,
        company_name: "Attribution Co",
        name: "Attribution Co",
        website_url: "https://attribution-co.example",
        ...body,
      }),
    }),
    { log() {} },
    { container }
  );
}

async function updateCompany(container, { id, adminEmail, body = {} }) {
  return _test.adminCompaniesHandler(
    makeReq({
      method: "PUT",
      adminEmail,
      url: `https://example.test/api/xadmin-api-companies/${encodeURIComponent(id)}`,
      json: async () => ({
        id,
        company_id: id,
        company_name: "Attribution Co",
        name: "Attribution Co",
        website_url: "https://attribution-co.example",
        ...body,
      }),
    }),
    { log() {}, bindingData: { id } },
    { container }
  );
}

test("create: stamps owner and imported_by from the authenticated identity", async () => {
  const container = makeMemoryContainer();
  const id = "company_attr_create";

  const res = await createCompany(container, { id, adminEmail: "kels@tabarnam.com" });
  assert.equal(res.status, 200);

  const stored = container._get(id);
  assert.ok(stored, "company was persisted");
  assert.equal(stored.imported_by, "kels@tabarnam.com");
  assert.equal(stored.owner, "kels@tabarnam.com");
  assert.ok(stored.imported_by_at, "imported_by_at is set alongside imported_by");
});

test("create: lowercases the authenticated identity", async () => {
  const container = makeMemoryContainer();
  const id = "company_attr_case";

  await createCompany(container, { id, adminEmail: "Ben@Tabarnam.com" });

  const stored = container._get(id);
  assert.equal(stored.imported_by, "ben@tabarnam.com");
  assert.equal(stored.owner, "ben@tabarnam.com");
});

test("create: an explicit owner in the payload wins over the caller", async () => {
  const container = makeMemoryContainer();
  const id = "company_attr_explicit_owner";

  await createCompany(container, {
    id,
    adminEmail: "jon@tabarnam.com",
    body: { owner: "kels@tabarnam.com" },
  });

  const stored = container._get(id);
  // Jon created it on Kels's behalf: Kels owns the work, Jon is the importer.
  assert.equal(stored.owner, "kels@tabarnam.com");
  assert.equal(stored.imported_by, "jon@tabarnam.com");
});

test("create: owner falls back to imported_by when only imported_by is supplied", async () => {
  const container = makeMemoryContainer();
  const id = "company_attr_carried_importer";

  await createCompany(container, {
    id,
    adminEmail: "jon@tabarnam.com",
    body: { imported_by: "ben@tabarnam.com" },
  });

  const stored = container._get(id);
  assert.equal(stored.imported_by, "ben@tabarnam.com");
  assert.equal(stored.owner, "ben@tabarnam.com");
});

test("create: no authenticated identity leaves attribution null, not undefined", async () => {
  const container = makeMemoryContainer();
  const id = "company_attr_internal";

  // Internal job / dev bypass: the guard attaches no email.
  await createCompany(container, { id });

  const stored = container._get(id);
  assert.equal(stored.imported_by, null);
  assert.equal(stored.owner, null);
  assert.equal(stored.imported_by_at, null);
});

test("update: does NOT back-fill attribution on an unattributed legacy row", async () => {
  const container = makeMemoryContainer();
  const id = "company_attr_legacy";

  // A legacy row that predates attribution — no owner, no imported_by.
  await container.items.upsert({
    id,
    company_id: id,
    company_name: "Legacy Co",
    name: "Legacy Co",
    website_url: "https://attribution-co.example",
    normalized_domain: "attribution-co.example",
  });

  const res = await updateCompany(container, {
    id,
    adminEmail: "ben@tabarnam.com",
    body: { company_name: "Legacy Co Renamed" },
  });
  assert.equal(res.status, 200);

  const stored = container._get(id);
  assert.equal(stored.company_name, "Legacy Co Renamed", "the edit still applied");
  assert.ok(!stored.owner, "editing must not silently claim ownership");
  assert.ok(!stored.imported_by, "imported_by stays empty on a legacy row");
});

test("update: preserves existing attribution when the payload omits it", async () => {
  const container = makeMemoryContainer();
  const id = "company_attr_preserve";

  await createCompany(container, { id, adminEmail: "kels@tabarnam.com" });
  await updateCompany(container, { id, adminEmail: "ben@tabarnam.com", body: { name: "Renamed" } });

  const stored = container._get(id);
  assert.equal(stored.owner, "kels@tabarnam.com", "a different admin editing does not take ownership");
  assert.equal(stored.imported_by, "kels@tabarnam.com");
});

test("update: an explicit owner still reassigns (the supported handoff path)", async () => {
  const container = makeMemoryContainer();
  const id = "company_attr_reassign";

  await createCompany(container, { id, adminEmail: "jon@tabarnam.com" });
  await updateCompany(container, {
    id,
    adminEmail: "jon@tabarnam.com",
    body: { owner: "kels@tabarnam.com" },
  });

  const stored = container._get(id);
  assert.equal(stored.owner, "kels@tabarnam.com", "reassignment through the editor still works");
  assert.equal(stored.imported_by, "jon@tabarnam.com", "imported_by is immutable provenance");
});
