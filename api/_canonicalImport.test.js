// _canonicalImport.test.js
// Phase 2 — verify runCanonicalImportCall returns the same shape as
// runDirectEnrichment, classifies fields correctly, and handles the
// transport / parse-failure paths cleanly.

"use strict";

const { test } = require("node:test");
const assert = require("node:assert/strict");
const path = require("node:path");

// ── Pure-helper tests (no mocking needed) ────────────────────────────────────

const {
  shapeEnrichedFromParsed,
  classifyFields,
  buildResponseFormat,
} = require("./_canonicalImport");

test("shapeEnrichedFromParsed returns canonical defaults for null/undefined input", () => {
  for (const input of [null, undefined, {}]) {
    const out = shapeEnrichedFromParsed(input);
    assert.equal(out.tagline, "");
    assert.equal(out.headquarters_location, "");
    assert.deepEqual(out.manufacturing_locations, []);
    assert.deepEqual(out.industries, []);
    assert.equal(out.product_keywords, "");
    assert.deepEqual(out.reviews, []);
    assert.deepEqual(out.location_source_urls, { hq_source_urls: [], mfg_source_urls: [] });
    assert.equal(out.red_flag, false);
    assert.deepEqual(out.social, {});
  }
});

test("shapeEnrichedFromParsed preserves valid full payload", () => {
  const parsed = {
    tagline: "We make things",
    headquarters_location: "Austin, TX, USA",
    manufacturing_locations: ["Austin, TX, USA"],
    industries: ["Specialty Foods"],
    product_keywords: "jerky, dried meats",
    reviews: [
      { source: "Mag", author: "X", url: "https://x.example.com", title: "T", date: "D", text: "Good." },
    ],
    location_source_urls: { hq_source_urls: ["https://a"], mfg_source_urls: ["https://b"] },
    red_flag: true,
    social: { linkedin: "https://linkedin.com/x" },
  };
  const out = shapeEnrichedFromParsed(parsed);
  assert.equal(out.tagline, parsed.tagline);
  assert.deepEqual(out.industries, parsed.industries);
  assert.equal(out.red_flag, true);
  assert.deepEqual(out.location_source_urls, parsed.location_source_urls);
  assert.deepEqual(out.social, parsed.social);
});

test("shapeEnrichedFromParsed coerces non-array fields to empty arrays defensively", () => {
  const parsed = {
    manufacturing_locations: "not an array",
    industries: null,
    reviews: undefined,
    location_source_urls: { hq_source_urls: "bad", mfg_source_urls: ["ok"] },
  };
  const out = shapeEnrichedFromParsed(parsed);
  assert.deepEqual(out.manufacturing_locations, []);
  assert.deepEqual(out.industries, []);
  assert.deepEqual(out.reviews, []);
  assert.deepEqual(out.location_source_urls.hq_source_urls, []);
  assert.deepEqual(out.location_source_urls.mfg_source_urls, ["ok"]);
});

// ── classifyFields ──────────────────────────────────────────────────────────

test("classifyFields treats non-empty values as completed", () => {
  const enriched = {
    tagline: "x",
    headquarters_location: "Austin, TX, USA",
    industries: ["Foo"],
    product_keywords: "a, b, c",
    manufacturing_locations: ["Site 1"],
    reviews: [{ source: "X" }],
  };
  const fields = ["tagline", "headquarters_location", "industries", "product_keywords", "manufacturing_locations", "reviews"];
  const result = classifyFields(fields, enriched);
  assert.deepEqual(result.fields_completed, fields);
  assert.deepEqual(result.fields_failed, []);
  assert.deepEqual(result.errors, {});
});

test("classifyFields treats empty strings, empty arrays as not_found failures", () => {
  const enriched = {
    tagline: "",
    headquarters_location: "   ",
    industries: [],
    product_keywords: "valid string",
    manufacturing_locations: [],
    reviews: [],
  };
  const fields = ["tagline", "headquarters_location", "industries", "product_keywords", "manufacturing_locations", "reviews"];
  const result = classifyFields(fields, enriched);
  assert.deepEqual(result.fields_completed, ["product_keywords"]);
  assert.deepEqual(result.fields_failed, ["tagline", "headquarters_location", "industries", "manufacturing_locations", "reviews"]);
  for (const f of result.fields_failed) {
    assert.equal(result.errors[f], "not_found");
  }
});

