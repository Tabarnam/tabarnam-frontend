// Change 3 — verify the enrichment write-back preserves admin "unknown/limited
// manufacturing" and "unknown HQ" intent against the lost-update race: a worker holding a
// stale company snapshot (loaded before an admin edit) must not clobber the admin's flag.

"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");

const {
  _test: { preserveAdminFlagsForCompanyWrite },
} = require("./handler.js");

// Minimal in-memory Cosmos container that supports the point-read path the helper uses.
function makeMemoryContainer(seedDocs = []) {
  const store = new Map();
  for (const d of seedDocs) if (d && d.id) store.set(String(d.id), { ...d });

  return {
    // getCompaniesPkPath -> getContainerPartitionKeyPath reads this.
    read: async () => ({ resource: { partitionKey: { paths: ["/normalized_domain"] } } }),
    items: {
      upsert: async (doc) => {
        if (doc && typeof doc === "object" && doc.id != null) store.set(String(doc.id), { ...doc });
        return { statusCode: 200, resource: doc };
      },
    },
    item: (id) => ({
      read: async () => ({ resource: store.get(String(id)) }),
    }),
    _dump: () => Array.from(store.values()),
  };
}

test("preserveAdminFlagsForCompanyWrite: stale worker doc keeps admin unknown_manufacturing", async () => {
  const id = "company_stale_mfg";
  // Current persisted doc — admin marked it unknown after the worker loaded its snapshot.
  const current = {
    id,
    normalized_domain: "example.com",
    company_name: "Stale MFG Co",
    unknown_manufacturing: true,
    mfg_unknown: true,
    mfg_unknown_reason: "not_disclosed",
    manufacturing_locations_status: "not_disclosed",
    manufacturing_locations: [],
  };
  const container = makeMemoryContainer([current]);

  // Stale in-memory worker doc — loaded BEFORE the admin edit, flag absent.
  const staleDoc = {
    id,
    normalized_domain: "example.com",
    company_name: "Stale MFG Co",
    manufacturing_locations: [],
    mfg_unknown: false,
  };

  await preserveAdminFlagsForCompanyWrite(container, staleDoc);

  assert.equal(staleDoc.unknown_manufacturing, true);
  assert.equal(staleDoc.mfg_unknown, true);
  assert.equal(staleDoc.mfg_unknown_reason, "not_disclosed");
  assert.equal(staleDoc.manufacturing_locations_status, "not_disclosed");
  const missing = Array.isArray(staleDoc.import_missing_fields) ? staleDoc.import_missing_fields : [];
  assert.ok(!missing.includes("manufacturing_locations"));
});

test("preserveAdminFlagsForCompanyWrite: real enrichment data wins over the admin unknown flag", async () => {
  const id = "company_mfg_data_wins";
  const current = {
    id,
    normalized_domain: "example.com",
    company_name: "Data Wins Co",
    unknown_manufacturing: true,
    mfg_unknown: true,
    manufacturing_locations: [],
  };
  const container = makeMemoryContainer([current]);

  // The worker actually FOUND real manufacturing locations — these should be kept.
  const enrichedDoc = {
    id,
    normalized_domain: "example.com",
    company_name: "Data Wins Co",
    manufacturing_locations: [{ formatted: "Portland, OR, USA", lat: 45.51, lng: -122.68 }],
  };

  await preserveAdminFlagsForCompanyWrite(container, enrichedDoc);

  // Admin "unknown" must not override the freshly-discovered real data.
  assert.notEqual(enrichedDoc.unknown_manufacturing, true);
  assert.equal(enrichedDoc.manufacturing_locations.length, 1);
});

test("preserveAdminFlagsForCompanyWrite: HQ intent is preserved", async () => {
  const id = "company_stale_hq";
  const current = {
    id,
    normalized_domain: "example.com",
    company_name: "Stale HQ Co",
    unknown_hq: true,
    hq_unknown: true,
    hq_unknown_reason: "not_disclosed",
    headquarters_location_status: "not_disclosed",
    headquarters_locations: [],
  };
  const container = makeMemoryContainer([current]);

  const staleDoc = {
    id,
    normalized_domain: "example.com",
    company_name: "Stale HQ Co",
    headquarters_locations: [],
    hq_unknown: false,
  };

  await preserveAdminFlagsForCompanyWrite(container, staleDoc);

  assert.equal(staleDoc.unknown_hq, true);
  assert.equal(staleDoc.hq_unknown, true);
  assert.equal(staleDoc.hq_unknown_reason, "not_disclosed");
  const missing = Array.isArray(staleDoc.import_missing_fields) ? staleDoc.import_missing_fields : [];
  assert.ok(!missing.includes("headquarters_location"));
});

test("preserveAdminFlagsForCompanyWrite: doc not in store (e.g. control/job doc) is written unchanged", async () => {
  const container = makeMemoryContainer([]); // empty — point-read finds nothing
  const controlDoc = {
    id: "_resume_control_session123",
    type: "import_control",
    normalized_domain: "import",
  };
  const before = JSON.stringify(controlDoc);

  await preserveAdminFlagsForCompanyWrite(container, controlDoc);

  // No current doc found ⇒ no flags added, no recompute, doc untouched.
  assert.equal(JSON.stringify(controlDoc), before);
});
