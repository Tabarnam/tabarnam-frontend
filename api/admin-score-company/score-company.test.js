const test = require("node:test");
const assert = require("node:assert/strict");

const { _test } = require("./index.js");

// Memory container that simulates the read-after-write RACE that caused admin
// flags to be lost: the FIRST read (top of handler) returns a STALE doc missing
// the just-saved flags; the patch applies to the CURRENT stored doc (which has
// the flags); the re-read at the end sees the patched current doc.
function makeRaceContainer({ current, staleRead }) {
  const store = { doc: JSON.parse(JSON.stringify(current)) };
  let reads = 0;
  const applyPatch = (doc, ops) => {
    for (const op of ops) {
      const parts = op.path.split("/").filter(Boolean);
      let obj = doc;
      for (let i = 0; i < parts.length - 1; i++) {
        if (obj[parts[i]] == null || typeof obj[parts[i]] !== "object") obj[parts[i]] = {};
        obj = obj[parts[i]];
      }
      obj[parts[parts.length - 1]] = op.value;
    }
    return doc;
  };
  return {
    item() {
      return {
        async read() {
          reads++;
          const src = reads === 1 ? staleRead : store.doc; // 1st = stale (race), re-read = fresh
          return { resource: JSON.parse(JSON.stringify(src)) };
        },
        async patch(ops) { applyPatch(store.doc, ops); return { resource: store.doc }; },
      };
    },
    items: {
      async upsert(doc) { store.doc = JSON.parse(JSON.stringify(doc)); return { resource: doc }; },
    },
    _current() { return store.doc; },
  };
}

test("admin-score-company: rescore preserves admin flags even when the top read is stale", async () => {
  const id = "company_race";
  const domain = "race.com";

  // The real, current stored doc — admin just set these flags via Save & Close.
  const current = {
    id, company_id: id, company_name: "Race Co", normalized_domain: domain,
    unknown_manufacturing: true, no_amazon_store: true, amazon_url_approved: true,
    rating: { star1: { value: 0 }, star2: { value: 0.5 }, star4: { value: 0.25 }, star5: { value: 0.25 } },
  };
  // What the rescore's read() races into seeing: the pre-save copy WITHOUT the flags.
  const staleRead = {
    id, company_id: id, company_name: "Race Co", normalized_domain: domain,
    rating: { star4: { value: 0.25 }, star5: { value: 0.25 } },
  };

  const container = makeRaceContainer({ current, staleRead });
  const computeScores = async () => ({
    ok: true, reputation_score: 4.2, reputation_reasoning: "rep", quality_score: 3.8, quality_reasoning: "qual",
    skipped_xai_call: false,
  });
  const req = { method: "POST", json: async () => ({ company_id: id, normalized_domain: domain, force: true }) };

  const res = await _test.adminScoreCompanyHandler(req, { log() {} }, { container, computeScores });
  const body = JSON.parse(res.body);
  assert.equal(res.status, 200);
  assert.equal(body.ok, true);

  const stored = container._current();
  // The whole point: a full-doc upsert of the stale read would have dropped these.
  // The field-scoped patch preserves them.
  assert.equal(stored.unknown_manufacturing, true, "unknown_manufacturing preserved");
  assert.equal(stored.no_amazon_store, true, "no_amazon_store preserved");
  assert.equal(stored.amazon_url_approved, true, "amazon_url_approved preserved");
  assert.equal(stored.rating.star2.value, 0.5, "concurrently-saved star2 preserved");
  // New scores landed.
  assert.equal(stored.rating.star4.value, 4.2, "star4 updated");
  assert.equal(stored.rating.star5.value, 3.8, "star5 updated");
  // Response echoes the fresh doc (flags intact) so the UI row isn't reverted.
  assert.equal(body.company.unknown_manufacturing, true, "response company has flags");
  assert.equal(body.company.rating.star4.value, 4.2, "response company has new star4");
});

test("admin-score-company: creates /rating then sets stars when the doc had none", async () => {
  const id = "company_norating";
  const domain = "norating.com";
  const current = { id, company_id: id, company_name: "NoRating Co", normalized_domain: domain, no_amazon_store: true };
  const staleRead = { id, company_id: id, company_name: "NoRating Co", normalized_domain: domain };

  const container = makeRaceContainer({ current, staleRead });
  const computeScores = async () => ({ ok: true, reputation_score: 3.0, reputation_reasoning: "r", quality_score: 2.5, quality_reasoning: "q", skipped_xai_call: false });
  const req = { method: "POST", json: async () => ({ company_id: id, normalized_domain: domain, force: true }) };

  const res = await _test.adminScoreCompanyHandler(req, { log() {} }, { container, computeScores });
  assert.equal(res.status, 200);
  const stored = container._current();
  assert.equal(stored.no_amazon_store, true, "flag preserved on a doc that had no rating");
  assert.equal(stored.rating.star4.value, 3.0);
  assert.equal(stored.rating.star5.value, 2.5);
});
