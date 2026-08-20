// The function is reached two ways and has to agree with itself on which page
// was asked for:
//   - through the SWA rewrite, where the visitor's URL survives only in the
//     x-ms-original-url header (req.url says /api/made-in-page/...)
//   - directly, as /api/made-in-page/<slug>[/<state>], where the route params
//     carry it
// Getting this wrong renders the wrong place, or silently renders the country
// directory for every URL.
const test = require("node:test");
const assert = require("node:assert/strict");

const { originalPath } = require("./index.js");

function req({ headers = {}, params = {} } = {}) {
  return { headers: new Map(Object.entries(headers)), params };
}

test("prefers the visitor's original URL from the SWA rewrite header", () => {
  assert.equal(
    originalPath(req({ headers: { "x-ms-original-url": "https://tabarnam.com/made-in/usa" } })),
    "/made-in/usa"
  );
  assert.equal(
    originalPath(
      req({ headers: { "x-ms-original-url": "https://tabarnam.com/made-in/usa/california?x=1" } })
    ),
    "/made-in/usa/california"
  );
});

test("the header wins over route params when both are present", () => {
  const r = req({
    headers: { "x-ms-original-url": "https://tabarnam.com/made-in/italy" },
    params: { slug: "usa" },
  });
  assert.equal(originalPath(r), "/made-in/italy");
});

test("falls back to route params for direct calls", () => {
  assert.equal(originalPath(req({ params: { slug: "usa" } })), "/made-in/usa");
  assert.equal(
    originalPath(req({ params: { slug: "usa", state: "california" } })),
    "/made-in/usa/california"
  );
});

test("no header and no params is the country directory", () => {
  assert.equal(originalPath(req()), "/made-in");
  assert.equal(originalPath(req({ params: { slug: "", state: "" } })), "/made-in");
});

test("a state param without a slug cannot forge a bare /made-in/<state>", () => {
  // Only reachable if the route table changed underneath us; the join must
  // still produce a path resolvePath can reject rather than a plausible one.
  assert.equal(originalPath(req({ params: { state: "california" } })), "/made-in/california");
});

test("a malformed original-url header falls through instead of throwing", () => {
  const r = req({ headers: { "x-ms-original-url": "::::" }, params: { slug: "usa" } });
  assert.equal(originalPath(r), "/made-in/usa");
});

test("reads plain-object headers too (local dev has no Headers instance)", () => {
  const r = { headers: { "x-ms-original-url": "https://tabarnam.com/made-in/japan" }, params: {} };
  assert.equal(originalPath(r), "/made-in/japan");
});