test("classifyFields handles partial subset request", () => {
  const enriched = { tagline: "x", headquarters_location: "" };
  const result = classifyFields(["tagline", "headquarters_location"], enriched);
  assert.deepEqual(result.fields_completed, ["tagline"]);
  assert.deepEqual(result.fields_failed, ["headquarters_location"]);
});

// ── buildResponseFormat ─────────────────────────────────────────────────────

test("buildResponseFormat returns strict json_schema declaration", () => {
  const rf = buildResponseFormat();
  assert.equal(rf.type, "json_schema");
  assert.equal(rf.json_schema.name, "company_research");
  assert.equal(rf.json_schema.strict, true);
  assert.ok(rf.json_schema.schema, "schema must be present");
  assert.equal(rf.json_schema.schema.type, "object");
  assert.ok(rf.json_schema.schema.required.includes("tagline"));
  assert.ok(rf.json_schema.schema.required.includes("headquarters_location"));
  assert.equal(rf.json_schema.schema.additionalProperties, false);
});

// ── End-to-end runCanonicalImportCall via cache-injected mocks ──────────────
//
// Inject a fake _xaiLiveSearch module BEFORE _canonicalImport is required so
// the test exercises the real runCanonicalImportCall logic against
// deterministic upstream responses. node:test runs subtests in the same
// process; we clear the require cache for both modules between scenarios.

const liveSearchPath = require.resolve("./_xaiLiveSearch");
const canonicalPath = require.resolve("./_canonicalImport");

function withMockLiveSearch(stub, fn) {
  const original = require.cache[liveSearchPath];
  delete require.cache[canonicalPath];
  require.cache[liveSearchPath] = {
    id: liveSearchPath,
    filename: liveSearchPath,
    loaded: true,
    exports: {
      xaiLiveSearch: stub.xaiLiveSearch || (async () => ({ ok: false, error: "no_stub" })),
      xaiLiveSearchStreaming:
        stub.xaiLiveSearchStreaming || (async () => ({ ok: false, error: "no_stub" })),
      extractTextFromXaiResponse:
        stub.extractTextFromXaiResponse || ((resp) => resp?.text || ""),
    },
  };
  try {
    const reloaded = require("./_canonicalImport");
    return fn(reloaded);
  } finally {
    delete require.cache[canonicalPath];
    if (original) require.cache[liveSearchPath] = original;
    else delete require.cache[liveSearchPath];
  }
}

test("runCanonicalImportCall: success path returns runDirectEnrichment-shape result", async () => {
  await withMockLiveSearch(
    {
      xaiLiveSearchStreaming: async () => ({
        ok: true,
        resp: {
          text: JSON.stringify({
            tagline: "We make things",
            headquarters_location: "Austin, TX, USA",
            manufacturing_locations: ["Austin, TX, USA"],
            industries: ["Specialty Foods", "Snack Foods"],
            product_keywords: "jerky, dried meats",
            reviews: [
              {
                source: "Foodie Mag",
                author: "J. Smith",
                url: "https://foodiemag.example.com/r",
                title: "Reviewed",
                date: "2026-01-15",
                text: "Crunchy.",
              },
            ],
            location_source_urls: { hq_source_urls: ["https://a"], mfg_source_urls: ["https://b"] },
            red_flag: false,
          }),
        },
        diagnostics: { tool_calls_counted: 3, upstream_http_status: 200 },
      }),
    },
    async (mod) => {
      const result = await mod.runCanonicalImportCall({
        company: { company_name: "Acme", url: "https://acme.example.com" },
        sessionId: "test-session",
        budgetMs: 60_000,
        fieldsToEnrich: ["tagline", "headquarters_location", "manufacturing_locations", "industries", "product_keywords", "reviews"],
      });

      // Output contract — same shape runDirectEnrichment returns.
      assert.equal(result.ok, true);
      assert.deepEqual(result.fields_completed.sort(), [
        "headquarters_location",
        "industries",
        "manufacturing_locations",
        "product_keywords",
        "reviews",
        "tagline",
      ]);
      assert.deepEqual(result.fields_failed, []);
      assert.deepEqual(result.errors, {});

      // Enriched values map back to the parsed JSON.
      assert.equal(result.enriched.tagline, "We make things");
      assert.equal(result.enriched.headquarters_location, "Austin, TX, USA");
      assert.deepEqual(result.enriched.industries, ["Specialty Foods", "Snack Foods"]);

      // Diagnostics carry telemetry the worker writes to import_diagnostics.
      assert.equal(result.diagnostics.canonical_call, true);
      assert.equal(result.diagnostics.tool_calls_counted, 3);
      assert.match(result.diagnostics.guidance_version, /^7\./);
      assert.ok(result.elapsed_ms >= 0);
    }
  );
});

