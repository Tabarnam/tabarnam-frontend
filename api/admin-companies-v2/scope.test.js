"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");

const { _test } = require("./index.js");

// Contributor row scoping — the security boundary for the role.
//
// Everything here asserts one of two things:
//   1. A contributor cannot reach a row they do not own, by ANY verb.
//   2. An admin's behavior is completely unchanged.
//
// Refusals answer 404, never 403: "you may not touch this" and "this does not
// exist" must be indistinguishable, or the endpoint becomes an existence oracle
// over the whole catalog.

const DANA = "dana@tabarnam.com";
const JON = "jon@tabarnam.com";

function makeReq({ method = "GET", url, query, json, role, actorEmail } = {}) {
  const req = {
    method,
    url: url || "https://example.test/api/xadmin-api-companies",
    headers: new Headers(),
    query: query || {},
  };

  if (typeof json === "function") req.json = json;

  // What withContributorGuard attaches once the caller clears the guard.
  if (role) req.__role = role;
  if (actorEmail) {
    req.__actor_email = actorEmail;
    req.__admin_email = actorEmail;
  }

  return req;
}

const asContributor = (over = {}) => ({ role: "contributor", actorEmail: DANA, ...over });
const asAdmin = (over = {}) => ({ role: "admin", actorEmail: JON, ...over });

