const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const {
  INDEXNOW_KEY,
  KEY_LOCATION,
  MAX_URLS,
  isEnabled,
  normalizeUrls,
  submitUrls,
  companyUrl,
  submitCompanySlugs,
} = require("./_indexNow");

const QUIET = { log() {} };

/** Runs `fn` with INDEXNOW_ENABLED set, then restores whatever was there. */
function withEnabled(value, fn) {
  const prev = process.env.INDEXNOW_ENABLED;
  process.env.INDEXNOW_ENABLED = value;
  return (async () => {
    try {
      return await fn();
    } finally {
      if (prev === undefined) delete process.env.INDEXNOW_ENABLED;
      else process.env.INDEXNOW_ENABLED = prev;
    }
  })();
}

test("the published key file matches the key we submit", () => {
  // A rotation that changes one and not the other fails every submission with
  // a 422, and nothing else in the system would notice.
  const file = path.join(__dirname, "..", "public", `${INDEXNOW_KEY}.txt`);
  assert.ok(fs.existsSync(file), `missing key file: public/${INDEXNOW_KEY}.txt`);
  assert.equal(fs.readFileSync(file, "utf8").trim(), INDEXNOW_KEY);
  assert.equal(KEY_LOCATION, `https://tabarnam.com/${INDEXNOW_KEY}.txt`);
  assert.match(INDEXNOW_KEY, /^[a-f0-9]{8,128}$/, "key must be hex, 8-128 chars");
});

test("the key file is excluded from the SPA fallback", () => {
  // Without this SWA serves index.html at the key URL, the key check fails,
  // and every submission is rejected. See the note in _indexNow.js.
  const config = JSON.parse(
    fs.readFileSync(path.join(__dirname, "..", "public", "staticwebapp.config.json"), "utf8")
  );
  assert.ok(
    config.navigationFallback.exclude.includes(`/${INDEXNOW_KEY}.txt`),
    "add the key file to navigationFallback.exclude"
  );
});

test("off by default — a deploy alone never pings anything", async () => {
  const prev = process.env.INDEXNOW_ENABLED;
  delete process.env.INDEXNOW_ENABLED;
  try {
    assert.equal(isEnabled(), false);
    let called = false;
    const res = await submitUrls(["/company/acme"], {
      logger: QUIET,
      fetchImpl: () => { called = true; },
    });
    assert.equal(called, false);
    assert.equal(res.submitted, 0);
    assert.match(res.skipped, /INDEXNOW_ENABLED/);
  } finally {
    if (prev === undefined) delete process.env.INDEXNOW_ENABLED;
    else process.env.INDEXNOW_ENABLED = prev;
  }
});

test("normalizeUrls absolutizes, dedupes, and drops anything off-host", () => {
  const urls = normalizeUrls([
    "/company/acme",
    "company/borealis",
    "https://tabarnam.com/company/acme",
    "https://tabarnam.com/company/acme?utm=x",
    "https://evil.example.com/company/acme",
    "http://tabarnam.com/company/cyclo",
    "",
    null,
    42,
  ]);
  // One bad URL makes IndexNow reject the whole submission, so off-host and
  // non-https entries are dropped rather than sent.
  assert.deepEqual(urls, [
    "https://tabarnam.com/company/acme",
    "https://tabarnam.com/company/borealis",
  ]);
});

test("normalizeUrls stops at the protocol's per-request ceiling", () => {
  const many = Array.from({ length: MAX_URLS + 250 }, (_, i) => `/company/c-${i}`);
  assert.equal(normalizeUrls(many).length, MAX_URLS);
});

test("a submission posts the documented body", async () => {
  await withEnabled("true", async () => {
    let seen = null;
    const res = await submitUrls(["/company/acme", "/company/borealis"], {
      logger: QUIET,
      fetchImpl: async (url, opts) => {
        seen = { url, opts };
        return { status: 200 };
      },
    });
    assert.equal(res.ok, true);
    assert.equal(res.submitted, 2);
    assert.equal(seen.url, "https://api.indexnow.org/indexnow");
    assert.equal(seen.opts.method, "POST");
    const body = JSON.parse(seen.opts.body);
    assert.equal(body.host, "tabarnam.com");
    assert.equal(body.key, INDEXNOW_KEY);
    assert.equal(body.keyLocation, KEY_LOCATION);
    assert.deepEqual(body.urlList, [
      "https://tabarnam.com/company/acme",
      "https://tabarnam.com/company/borealis",
    ]);
  });
});

test("202 counts as accepted", async () => {
  await withEnabled("on", async () => {
    const res = await submitUrls(["/company/acme"], { logger: QUIET, fetchImpl: async () => ({ status: 202 }) });
    assert.equal(res.ok, true);
    assert.equal(res.submitted, 1);
  });
});

test("a rejected key reports the status rather than counting a success", async () => {
  await withEnabled("1", async () => {
    const res = await submitUrls(["/company/acme"], { logger: QUIET, fetchImpl: async () => ({ status: 422 }) });
    assert.equal(res.ok, false);
    assert.equal(res.submitted, 0);
    assert.equal(res.status, 422);
  });
});

test("a network failure never escapes — an import must not fail on this", async () => {
  await withEnabled("true", async () => {
    const res = await submitUrls(["/company/acme"], {
      logger: QUIET,
      fetchImpl: async () => { throw new Error("socket hang up"); },
    });
    assert.equal(res.ok, false);
    assert.equal(res.submitted, 0);
    assert.equal(res.error, "socket hang up");
  });
});

test("an empty slug list short-circuits before any network call", async () => {
  await withEnabled("true", async () => {
    let called = false;
    const fetchImpl = () => { called = true; };
    for (const input of [[], null, undefined, [""], [null]]) {
      const res = await submitCompanySlugs(input, { logger: QUIET, fetchImpl });
      assert.equal(res.submitted, 0);
    }
    assert.equal(called, false);
  });
});

test("submitCompanySlugs maps slugs onto canonical company URLs", async () => {
  await withEnabled("true", async () => {
    let body = null;
    await submitCompanySlugs(["acme", "topo-athletic"], {
      logger: QUIET,
      fetchImpl: async (_url, opts) => { body = JSON.parse(opts.body); return { status: 200 }; },
    });
    assert.deepEqual(body.urlList, [
      "https://tabarnam.com/company/acme",
      "https://tabarnam.com/company/topo-athletic",
    ]);
  });
  assert.equal(companyUrl("acme"), "https://tabarnam.com/company/acme");
  assert.equal(companyUrl("  "), null);
});