test("runCanonicalImportCall: partial fields → some completed, some not_found", async () => {
  await withMockLiveSearch(
    {
      xaiLiveSearchStreaming: async () => ({
        ok: true,
        resp: {
          text: JSON.stringify({
            tagline: "Some tagline",
            headquarters_location: "", // model couldn't verify
            manufacturing_locations: [],
            industries: ["Industry A"],
            product_keywords: "",
            reviews: [],
            location_source_urls: { hq_source_urls: [], mfg_source_urls: [] },
            red_flag: false,
          }),
        },
        diagnostics: { tool_calls_counted: 5 },
      }),
    },
    async (mod) => {
      const result = await mod.runCanonicalImportCall({
        company: { company_name: "Acme", url: "https://acme.example.com" },
        sessionId: "test",
        budgetMs: 60_000,
        fieldsToEnrich: ["tagline", "headquarters_location", "industries", "product_keywords"],
      });

      assert.equal(result.ok, true, "ok=true when at least one field completed");
      assert.deepEqual(result.fields_completed.sort(), ["industries", "tagline"]);
      assert.deepEqual(result.fields_failed.sort(), ["headquarters_location", "product_keywords"]);
      assert.equal(result.errors.headquarters_location, "not_found");
      assert.equal(result.errors.product_keywords, "not_found");
    }
  );
});

test("runCanonicalImportCall: transport failure returns shaped failure with all fields failed", async () => {
  await withMockLiveSearch(
    {
      xaiLiveSearchStreaming: async () => ({
        ok: false,
        error: "upstream_http_503",
        error_code: "upstream_503_cooldown",
        diagnostics: { upstream_http_status: 503 },
      }),
    },
    async (mod) => {
      const result = await mod.runCanonicalImportCall({
        company: { company_name: "Acme", url: "https://acme.example.com" },
        sessionId: "test",
        budgetMs: 60_000,
        fieldsToEnrich: ["tagline", "industries"],
      });

      assert.equal(result.ok, false);
      assert.deepEqual(result.fields_completed, []);
      assert.deepEqual(result.fields_failed, ["tagline", "industries"]);
      assert.equal(result.errors.tagline, "upstream_503_cooldown");
      assert.equal(result.errors.industries, "upstream_503_cooldown");
      assert.deepEqual(result.enriched, {});
      assert.equal(result.diagnostics.upstream_status, 503);
    }
  );
});

test("runCanonicalImportCall: unparseable response returns failure with text preview", async () => {
  await withMockLiveSearch(
    {
      xaiLiveSearchStreaming: async () => ({
        ok: true,
        resp: { text: "Sorry, I am unable to provide a response." },
        diagnostics: { tool_calls_counted: 1 },
      }),
    },
    async (mod) => {
      const result = await mod.runCanonicalImportCall({
        company: { company_name: "Acme", url: "https://acme.example.com" },
        sessionId: "test",
        budgetMs: 60_000,
        fieldsToEnrich: ["tagline"],
      });

      assert.equal(result.ok, false);
      assert.equal(result.errors.tagline, "unparseable_json");
      assert.ok(result.diagnostics.unparseable_text_preview);
    }
  );
});

test("runCanonicalImportCall: streaming returns null → falls back to xaiLiveSearch (non-streaming)", async () => {
  let nonStreamingCalled = false;
  await withMockLiveSearch(
    {
      xaiLiveSearchStreaming: async () => null, // signal /chat/completions endpoint
      xaiLiveSearch: async () => {
        nonStreamingCalled = true;
        return {
          ok: true,
          resp: {
            text: JSON.stringify({
              tagline: "fallback",
              headquarters_location: "Austin, TX, USA",
              manufacturing_locations: [],
              industries: [],
              product_keywords: "",
              reviews: [],
              location_source_urls: { hq_source_urls: [], mfg_source_urls: [] },
              red_flag: false,
            }),
          },
          diagnostics: { tool_calls_counted: 0 },
        };
      },
    },
    async (mod) => {
      const result = await mod.runCanonicalImportCall({
        company: { company_name: "Acme", url: "https://acme.example.com" },
        sessionId: "test",
        budgetMs: 60_000,
        fieldsToEnrich: ["tagline"],
      });
      assert.equal(nonStreamingCalled, true, "fallback must invoke xaiLiveSearch when streaming returns null");
      assert.equal(result.ok, true);
      assert.equal(result.enriched.tagline, "fallback");
    }
  );
});

