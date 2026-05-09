// Phase 2.13.B — sharded xAI call lock tests.
//
// Verifies:
//   - Default concurrency = 1 (no env var set)
//   - XAI_CONCURRENCY env var is parsed safely (falls back to 1 on garbage)
//   - Single-shard mode preserves the legacy lock doc id
//   - N-shard mode produces "_xai_call_lock_{n}" doc ids
//   - Acquire walks all shards before backoff
//   - Release targets the correct shard via lockId hint

"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");

const {
  _test: {
    acquireXaiCallLock,
    releaseXaiCallLock,
    resolveXaiConcurrency,
    lockDocIdForShard,
    XAI_LOCK_DOC_ID,
    XAI_LOCK_PK_VALUE,
  },
} = require("./handler");

// ── Pure helpers ────────────────────────────────────────────────────────────

test("Phase 2.13.B: resolveXaiConcurrency defaults to 1 when env var unset", () => {
  const prev = process.env.XAI_CONCURRENCY;
  delete process.env.XAI_CONCURRENCY;
  try {
    assert.equal(resolveXaiConcurrency(), 1);
  } finally {
    if (prev === undefined) delete process.env.XAI_CONCURRENCY;
    else process.env.XAI_CONCURRENCY = prev;
  }
});

test("Phase 2.13.B: resolveXaiConcurrency parses positive integer values", () => {
  const prev = process.env.XAI_CONCURRENCY;
  try {
    process.env.XAI_CONCURRENCY = "2";
    assert.equal(resolveXaiConcurrency(), 2);
    process.env.XAI_CONCURRENCY = "5";
    assert.equal(resolveXaiConcurrency(), 5);
    // Hard ceiling at 8 prevents accidental overload.
    process.env.XAI_CONCURRENCY = "100";
    assert.equal(resolveXaiConcurrency(), 8);
  } finally {
    if (prev === undefined) delete process.env.XAI_CONCURRENCY;
    else process.env.XAI_CONCURRENCY = prev;
  }
});

test("Phase 2.13.B: resolveXaiConcurrency falls back to 1 on garbage / negative / zero", () => {
  const prev = process.env.XAI_CONCURRENCY;
  try {
    for (const v of ["", "abc", "0", "-1", "NaN", "  "]) {
      process.env.XAI_CONCURRENCY = v;
      assert.equal(resolveXaiConcurrency(), 1, `expected 1 for env=${JSON.stringify(v)}`);
    }
  } finally {
    if (prev === undefined) delete process.env.XAI_CONCURRENCY;
    else process.env.XAI_CONCURRENCY = prev;
  }
});

test("Phase 2.13.B: lockDocIdForShard preserves legacy id when concurrency=1", () => {
  // Backwards-compat: the existing production lock doc has id "_xai_call_lock"
  // exactly. Single-shard mode must continue to use this id so a flip from
  // single→sharded (or sharded→single) doesn't strand existing locks.
  assert.equal(lockDocIdForShard(0, 1), XAI_LOCK_DOC_ID);
  assert.equal(lockDocIdForShard(0, 1), "_xai_call_lock");
});

test("Phase 2.13.B: lockDocIdForShard produces per-shard ids when concurrency>1", () => {
  assert.equal(lockDocIdForShard(0, 2), "_xai_call_lock_0");
  assert.equal(lockDocIdForShard(1, 2), "_xai_call_lock_1");
  assert.equal(lockDocIdForShard(0, 4), "_xai_call_lock_0");
  assert.equal(lockDocIdForShard(3, 4), "_xai_call_lock_3");
});

// ── Mock Cosmos container ───────────────────────────────────────────────────

function makeMockContainer(initialDocs = {}) {
  // docs map: id → docObject. Mimics atomic-create-or-409 + read + delete.
  const docs = { ...initialDocs };
  const ops = [];

  return {
    docs,
    ops,
    items: {
      create: async (doc) => {
        ops.push({ op: "create", id: doc.id });
        if (docs[doc.id]) {
          const e = new Error("Conflict");
          e.code = 409;
          throw e;
        }
        docs[doc.id] = doc;
        return { resource: doc };
      },
    },
    item: (id, _pk) => ({
      read: async () => {
        ops.push({ op: "read", id });
        if (!docs[id]) {
          const e = new Error("Not found");
          e.code = 404;
          throw e;
        }
        return { resource: docs[id] };
      },
      delete: async () => {
        ops.push({ op: "delete", id });
        delete docs[id];
      },
    }),
  };
}

