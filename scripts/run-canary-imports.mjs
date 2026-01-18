import { createRequire } from "module";

const require = createRequire(import.meta.url);

const origLog = console.log;
const origWarn = console.warn;
const origError = console.error;

// Silence noisy handler logs; use origLog for our own output.
console.log = () => {};
console.warn = () => {};
console.error = () => {};

const { handler: importStartHandler } = require("../api/import-start/index.js");
const { _test: importStatusTest } = require("../api/import-status/index.js");
const importStatusHandler = importStatusTest.handler;

const cosmosPkg = await import("@azure/cosmos");
const CosmosClient = cosmosPkg.CosmosClient;

function makeReq(opts) {
  const url = opts && opts.url ? opts.url : "";
  const method = opts && opts.method ? opts.method : "GET";
  const json = opts && typeof opts.json === "function" ? opts.json : null;
  const headers = opts && opts.headers && typeof opts.headers === "object" ? opts.headers : null;

  const hdrs = new Headers();
  if (headers) {
    for (const k of Object.keys(headers)) {
      const v = headers[k];
      if (v === undefined || v === null) continue;
      hdrs.set(k, String(v));
    }
  }

  const req = { method, url, headers: hdrs };
  if (json) req.json = json;
  return req;
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

function pickSessionId(body) {
  return (
    (typeof body?.session_id === "string" && body.session_id.trim()) ||
    (typeof body?.sessionId === "string" && body.sessionId.trim()) ||
    (typeof body?.session === "string" && body.session.trim()) ||
    (typeof body?.result?.session_id === "string" && body.result.session_id.trim()) ||
    ""
  );
}

function summarizeStatus(body) {
  const stage = String(body?.stage_beacon || "").trim();
  const resumeNeeded = Boolean(body?.resume_needed);
  const resumeStatus = String(body?.resume?.status || "").trim();
  const values = body?.stage_beacon_values && typeof body.stage_beacon_values === "object" ? body.stage_beacon_values : {};

  const retryable = Number(values.status_resume_missing_retryable);
  const terminal = Number(values.status_resume_missing_terminal);

  const saved = Number.isFinite(Number(body?.saved)) ? Number(body.saved) : 0;
  const verified = Number.isFinite(Number(body?.saved_verified_count)) ? Number(body.saved_verified_count) : 0;

  return {
    stage,
    resumeNeeded,
    resumeStatus,
    retryableMissing: Number.isFinite(retryable) ? retryable : null,
    terminalMissing: Number.isFinite(terminal) ? terminal : null,
    saved,
    verified,
  };
}

function computeDelayMs(summary) {
  if (!summary) return 5000;
  if (summary.stage === "complete" && summary.resumeNeeded === false) return 0;

  // Match UI backoff for resume states
  if (
    summary.stage === "enrichment_resume_queued" ||
    summary.stage === "enrichment_resume_running" ||
    summary.stage === "enrichment_incomplete_retryable" ||
    summary.resumeStatus === "queued" ||
    summary.resumeStatus === "running"
  ) {
    return 30000;
  }

  return 8000;
}

async function fetchCompanyDocsByIds(ids) {
  const endpoint = String(process.env.COSMOS_DB_ENDPOINT || "").trim();
  const key = String(process.env.COSMOS_DB_KEY || "").trim();
  const databaseId = String(process.env.COSMOS_DB_DATABASE || "tabarnam-db").trim();
  const containerId = String(process.env.COSMOS_DB_COMPANIES_CONTAINER || "companies").trim();

  if (!endpoint || !key) throw new Error("Missing COSMOS_DB_ENDPOINT / COSMOS_DB_KEY env");

  const client = new CosmosClient({ endpoint, key });
  const container = client.database(databaseId).container(containerId);

  const seen = new Set();
  const clean = [];
  for (const raw of Array.isArray(ids) ? ids : []) {
    const value = String(raw || "").trim();
    if (!value) continue;
    const k = value.toLowerCase();
    if (seen.has(k)) continue;
    seen.add(k);
    clean.push(value);
    if (clean.length >= 10) break;
  }

  if (clean.length === 0) return [];

  const q = {
    query: "SELECT * FROM c WHERE ARRAY_CONTAINS(@ids, c.id)",
    parameters: [{ name: "@ids", value: clean }],
  };

  const result = await container.items.query(q, { enableCrossPartitionQuery: true }).fetchAll();
  return result && Array.isArray(result.resources) ? result.resources : [];
}

async function runCanary(url) {
  origLog("\n=== Canary import: " + url + " ===");

  const startBody = {
    query: url,
    queryTypes: ["company_url"],
    limit: 1,
    expand_if_few: true,
    dry_run: false,
  };

  const startReq = makeReq({
    url: "https://example.test/api/import/start",
    method: "POST",
    json: async () => startBody,
    headers: { "content-type": "application/json" },
  });

  const startRes = await importStartHandler(startReq, { log() {} });
  const startJson = JSON.parse(startRes.body);

  const sessionId = pickSessionId(startJson);
  if (!sessionId) {
    origLog("Start response (no session_id found):");
    origLog(JSON.stringify(startJson, null, 2).slice(0, 4000));
    throw new Error("Could not find session_id in import-start response");
  }

  origLog("session_id: " + sessionId);

  let lastStatus = null;
  const maxPolls = 40;

  for (let i = 0; i < maxPolls; i += 1) {
    const statusReq = makeReq({
      url: "https://example.test/api/import/status?session_id=" + encodeURIComponent(sessionId),
      method: "GET",
    });

    const statusRes = await importStatusHandler(statusReq, { log() {} });
    const body = JSON.parse(statusRes.body);

    const summary = summarizeStatus(body);
    lastStatus = body;

    const pollNum = String(i + 1).padStart(2, "0");
    origLog(
      "poll " +
        pollNum +
        ": stage=" +
        (summary.stage || "—") +
        " resume_needed=" +
        String(summary.resumeNeeded) +
        " resume.status=" +
        (summary.resumeStatus || "—") +
        " retryable=" +
        String(summary.retryableMissing ?? "—") +
        " terminal=" +
        String(summary.terminalMissing ?? "—") +
        " persisted=" +
        String(summary.saved) +
        " verified=" +
        String(summary.verified)
    );

    if (summary.stage === "complete" && summary.resumeNeeded === false) {
      origLog("Terminal complete reached.");
      break;
    }

    const delay = computeDelayMs(summary);
    await sleep(delay);
  }

  if (!lastStatus) throw new Error("No status response");

  const values = lastStatus?.stage_beacon_values && typeof lastStatus.stage_beacon_values === "object" ? lastStatus.stage_beacon_values : {};
  const retryable = Number(values.status_resume_missing_retryable);

  const okTerminal = String(lastStatus?.stage_beacon || "").trim() === "complete" && lastStatus?.resume_needed === false;
  const okRetryable = Number.isFinite(retryable) ? retryable === 0 : null;

  origLog(
    "Final: stage_beacon=" +
      String(lastStatus?.stage_beacon || "").trim() +
      " resume_needed=" +
      String(Boolean(lastStatus?.resume_needed)) +
      " status=" +
      String(lastStatus?.status || "").trim() +
      " retryableMissing=" +
      (Number.isFinite(retryable) ? String(retryable) : "—")
  );

  const ids = [];
  if (Array.isArray(lastStatus?.saved_company_ids_verified)) ids.push(...lastStatus.saved_company_ids_verified);
  if (Array.isArray(lastStatus?.saved_company_ids_unverified)) ids.push(...lastStatus.saved_company_ids_unverified);
  if (Array.isArray(lastStatus?.saved_companies) && lastStatus.saved_companies[0]?.company_id) ids.push(lastStatus.saved_companies[0].company_id);

  const docs = await fetchCompanyDocsByIds(ids).catch((e) => {
    origLog("Could not fetch company docs for inspection: " + (e?.message || String(e)));
    return [];
  });

  if (docs.length > 0) {
    const d = docs[0];
    const attempts = d?.import_low_quality_attempts && typeof d.import_low_quality_attempts === "object" ? d.import_low_quality_attempts : {};
    const reasons = d?.import_missing_reason && typeof d.import_missing_reason === "object" ? d.import_missing_reason : {};

    origLog("Company doc snapshot (first saved):");
    origLog(
      JSON.stringify(
        {
          id: d.id,
          website_url: d.website_url,
          industries: d.industries,
          industries_unknown: d.industries_unknown,
          import_missing_reason: {
            industries: reasons.industries,
            product_keywords: reasons.product_keywords,
            headquarters_location: reasons.headquarters_location,
            manufacturing_locations: reasons.manufacturing_locations,
            reviews: reasons.reviews,
          },
          import_low_quality_attempts: {
            industries: attempts.industries,
            product_keywords: attempts.product_keywords,
          },
          red_flag: d.red_flag,
          red_flag_reason: d.red_flag_reason,
        },
        null,
        2
      )
    );
  } else {
    origLog("No company docs found to inspect.");
  }

  return { okTerminal, okRetryable };
}

try {
  const r1 = await runCanary("https://davids-usa.com/");
  const r2 = await runCanary("https://www.dentalherb.com/");

  origLog("\n=== Canary summary ===");
  origLog({ davids: r1, dentalherb: r2 });
} finally {
  console.log = origLog;
  console.warn = origWarn;
  console.error = origError;
}