test("runCanonicalImportCall: onIntermediateSave fires with verified fields when at least one succeeds", async () => {
  let saved = null;
  await withMockLiveSearch(
    {
      xaiLiveSearchStreaming: async () => ({
        ok: true,
        resp: {
          text: JSON.stringify({
            tagline: "ok",
            headquarters_location: "",
            manufacturing_locations: [],
            industries: [],
            product_keywords: "",
            reviews: [],
            location_source_urls: { hq_source_urls: [], mfg_source_urls: [] },
            red_flag: false,
          }),
        },
        diagnostics: {},
      }),
    },
    async (mod) => {
      await mod.runCanonicalImportCall({
        company: { company_name: "Acme", url: "https://acme.example.com" },
        sessionId: "test",
        budgetMs: 60_000,
        fieldsToEnrich: ["tagline", "industries"],
        onIntermediateSave: async (verified) => { saved = verified; },
      });
      assert.ok(saved, "intermediate save callback must fire when fields_completed > 0");
      assert.equal(saved.tagline, "ok");
      assert.equal(saved.red_flag, false);
      assert.ok(saved.location_source_urls);
    }
  );
});

test("runCanonicalImportCall: onIntermediateSave does NOT fire when zero fields completed", async () => {
  let saveCalled = false;
  await withMockLiveSearch(
    {
      xaiLiveSearchStreaming: async () => ({
        ok: true,
        resp: {
          text: JSON.stringify({
            tagline: "",
            headquarters_location: "",
            manufacturing_locations: [],
            industries: [],
            product_keywords: "",
            reviews: [],
            location_source_urls: { hq_source_urls: [], mfg_source_urls: [] },
            red_flag: false,
          }),
        },
        diagnostics: {},
      }),
    },
    async (mod) => {
      await mod.runCanonicalImportCall({
        company: { company_name: "Acme", url: "https://acme.example.com" },
        sessionId: "test",
        budgetMs: 60_000,
        fieldsToEnrich: ["tagline"],
        onIntermediateSave: async () => { saveCalled = true; },
      });
      assert.equal(saveCalled, false, "intermediate save must NOT fire when nothing completed");
    }
  );
});

test("runCanonicalImportCall: streaming throws → returns shaped failure (non-fatal)", async () => {
  await withMockLiveSearch(
    {
      xaiLiveSearchStreaming: async () => { throw new Error("boom"); },
    },
    async (mod) => {
      const result = await mod.runCanonicalImportCall({
        company: { company_name: "Acme", url: "https://acme.example.com" },
        sessionId: "test",
        budgetMs: 60_000,
        fieldsToEnrich: ["tagline"],
      });
      assert.equal(result.ok, false);
      assert.equal(result.errors.tagline, "upstream_unreachable");
      assert.match(result.diagnostics.stream_threw, /boom/);
    }
  );
});

// ── Source-level guard: handler.js wires the dispatcher correctly ───────────

test("resume-worker handler.js declares the XAI_SINGLE_CALL_MODE dispatcher", () => {
  const fs = require("node:fs");
  const handlerPath = path.join(__dirname, "import", "resume-worker", "handler.js");
  const src = fs.readFileSync(handlerPath, "utf8");
  assert.ok(src.includes("XAI_SINGLE_CALL_MODE"), "dispatcher env var must be referenced");
  assert.ok(src.includes("runCanonicalImportCall"), "canonical entry must be invoked");
  assert.ok(
    src.includes(`require("../../_canonicalImport")`) || src.includes(`require('../../_canonicalImport')`),
    "_canonicalImport module must be imported by the handler"
  );
});

// ── Phase 2.1 — diagnostic logging surface ──────────────────────────────────
//
// Source-level guards that the diagnostic logs are wired in. Without these
// log lines we cannot post-hoc determine which path ran or why a call
// failed. The 2026-05-08 production failure (model went 22 tool calls,
// emitted 0 text) was diagnosable only because of these logs.