// ── Acquire/release behaviour ───────────────────────────────────────────────

test("Phase 2.13.B: acquire on empty container creates legacy doc when concurrency=1", async () => {
  const prev = process.env.XAI_CONCURRENCY;
  delete process.env.XAI_CONCURRENCY;
  try {
    const container = makeMockContainer();
    const result = await acquireXaiCallLock(container, "test-session", "test-co");
    assert.equal(result.acquired, true);
    assert.equal(result.lockId, XAI_LOCK_DOC_ID);
    assert.equal(result.shard, 0);
    assert.ok(container.docs[XAI_LOCK_DOC_ID], "lock doc must be created");
    assert.equal(container.docs[XAI_LOCK_DOC_ID].leaseId, result.leaseId);
  } finally {
    if (prev === undefined) delete process.env.XAI_CONCURRENCY;
    else process.env.XAI_CONCURRENCY = prev;
  }
});

test("Phase 2.13.B: acquire on empty container creates per-shard doc when concurrency=2", async () => {
  const prev = process.env.XAI_CONCURRENCY;
  process.env.XAI_CONCURRENCY = "2";
  try {
    const container = makeMockContainer();
    const result = await acquireXaiCallLock(container, "test-session", "test-co");
    assert.equal(result.acquired, true);
    // First shard tried in random order — could be 0 or 1
    assert.ok([0, 1].includes(result.shard));
    assert.ok(["_xai_call_lock_0", "_xai_call_lock_1"].includes(result.lockId));
    assert.ok(container.docs[result.lockId], "shard doc must be created");
  } finally {
    if (prev === undefined) delete process.env.XAI_CONCURRENCY;
    else process.env.XAI_CONCURRENCY = prev;
  }
});

test("Phase 2.13.B: acquire walks shards — picks the unheld one when one is held", async () => {
  const prev = process.env.XAI_CONCURRENCY;
  process.env.XAI_CONCURRENCY = "2";
  try {
    // Pre-seed shard 0 as held (active, not stale)
    const container = makeMockContainer({
      _xai_call_lock_0: {
        id: "_xai_call_lock_0",
        normalized_domain: XAI_LOCK_PK_VALUE,
        leaseId: "other-worker",
        sessionId: "other-session",
        companyId: "other-co",
        shard: 0,
        acquiredAt: new Date().toISOString(),
        expiresAt: new Date(Date.now() + 60_000).toISOString(),
      },
    });
    const result = await acquireXaiCallLock(container, "test-session", "test-co");
    assert.equal(result.acquired, true, "should acquire on the unheld shard");
    assert.equal(result.shard, 1, "should land on shard 1 since shard 0 is held");
    assert.equal(result.lockId, "_xai_call_lock_1");
    assert.ok(container.docs._xai_call_lock_0, "shard 0 must remain untouched");
    assert.ok(container.docs._xai_call_lock_1, "shard 1 doc must be created");
    // Two locks coexist — that's the point of N-shard concurrency.
    assert.equal(Object.keys(container.docs).length, 2);
  } finally {
    if (prev === undefined) delete process.env.XAI_CONCURRENCY;
    else process.env.XAI_CONCURRENCY = prev;
  }
});