function makeMemoryContainer(seed = []) {
  const store = new Map();
  for (const doc of seed) store.set(String(doc.id), JSON.parse(JSON.stringify(doc)));

  function getParam(spec, name) {
    const params = Array.isArray(spec?.parameters) ? spec.parameters : [];
    const found = params.find((p) => p && p.name === name);
    return found ? found.value : undefined;
  }

  function runQuery(spec) {
    const sql = String(spec?.query || "");
    const scopeOwner = getParam(spec, "@scope_owner");
    const personOwner = getParam(spec, "@person_owner");

    if (sql.includes("WHERE c.id = @id")) {
      const doc = store.get(String(getParam(spec, "@id") || "")) || null;
      if (!doc) return [];
      if (sql.includes("c.is_deleted != true") && doc.is_deleted === true) return [];
      // Honour the scope predicate the handler injected.
      if (scopeOwner !== undefined && String(doc.owner || "").toLowerCase() !== scopeOwner) {
        return [];
      }
      return [doc];
    }

    if (sql.includes("c.normalized_domain = @domain")) return [];

    // List query. Applies whichever owner predicate the handler built: the
    // forced contributor scope, or an admin's opt-in ?owner= filter.
    let rows = Array.from(store.values()).filter((d) => d.is_deleted !== true);

    if (scopeOwner !== undefined) {
      rows = rows.filter((d) => String(d.owner || "").toLowerCase() === scopeOwner);
    } else if (personOwner !== undefined) {
      rows = rows.filter((d) => String(d.owner || "").toLowerCase() === personOwner);
    } else if (sql.includes("NOT IS_DEFINED(c.owner)")) {
      rows = rows.filter((d) => !String(d.owner || "").trim());
    }

    return rows;
  }

  return {
    items: {
      query(spec) {
        return {
          fetchAll: async () => ({ resources: runQuery(spec) }),
          _spec: spec,
        };
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
    item(id) {
      return {
        async delete() {
          store.delete(String(id));
        },
        async replace(doc) {
          store.set(String(doc.id), JSON.parse(JSON.stringify(doc)));
          return { resource: doc };
        },
        async read() {
          return { resource: store.get(String(id)) || null };
        },
      };
    },
    _dump: () => Array.from(store.values()),
    _get: (id) => store.get(String(id)) || null,
  };
}

const OWNED = {
  id: "company_owned_by_dana",
  company_id: "company_owned_by_dana",
  company_name: "Dana Co",
  name: "Dana Co",
  website_url: "https://dana-co.example",
  normalized_domain: "dana-co.example",
  owner: DANA,
  imported_by: JON,
};

const OTHERS = {
  id: "company_owned_by_jon",
  company_id: "company_owned_by_jon",
  company_name: "Jon Co",
  name: "Jon Co",
  website_url: "https://jon-co.example",
  normalized_domain: "jon-co.example",
  owner: JON,
  imported_by: JON,
};

function seeded() {
  return makeMemoryContainer([OWNED, OTHERS]);
}

const call = (container, req, ctxExtra = {}) =>
  _test.adminCompaniesHandler(req, { log() {}, ...ctxExtra }, { container });

// The list response carries rows under `items`.
function listIds(res) {
  const body = JSON.parse(res.body);
  return (body.items || body.companies || []).map((c) => c.id);
}

// ── Reads ───────────────────────────────────────────────────────────

test("GET single: a contributor can read a company they own", async () => {
  const res = await call(
    seeded(),
    makeReq({ ...asContributor(), url: `https://x.test/api/xadmin-api-companies/${OWNED.id}` }),
    { bindingData: { id: OWNED.id } }
  );

  assert.equal(res.status, 200);
  assert.equal(JSON.parse(res.body).company?.id, OWNED.id);
});

test("GET single: a company owned by someone else is 404, not 403", async () => {
  const res = await call(
    seeded(),
    makeReq({ ...asContributor(), url: `https://x.test/api/xadmin-api-companies/${OTHERS.id}` }),
    { bindingData: { id: OTHERS.id } }
  );

  assert.equal(res.status, 404, "403 would confirm the company exists");
});

test("GET single: an admin still reads anything", async () => {
  const res = await call(
    seeded(),
    makeReq({ ...asAdmin(), url: `https://x.test/api/xadmin-api-companies/${OTHERS.id}` }),
    { bindingData: { id: OTHERS.id } }
  );

  assert.equal(res.status, 200);
});

test("GET list: a contributor sees only their own rows", async () => {
  const res = await call(seeded(), makeReq(asContributor()));
  assert.deepEqual(listIds(res), [OWNED.id]);
});

test("GET list: ?owner= from the client cannot widen the scope", async () => {
  const res = await call(seeded(), makeReq({ ...asContributor(), query: { owner: JON } }));
  assert.deepEqual(listIds(res), [OWNED.id], "the forced scope must ignore the query param");
});

test("GET list: ?owner=__none__ cannot surface unattributed rows", async () => {
  const container = makeMemoryContainer([
    OWNED,
    { ...OTHERS, owner: undefined, imported_by: undefined },
  ]);

  const res = await call(container, makeReq({ ...asContributor(), query: { owner: "__none__" } }));
  assert.deepEqual(listIds(res), [OWNED.id]);
});

test("GET list: an admin's ?owner= filter still works", async () => {
  const res = await call(seeded(), makeReq({ ...asAdmin(), query: { owner: JON } }));
  assert.deepEqual(listIds(res), [OTHERS.id]);
});

// ── Writes ──────────────────────────────────────────────────────────

test("PUT: a contributor can edit a company they own", async () => {
  const container = seeded();

  const res = await call(
    container,
    makeReq({
      ...asContributor(),
      method: "PUT",
      url: `https://x.test/api/xadmin-api-companies/${OWNED.id}`,
      json: async () => ({ id: OWNED.id, company_name: "Dana Co", name: "Dana Co Renamed", website_url: OWNED.website_url }),
    }),
    { bindingData: { id: OWNED.id } }
  );

  assert.equal(res.status, 200);
  assert.equal(container._get(OWNED.id).name, "Dana Co Renamed");
});

test("PUT: editing someone else's company is 404 and changes nothing", async () => {
  const container = seeded();

  const res = await call(
    container,
    makeReq({
      ...asContributor(),
      method: "PUT",
      url: `https://x.test/api/xadmin-api-companies/${OTHERS.id}`,
      json: async () => ({ id: OTHERS.id, company_name: "Hijacked", name: "Hijacked", website_url: OTHERS.website_url }),
    }),
    { bindingData: { id: OTHERS.id } }
  );

  assert.equal(res.status, 404);
  assert.equal(container._get(OTHERS.id).company_name, "Jon Co", "the row must be untouched");
});

test("PUT: a contributor cannot reassign owner on a row they own", async () => {
  const container = seeded();

  await call(
    container,
    makeReq({
      ...asContributor(),
      method: "PUT",
      url: `https://x.test/api/xadmin-api-companies/${OWNED.id}`,
      json: async () => ({ id: OWNED.id, company_name: "Dana Co", website_url: OWNED.website_url, owner: JON }),
    }),
    { bindingData: { id: OWNED.id } }
  );

  assert.equal(container._get(OWNED.id).owner, DANA, "owner is not a field they may write");
});

test("PUT: a contributor cannot rewrite imported_by provenance", async () => {
  const container = seeded();

  await call(
    container,
    makeReq({
      ...asContributor(),
      method: "PUT",
      url: `https://x.test/api/xadmin-api-companies/${OWNED.id}`,
      json: async () => ({ id: OWNED.id, company_name: "Dana Co", website_url: OWNED.website_url, imported_by: DANA }),
    }),
    { bindingData: { id: OWNED.id } }
  );

  assert.equal(container._get(OWNED.id).imported_by, JON);
});

test("PUT: a contributor cannot flip is_deleted directly", async () => {
  const container = seeded();

  await call(
    container,
    makeReq({
      ...asContributor(),
      method: "PUT",
      url: `https://x.test/api/xadmin-api-companies/${OWNED.id}`,
      json: async () => ({ id: OWNED.id, company_name: "Dana Co", website_url: OWNED.website_url, is_deleted: true }),
    }),
    { bindingData: { id: OWNED.id } }
  );

  assert.notEqual(container._get(OWNED.id).is_deleted, true);
});

test("PUT: no create-via-PUT for a contributor", async () => {
  const container = seeded();

  const res = await call(
    container,
    makeReq({
      ...asContributor(),
      method: "PUT",
      url: "https://x.test/api/xadmin-api-companies/company_brand_new",
      json: async () => ({ id: "company_brand_new", company_name: "New", website_url: "https://new.example" }),
    }),
    { bindingData: { id: "company_brand_new" } }
  );

  assert.equal(res.status, 404);
  assert.equal(container._get("company_brand_new"), null);
});

test("PUT: an admin can still reassign owner (the supported handoff)", async () => {
  const container = seeded();

  await call(
    container,
    makeReq({
      ...asAdmin(),
      method: "PUT",
      url: `https://x.test/api/xadmin-api-companies/${OTHERS.id}`,
      json: async () => ({ id: OTHERS.id, company_name: "Jon Co", website_url: OTHERS.website_url, owner: DANA }),
    }),
    { bindingData: { id: OTHERS.id } }
  );

  assert.equal(container._get(OTHERS.id).owner, DANA);
});

// ── Create ──────────────────────────────────────────────────────────

test("POST: a contributor may create, and the row is owned by them", async () => {
  const container = seeded();

  const res = await call(
    container,
    makeReq({
      ...asContributor(),
      method: "POST",
      json: async () => ({ company_name: "Fresh Co", name: "Fresh Co", website_url: "https://fresh.example" }),
    })
  );

  assert.equal(res.status, 200);

  const created = container._dump().find((d) => d.company_name === "Fresh Co");
  assert.ok(created, "the company was created");
  assert.equal(created.owner, DANA);
  assert.equal(created.imported_by, DANA);
});

test("POST: a contributor cannot choose the id and overwrite an existing company", async () => {
  const container = seeded();

  await call(
    container,
    makeReq({
      ...asContributor(),
      method: "POST",
      json: async () => ({
        id: OTHERS.id,
        company_id: OTHERS.id,
        company_name: "Overwritten",
        website_url: "https://evil.example",
      }),
    })
  );

  const victim = container._get(OTHERS.id);
  assert.equal(victim.company_name, "Jon Co", "the targeted row must survive intact");
  assert.equal(victim.owner, JON);
});

test("POST: a contributor cannot pre-set owner to someone else", async () => {
  const container = seeded();

  await call(
    container,
    makeReq({
      ...asContributor(),
      method: "POST",
      json: async () => ({ company_name: "Gifted Co", website_url: "https://gifted.example", owner: JON }),
    })
  );

  const created = container._dump().find((d) => d.company_name === "Gifted Co");
  assert.equal(created.owner, DANA);
});

// ── Delete ──────────────────────────────────────────────────────────

test("DELETE: a contributor can soft-delete a company they own", async () => {
  const container = seeded();

  const res = await call(
    container,
    makeReq({
      ...asContributor(),
      method: "DELETE",
      url: `https://x.test/api/xadmin-api-companies/${OWNED.id}`,
      json: async () => ({}),
    }),
    { bindingData: { id: OWNED.id } }
  );

  assert.equal(res.status, 200);
  assert.equal(container._get(OWNED.id).is_deleted, true, "soft, not hard — the row still exists");
});

test("DELETE: deleting someone else's company is 404 and leaves it alive", async () => {
  const container = seeded();

  const res = await call(
    container,
    makeReq({
      ...asContributor(),
      method: "DELETE",
      url: `https://x.test/api/xadmin-api-companies/${OTHERS.id}`,
      json: async () => ({}),
    }),
    { bindingData: { id: OTHERS.id } }
  );

  assert.equal(res.status, 404);
  assert.notEqual(container._get(OTHERS.id).is_deleted, true);
});

// ── Fail-closed ─────────────────────────────────────────────────────

test("a contributor with no resolvable identity gets nothing, not everything", async () => {
  const req = makeReq({ role: "contributor" }); // role attached, email missing
  const res = await call(seeded(), req);

  assert.equal(res.status, 403);
});