test("Phase 2.1: handler.js logs dispatcher_decision unconditionally", () => {
  const fs = require("node:fs");
  const handlerPath = path.join(__dirname, "import", "resume-worker", "handler.js");
  const src = fs.readFileSync(handlerPath, "utf8");
  assert.ok(src.includes("[resume-worker] dispatcher_decision"), "dispatcher_decision log must exist");
  assert.ok(src.includes("XAI_SINGLE_CALL_MODE_raw"), "must log raw env var value");
  assert.ok(src.includes("XAI_SINGLE_CALL_MODE_resolved"), "must log resolved boolean");
  assert.ok(src.includes("[resume-worker] enrich_result_summary"), "enrich_result_summary log must exist");
  assert.ok(
    src.includes("doc.import_diagnostics ="),
    "handler must persist enrichResult.diagnostics to the doc as import_diagnostics"
  );
});

test("Phase 2.1: _canonicalImport.js logs call_start, upstream_returned, parsed_ok", () => {
  const fs = require("node:fs");
  const canonicalPath = path.join(__dirname, "_canonicalImport.js");
  const src = fs.readFileSync(canonicalPath, "utf8");
  assert.ok(src.includes("[canonicalImport] call_start"), "call_start log must exist");
  assert.ok(src.includes("[canonicalImport] upstream_returned"), "upstream_returned log must exist");
  assert.ok(src.includes("[canonicalImport] parsed_ok"), "parsed_ok log must exist");
  assert.ok(src.includes("[canonicalImport] streaming_threw"), "streaming_threw error log must exist");
  assert.ok(src.includes("[canonicalImport] non_streaming_threw"), "non_streaming_threw error log must exist");
  assert.ok(src.includes("[canonicalImport] unparseable_json"), "unparseable_json warn log must exist");
  assert.ok(
    src.includes("text_chars:") && src.includes("text_preview:"),
    "upstream_returned must include text_chars and text_preview for diagnosing tool-loop-no-text failure"
  );
  assert.ok(
    src.includes("tool_cap_aborted"),
    "diagnostics must surface tool_cap_aborted so we can correlate failures with cap behavior"
  );
});

test("Phase 2.1: _xaiLiveSearch.js logs payload_summary + text milestones", () => {
  const fs = require("node:fs");
  const livePath = path.join(__dirname, "_xaiLiveSearch.js");
  const src = fs.readFileSync(livePath, "utf8");
  assert.ok(src.includes("[xaiLiveSearchStreaming] payload_summary"), "payload_summary log must exist");
  assert.ok(src.includes("[xaiLiveSearchStreaming] first_text_arrived"), "first_text_arrived milestone must exist");
  assert.ok(src.includes("[xaiLiveSearchStreaming] text_milestone"), "text_milestone log must exist");
  assert.ok(src.includes("[xaiLiveSearchStreaming] response.completed received"), "response.completed log must exist");
  assert.ok(src.includes("response_format_strict"), "payload_summary must surface strict json_schema flag");
  assert.ok(src.includes("response_format_schema_required_count"), "payload_summary must surface schema required count");
});

test("Phase 2.1: runCanonicalImportCall result diagnostics include mode + tool_cap_aborted + text_chars", async () => {
  await withMockLiveSearch(
    {
      xaiLiveSearchStreaming: async () => ({
        ok: true,
        resp: {
          text: JSON.stringify({
            tagline: "x",
            headquarters_location: "Austin, TX, USA",
            manufacturing_locations: [],
            industries: [],
            product_keywords: "",
            reviews: [],
            location_source_urls: { hq_source_urls: [], mfg_source_urls: [] },
            red_flag: false,
          }),
        },
        diagnostics: { tool_calls_counted: 4, upstream_http_status: 200, tool_cap_aborted: false, streaming: true },
      }),
    },
    async (mod) => {
      const result = await mod.runCanonicalImportCall({
        company: { company_name: "Acme", url: "https://acme.example.com" },
        sessionId: "test",
        budgetMs: 60_000,
        fieldsToEnrich: ["tagline", "headquarters_location"],
      });
      assert.equal(result.diagnostics.mode, "streaming");
      assert.equal(result.diagnostics.tool_cap_aborted, false);
      assert.ok(typeof result.diagnostics.text_chars === "number");
      assert.equal(result.diagnostics.canonical_call, true);
    }
  );
});