test("Phase 2.13.B: acquire takes over a stale shard immediately", async () => {
  const prev = process.env.XAI_CONCURRENCY;
  process.env.XAI_CONCURRENCY = "2";
  try {
    // Pre-seed both shards: shard 0 stale, shard 1 active
    const container = makeMockContainer({
      _xai_call_lock_0: {
        id: "_xai_call_lock_0",
        normalized_domain: XAI_LOCK_PK_VALUE,
        leaseId: "stale-worker",
        sessionId: "dead-session",
        companyId: "dead-co",
        shard: 0,
        acquiredAt: new Date(Date.now() - 600_000).toISOString(),
        expiresAt: new Date(Date.now() - 60_000).toISOString(),  // expired 1 min ago
      },
      _xai_call_lock_1: {
        id: "_xai_call_lock_1",
        normalized_domain: XAI_LOCK_PK_VALUE,
        leaseId: "active-worker",
        sessionId: "live-session",
        companyId: "live-co",
        shard: 1,
        acquiredAt: new Date().toISOString(),
        expiresAt: new Date(Date.now() + 60_000).toISOString(),
      },
    });
    const result = await acquireXaiCallLock(container, "test-session", "test-co");
    assert.equal(result.acquired, true);
    // Stale-takeover path can land on shard 0 (after taking over) regardless
    // of which shard was tried first in the random rotation.
    assert.equal(result.shard, 0, "stale shard 0 must be taken over");
    assert.equal(container.docs._xai_call_lock_0.leaseId, result.leaseId, "shard 0 must hold our lease");
    assert.equal(container.docs._xai_call_lock_1.leaseId, "active-worker", "shard 1 must remain untouched");
  } finally {
    if (prev === undefined) delete process.env.XAI_CONCURRENCY;
    else process.env.XAI_CONCURRENCY = prev;
  }
});

test("Phase 2.13.B: release with lockId hint targets the correct shard doc", async () => {
  const prev = process.env.XAI_CONCURRENCY;
  process.env.XAI_CONCURRENCY = "3";
  try {
    const container = makeMockContainer();
    const result = await acquireXaiCallLock(container, "test-session", "test-co");
    assert.equal(result.acquired, true);
    const acquiredLockId = result.lockId;
    assert.ok(container.docs[acquiredLockId], "lock doc must exist after acquire");

    await releaseXaiCallLock(container, result.leaseId, "test-session", result.lockId);
    assert.equal(container.docs[acquiredLockId], undefined, "lock doc must be deleted after release");
  } finally {
    if (prev === undefined) delete process.env.XAI_CONCURRENCY;
    else process.env.XAI_CONCURRENCY = prev;
  }
});

test("Phase 2.13.B: release without lockId hint defaults to legacy doc (back-compat)", async () => {
  const prev = process.env.XAI_CONCURRENCY;
  delete process.env.XAI_CONCURRENCY;  // single-shard mode
  try {
    const container = makeMockContainer();
    const result = await acquireXaiCallLock(container, "test-session", "test-co");
    assert.equal(result.acquired, true);
    assert.equal(result.lockId, XAI_LOCK_DOC_ID);

    // Call release WITHOUT the lockId hint — should still find and delete the
    // legacy doc. This protects in-flight workers that acquired before the
    // sharded code shipped.
    await releaseXaiCallLock(container, result.leaseId, "test-session");
    assert.equal(container.docs[XAI_LOCK_DOC_ID], undefined);
  } finally {
    if (prev === undefined) delete process.env.XAI_CONCURRENCY;
    else process.env.XAI_CONCURRENCY = prev;
  }
});

test("Phase 2.13.B: release skips deletion when leaseId mismatches (stale-takeover protection)", async () => {
  const prev = process.env.XAI_CONCURRENCY;
  process.env.XAI_CONCURRENCY = "2";
  try {
    const container = makeMockContainer({
      _xai_call_lock_0: {
        id: "_xai_call_lock_0",
        normalized_domain: XAI_LOCK_PK_VALUE,
        leaseId: "new-holder",
        sessionId: "different-session",
        companyId: "different-co",
        shard: 0,
        acquiredAt: new Date().toISOString(),
        expiresAt: new Date(Date.now() + 60_000).toISOString(),
      },
    });
    // Try to release with our (stale) leaseId. Should NOT delete the new
    // holder's lock.
    await releaseXaiCallLock(container, "our-stale-lease", "test-session", "_xai_call_lock_0");
    assert.ok(container.docs._xai_call_lock_0, "new holder's lock must NOT be deleted");
    assert.equal(container.docs._xai_call_lock_0.leaseId, "new-holder");
  } finally {
    if (prev === undefined) delete process.env.XAI_CONCURRENCY;
    else process.env.XAI_CONCURRENCY = prev;
  }
});