test("Phase 2.2: response_format is NOT sent by default (root-cause fix for 2026-05-08 tool-loop failure)", async () => {
  // Save and clear the env override so we test the default path.
  const prev = process.env.XAI_USE_RESPONSE_FORMAT;
  delete process.env.XAI_USE_RESPONSE_FORMAT;

  let capturedPayload = null;
  try {
    await withMockLiveSearch(
      {
        xaiLiveSearchStreaming: async (opts) => {
          capturedPayload = opts;
          return {
            ok: true,
            resp: {
              text: JSON.stringify({
                tagline: "x",
                headquarters_location: "Austin, TX, USA",
                manufacturing_locations: [],
                industries: [],
                product_keywords: "",
                reviews: [],
                location_source_urls: { hq_source_urls: [], mfg_source_urls: [] },
                red_flag: false,
              }),
            },
            diagnostics: { tool_calls_counted: 4 },
          };
        },
      },
      async (mod) => {
        await mod.runCanonicalImportCall({
          company: { company_name: "Acme", url: "https://acme.example.com" },
          sessionId: "test",
          budgetMs: 60_000,
          fieldsToEnrich: ["tagline"],
        });
      }
    );

    assert.ok(capturedPayload, "streaming was invoked");
    assert.equal(
      capturedPayload.response_format,
      undefined,
      "response_format must be undefined by default — strict json_schema with tools causes Grok-4 to loop and emit no text"
    );
  } finally {
    if (prev === undefined) delete process.env.XAI_USE_RESPONSE_FORMAT;
    else process.env.XAI_USE_RESPONSE_FORMAT = prev;
  }
});

test("Phase 2.2: response_format IS sent when XAI_USE_RESPONSE_FORMAT=on (env-var override)", async () => {
  const prev = process.env.XAI_USE_RESPONSE_FORMAT;
  process.env.XAI_USE_RESPONSE_FORMAT = "on";

  let capturedPayload = null;
  try {
    await withMockLiveSearch(
      {
        xaiLiveSearchStreaming: async (opts) => {
          capturedPayload = opts;
          return {
            ok: true,
            resp: { text: JSON.stringify({ tagline: "x", headquarters_location: "", manufacturing_locations: [], industries: [], product_keywords: "", reviews: [], location_source_urls: { hq_source_urls: [], mfg_source_urls: [] }, red_flag: false }) },
            diagnostics: {},
          };
        },
      },
      async (mod) => {
        await mod.runCanonicalImportCall({
          company: { company_name: "Acme", url: "https://acme.example.com" },
          sessionId: "test",
          budgetMs: 60_000,
          fieldsToEnrich: ["tagline"],
        });
      }
    );
    assert.ok(capturedPayload?.response_format, "response_format must be present when override is on");
    assert.equal(capturedPayload.response_format.type, "json_schema");
    assert.equal(capturedPayload.response_format.json_schema.strict, true);
  } finally {
    if (prev === undefined) delete process.env.XAI_USE_RESPONSE_FORMAT;
    else process.env.XAI_USE_RESPONSE_FORMAT = prev;
  }
});

test("Phase 2.1: canonical failure result surfaces tool_cap_aborted + text preview (replicates 2026-05-08 prod failure)", async () => {
  await withMockLiveSearch(
    {
      xaiLiveSearchStreaming: async () => ({
        ok: false,
        error: "tool_cap_abort_no_text",
        error_code: "tool_cap_abort",
        diagnostics: {
          upstream_http_status: 200,
          tool_calls_counted: 22,
          tool_cap_aborted: true,
          streaming: true,
          text_length: 0,
        },
      }),
    },
    async (mod) => {
      const result = await mod.runCanonicalImportCall({
        company: { company_name: "Acme", url: "https://acme.example.com" },
        sessionId: "test",
        budgetMs: 60_000,
        fieldsToEnrich: ["tagline"],
      });
      assert.equal(result.ok, false);
      assert.equal(result.errors.tagline, "tool_cap_abort");
      assert.equal(result.diagnostics.tool_cap_aborted, true);
      assert.equal(result.diagnostics.tool_calls_counted, 22);
      assert.ok("text_chars" in result.diagnostics, "text_chars must be in failure diagnostics");
    }
  );
});
