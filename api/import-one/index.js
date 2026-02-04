let app;
try {
  ({ app } = require("../_app"));
} catch {
  app = { http() {} };
}

let CosmosClient;
try {
  ({ CosmosClient } = require("@azure/cosmos"));
} catch {
  CosmosClient = null;
}

const { getBuildInfo } = require("../_buildInfo");

// Build stamp for deployment verification - helps identify which code version is running in production
// Now uses shared getBuildInfo instead of hardcoded value
function getBuildStamp() {
  try {
    const info = getBuildInfo();
    return info.build_id || "unknown";
  } catch {
    return process.env.GIT_SHA || "unknown";
  }
}

const { randomUUID } = require("crypto");
const { upsertSession: upsertImportSession } = require("../_importSessionStore");
const { buildPrimaryJobId: buildImportPrimaryJobId, upsertJob: upsertImportPrimaryJob, getJob: getImportPrimaryJob } = require("../_importPrimaryJobStore");
const { runPrimaryJob } = require("../_importPrimaryWorker");
const { getSession: getImportSession } = require("../_importSessionStore");
const { enqueueResumeRun } = require("../_enrichmentQueue");
const { invokeResumeWorkerInProcess } = require("../import/resume-worker/handler");

// Helper to extract normalized domain from URL
function toNormalizedDomain(urlStr) {
  const s = String(urlStr || "").trim();
  if (!s) return "unknown";
  try {
    const u = s.includes("://") ? new URL(s) : new URL(`https://${s}`);
    let host = String(u.hostname || "").toLowerCase().replace(/^www\./, "");
    return host || "unknown";
  } catch {
    return "unknown";
  }
}

// Seed a single company to Cosmos companies container
async function seedCompanyToCosmos({ company, sessionId, container }) {
  if (!container || !company) return { ok: false, error: "missing_args" };

  const companyName = String(company.company_name || company.name || "").trim();
  const websiteUrl = String(company.website_url || company.url || "").trim();

  if (!companyName || !websiteUrl) {
    return { ok: false, error: "missing_required_fields" };
  }

  const normalizedDomain = toNormalizedDomain(websiteUrl);
  const companyId = `company_${Date.now()}_${Math.random().toString(36).slice(2, 10)}`;
  const nowIso = new Date().toISOString();

  const companyDoc = {
    id: companyId,
    company_id: companyId,
    company_name: companyName,
    name: companyName,
    website_url: websiteUrl,
    normalized_domain: normalizedDomain,
    partition_key: normalizedDomain,

    // Session tracking - this is how resume-worker finds companies to enrich
    session_id: sessionId,
    import_session_id: sessionId,

    // Mark as needing enrichment
    seed_ready: true,
    source: "import-one",
    source_stage: "seed",

    // Fields that need enrichment
    import_missing_fields: [
      "industries",
      "product_keywords",
      "headquarters_location",
      "manufacturing_locations",
      "reviews",
      "logo_url",
      "tagline",
    ],

    // Timestamps
    created_at: nowIso,
    updated_at: nowIso,
    import_created_at: nowIso,

    // Initialize empty fields that will be enriched
    industries: [],
    product_keywords: [],
    headquarters_location: "",
    headquarters_locations: [],
    manufacturing_locations: [],
    reviews: [],
    logo_url: "",
    tagline: "",
  };

  try {
    await container.items.upsert(companyDoc, { partitionKey: normalizedDomain });
    return { ok: true, company_id: companyId, normalized_domain: normalizedDomain };
  } catch (e) {
    return { ok: false, error: String(e?.message || e) };
  }
}

// Cosmos helper - cached client for companies container
let cosmosCompaniesClient = null;

function getCompaniesCosmosContainer() {
  try {
    const endpoint = (process.env.COSMOS_DB_ENDPOINT || process.env.COSMOS_DB_DB_ENDPOINT || "").trim();
    const key = (process.env.COSMOS_DB_KEY || process.env.COSMOS_DB_DB_KEY || "").trim();
    const databaseId = (process.env.COSMOS_DB_DATABASE || "tabarnam-db").trim();
    const containerId = (process.env.COSMOS_DB_COMPANIES_CONTAINER || "companies").trim();

    if (!endpoint || !key) return null;
    if (!CosmosClient) return null;

    cosmosCompaniesClient ||= new CosmosClient({ endpoint, key });
    return cosmosCompaniesClient.database(databaseId).container(containerId);
  } catch {
    return null;
  }
}

const DEADLINE_MS = 25000; // 25 second max for request

function json(obj, status = 200) {
  return {
    status,
    headers: {
      "Content-Type": "application/json",
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Methods": "GET,POST,OPTIONS",
      "Access-Control-Allow-Headers":
        "content-type,authorization,x-functions-key,x-request-id,x-correlation-id,x-session-id,x-client-request-id",
      "Cache-Control": "no-store",
    },
    body: JSON.stringify(obj),
  };
}

function normalizeUrl(raw) {
  const s = String(raw || "").trim();
  if (!s) return null;

  try {
    const u = s.includes("://") ? new URL(s) : new URL(`https://${s}`);
    u.search = "";
    u.hash = "";
    u.pathname = u.pathname && u.pathname !== "/" ? u.pathname : "/";
    return u.toString();
  } catch {
    return null;
  }
}

function looksLikeUrl(raw) {
  const s = String(raw || "").trim();
  if (!s) return false;
  if (/\s/.test(s)) return false;

  try {
    const u = s.includes("://") ? new URL(s) : new URL(`https://${s}`);
    const host = String(u.hostname || "").toLowerCase();
    if (!host || !host.includes(".")) return false;
    const parts = host.split(".").filter(Boolean);
    if (parts.length < 2) return false;
    const tld = parts[parts.length - 1];
    if (!tld || tld.length < 2) return false;
    return true;
  } catch {
    return false;
  }
}

async function readJsonBody(req) {
  if (!req) return null;
  try {
    if (typeof req.text === "function") {
      const text = await req.text();
      return text ? JSON.parse(text) : null;
    }
    if (typeof req.json === "function") {
      return await req.json();
    }
    if (req.body) {
      if (typeof req.body === "string") return JSON.parse(req.body);
      if (typeof req.body === "object") return req.body;
    }
  } catch {}
  return null;
}

async function handleImportOne(req, context) {
  const startTime = Date.now();
  const sessionId = randomUUID();
  const cosmosEnabled = !process.env.TABARNAM_DISABLE_COSMOS;

  try {
    // Read and validate request body
    const body = await readJsonBody(req);
    const BUILD_STAMP = getBuildStamp();

    if (!body || typeof body !== "object") {
      return json({ ok: false, error: { message: "Invalid request body", code: "invalid_body" }, build_id: BUILD_STAMP }, 400);
    }

    const url = String(body.url || "").trim();
    if (!url || !looksLikeUrl(url)) {
      return json({
        ok: false,
        error: { message: "Missing or invalid 'url' in request body", code: "invalid_url" },
        build_id: BUILD_STAMP,
      }, 400);
    }

    const normalizedUrl = normalizeUrl(url);
    if (!normalizedUrl) {
      return json({
        ok: false,
        error: { message: "Could not normalize URL", code: "normalize_error" },
        build_id: BUILD_STAMP,
      }, 400);
    }

    // Log start with build stamp for deployment verification
    try {
      console.log("[import-one] build", BUILD_STAMP);
      console.log("[import-one] started", { session_id: sessionId, url: normalizedUrl });
    } catch {}

    // Create session (upsertImportSession is synchronous)
    // Set single_company_mode=true and request_kind="import-one" so status can trust this flag
    const sessionPayload = {
      session_id: sessionId,
      status: "running",
      request_url: normalizedUrl,
      created_at: new Date().toISOString(),
      // Critical: these flags allow status endpoint to correctly identify single-company mode
      single_company_mode: true,
      request_kind: "import-one",
      request: {
        query: normalizedUrl,
        limit: 1,
      },
    };

    let sessionUpsertResult = null;
    let sessionUpsertSuccess = false;

    try {
      console.log("[import-one] about_to_upsert_session", { session_id: sessionId });
      sessionUpsertResult = upsertImportSession(sessionPayload);
      sessionUpsertSuccess = true;

      // Log the exact payload written and the result for debugging persistence issues
      console.log("[import-one] session_upsert_complete", {
        session_id: sessionId,
        upsert_success: true,
        payload_written: {
          single_company_mode: sessionPayload.single_company_mode,
          request_kind: sessionPayload.request_kind,
          request_url: sessionPayload.request_url,
          request_limit: sessionPayload.request?.limit,
        },
        result_keys: sessionUpsertResult ? Object.keys(sessionUpsertResult) : null,
        result_single_company_mode: sessionUpsertResult?.single_company_mode,
        result_request_kind: sessionUpsertResult?.request_kind,
      });

      // GUARD: Detect if critical flags were silently lost after upsert
      const flagsLost = sessionUpsertResult && (
        sessionUpsertResult.single_company_mode !== true ||
        sessionUpsertResult.request_kind !== "import-one"
      );

      if (flagsLost) {
        console.warn("[import-one] FLAGS_LOST_WARNING", {
          session_id: sessionId,
          expected_single_company_mode: true,
          actual_single_company_mode: sessionUpsertResult?.single_company_mode,
          actual_single_company_mode_type: typeof sessionUpsertResult?.single_company_mode,
          expected_request_kind: "import-one",
          actual_request_kind: sessionUpsertResult?.request_kind,
          actual_request_kind_type: typeof sessionUpsertResult?.request_kind,
          result_keys: Object.keys(sessionUpsertResult || {}),
        });
      }
    } catch (e) {
      // Non-fatal: session persistence should never hard-fail the import flow
      console.log("[import-one] session_upsert_threw", {
        session_id: sessionId,
        upsert_success: false,
        error: String(e?.message || e),
        stack: String(e?.stack || "").slice(0, 500),
        payload_attempted: {
          single_company_mode: sessionPayload.single_company_mode,
          request_kind: sessionPayload.request_kind,
        },
      });
    }

    // Write session doc to Cosmos so import-status can read it
    if (cosmosEnabled) {
      try {
        const container = getCompaniesCosmosContainer();
        if (container) {
          const sessionDoc = {
            id: `_import_session_${sessionId}`,
            session_id: sessionId,
            normalized_domain: "import",
            partition_key: "import",
            type: "import_control",
            status: "running",
            request_url: normalizedUrl,
            created_at: new Date().toISOString(),
            single_company_mode: true,
            request_kind: "import-one",
            request: {
              query: normalizedUrl,
              limit: 1,
            },
          };
          await container.items.upsert(sessionDoc, { partitionKey: "import" });
          console.log("[import-one] cosmos_session_upsert", { session_id: sessionId, ok: true });
        }
      } catch (e) {
        console.log("[import-one] cosmos_session_upsert_failed", {
          session_id: sessionId,
          error: String(e?.message || e),
        });
      }
    }

    // Create primary job with single URL seed
    const jobDoc = {
      id: buildImportPrimaryJobId(sessionId),
      session_id: sessionId,
      job_state: "queued",
      stage: "primary",
      stage_beacon: "single_import_started",
      request_payload: {
        query: normalizedUrl,
        queryTypes: ["direct_url"],
        limit: 1,
        expand_if_few: false,
      },
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    };

    try {
      await upsertImportPrimaryJob({ jobDoc, cosmosEnabled });
    } catch (e) {
      try {
        console.log("[import-one] primary_job_upsert_failed_nonfatal", {
          session_id: sessionId,
          error: String(e?.message || e),
        });
      } catch {}
    }

    // Run work loop until completion or deadline
    let lastSession = null;
    let completed = false;
    let loopCount = 0;
    const maxLoops = 20; // Safety limit on loop iterations

    while (!completed && loopCount < maxLoops) {
      loopCount++;
      const elapsed = Date.now() - startTime;
      if (elapsed > DEADLINE_MS) {
        // Deadline reached
        try {
          console.log("[import-one] deadline_reached", { session_id: sessionId, elapsed_ms: elapsed, loops: loopCount });
        } catch {}
        break;
      }

      // Run primary job
      try {
        const workerResult = await runPrimaryJob({
          context,
          sessionId,
          cosmosEnabled,
          invocationSource: "import-one",
        });

        // Get updated session to check completion status
        try {
          lastSession = await getImportSession({ session_id: sessionId, cosmosEnabled });
        } catch {}

        // Check completion indicators
        const savedVerifiedCount = Number(lastSession?.saved_verified_count || 0);
        const sessionStatus = String(lastSession?.status || "").toLowerCase();

        if (savedVerifiedCount > 0 || sessionStatus === "complete" || sessionStatus === "stopped") {
          completed = true;
          try {
            console.log("[import-one] completed", { session_id: sessionId, saved_count: savedVerifiedCount, status: sessionStatus });
          } catch {}
          break;
        }
      } catch (err) {
        try {
          console.log("[import-one] worker_error", { session_id: sessionId, error: String(err?.message || err) });
        } catch {}
        break;
      }

      // Small delay between loops to avoid tight spinning
      await new Promise((resolve) => setTimeout(resolve, 50));
    }

    // Fetch final session state and company data
    try {
      lastSession = await getImportSession({ session_id: sessionId, cosmosEnabled });
    } catch {}

    // ============================================================
    // CRITICAL: Seed companies from primary job to Cosmos
    // This is what allows resume-worker to find and enrich the company
    // ============================================================
    let seededCompanyIds = [];
    if (cosmosEnabled) {
      try {
        // Read the primary job to get the companies array
        const primaryJob = await getImportPrimaryJob({ sessionId, cosmosEnabled });
        const companiesFromJob = Array.isArray(primaryJob?.companies) ? primaryJob.companies : [];

        if (companiesFromJob.length > 0) {
          const container = getCompaniesCosmosContainer();
          if (container) {
            console.log("[import-one] seeding_companies", {
              session_id: sessionId,
              companies_count: companiesFromJob.length,
            });

            for (const company of companiesFromJob.slice(0, 5)) {
              const seedResult = await seedCompanyToCosmos({ company, sessionId, container });
              if (seedResult.ok) {
                seededCompanyIds.push(seedResult.company_id);
                console.log("[import-one] company_seeded", {
                  session_id: sessionId,
                  company_id: seedResult.company_id,
                  company_name: company.company_name || company.name,
                  normalized_domain: seedResult.normalized_domain,
                });
              } else {
                console.log("[import-one] company_seed_failed", {
                  session_id: sessionId,
                  company_name: company.company_name || company.name,
                  error: seedResult.error,
                });
              }
            }

            // Update session doc with saved company IDs so resume-worker can find them
            if (seededCompanyIds.length > 0) {
              const nowIso = new Date().toISOString();

              // Create the missing_by_company array that resume-worker needs
              const missingByCompany = seededCompanyIds.map((company_id) => ({
                company_id,
                missing_fields: [
                  "industries",
                  "tagline",
                  "product_keywords",
                  "headquarters_location",
                  "manufacturing_locations",
                  "logo",
                  "reviews",
                ],
              }));

              try {
                const sessionDocId = `_import_session_${sessionId}`;
                const sessionPatch = {
                  id: sessionDocId,
                  session_id: sessionId,
                  normalized_domain: "import",
                  partition_key: "import",
                  type: "import_control",
                  saved_company_ids: seededCompanyIds,
                  saved_company_ids_verified: seededCompanyIds,
                  saved_verified_count: seededCompanyIds.length,
                  saved: seededCompanyIds.length,
                  updated_at: nowIso,
                };
                await container.items.upsert(sessionPatch, { partitionKey: "import" });
                console.log("[import-one] session_updated_with_saved_ids", {
                  session_id: sessionId,
                  saved_ids: seededCompanyIds,
                });
              } catch (e) {
                console.log("[import-one] session_update_failed", {
                  session_id: sessionId,
                  error: String(e?.message || e),
                });
              }

              // Create the resume doc with proper missing_by_company so resume-worker can enrich
              try {
                const resumeDocId = `_import_resume_${sessionId}`;
                const resumeDoc = {
                  id: resumeDocId,
                  session_id: sessionId,
                  normalized_domain: "import",
                  partition_key: "import",
                  type: "import_control",
                  created_at: nowIso,
                  updated_at: nowIso,
                  status: "queued",
                  doc_created: true,
                  saved_company_ids: seededCompanyIds,
                  missing_by_company: missingByCompany,
                  cycle_count: 0,
                  attempt: 0,
                };
                await container.items.upsert(resumeDoc, { partitionKey: "import" });
                console.log("[import-one] resume_doc_created", {
                  session_id: sessionId,
                  missing_by_company_count: missingByCompany.length,
                });
              } catch (e) {
                console.log("[import-one] resume_doc_create_failed", {
                  session_id: sessionId,
                  error: String(e?.message || e),
                });
              }

              // Immediately invoke resume-worker to process enrichment
              if (missingByCompany && missingByCompany.length > 0) {
                try {
                  const invokeRes = await invokeResumeWorkerInProcess({
                    session_id: sessionId,
                    context,
                    deadline_ms: 900000, // 15 minutes - allows all 7 fields to complete with thorough xAI research
                  });
                  console.log("[import-one] resume_worker_invoked", {
                    session_id: sessionId,
                    ok: invokeRes?.ok,
                    invocation: invokeRes?.invocation,
                  });
                } catch (err) {
                  console.log("[import-one] resume_worker_invoke_failed", {
                    session_id: sessionId,
                    error: String(err?.message || err),
                  });

                  // Fallback: enqueue to resume-worker queue
                  try {
                    await enqueueResumeRun({
                      session_id: sessionId,
                      company_ids: seededCompanyIds,
                      reason: "import_one_fallback_queue",
                      requested_by: "import_one",
                    });
                    console.log("[import-one] resume_enqueued_fallback", { session_id: sessionId });
                  } catch (qErr) {
                    console.log("[import-one] resume_enqueue_fallback_failed", {
                      session_id: sessionId,
                      error: String(qErr?.message || qErr),
                    });
                  }
                }
              }
            }
          }
        } else {
          console.log("[import-one] no_companies_to_seed", {
            session_id: sessionId,
            job_state: primaryJob?.job_state,
            companies_candidates_found: primaryJob?.companies_candidates_found,
          });
        }
      } catch (e) {
        console.log("[import-one] seed_companies_error", {
          session_id: sessionId,
          error: String(e?.message || e),
        });
      }
    }

    const finalStatus = String(lastSession?.status || "").toLowerCase();
    const savedCount = seededCompanyIds.length > 0 ? seededCompanyIds.length : Number(lastSession?.saved_verified_count || 0);

    if (savedCount > 0) {
      // Import completed - return success with company data
      return json({
        ok: true,
        completed: true,
        session_id: sessionId,
        saved_count: savedCount,
        status: finalStatus,
        build_id: BUILD_STAMP,
      }, 200);
    } else {
      // Work still in progress or deadline reached - enqueue resume message for background processing
      try {
        const enqueueResult = await enqueueResumeRun({
          session_id: sessionId,
          reason: "import-one-deadline",
          requested_by: "import-one-endpoint",
          enqueue_at: new Date().toISOString(),
          run_after_ms: 0,
        });

        if (enqueueResult.ok) {
          try {
            console.log("[import-one] enqueued_resume", {
              session_id: sessionId,
              message_id: enqueueResult.message_id,
              queue_name: enqueueResult.queue?.name,
            });
          } catch {}
        } else {
          try {
            console.log("[import-one] enqueue_failed", {
              session_id: sessionId,
              error: enqueueResult.error,
            });
          } catch {}
        }
      } catch (err) {
        try {
          console.log("[import-one] enqueue_exception", {
            session_id: sessionId,
            error: String(err?.message || err),
          });
        } catch {}
      }

      // Return response indicating work is continuing in background
      return json({
        ok: true,
        completed: false,
        session_id: sessionId,
        status: finalStatus,
        note: "Import started but not completed; use /api/import/status to poll",
        build_id: BUILD_STAMP,
      }, 200);
    }
  } catch (err) {
    const errorMessage = typeof err?.message === "string" ? err.message : String(err);
    try {
      console.log("[import-one] handler_error", { session_id: sessionId, error: errorMessage });
    } catch {}

    return json({
      ok: false,
      error: { message: errorMessage, code: "handler_error" },
      build_id: BUILD_STAMP,
    }, 500);
  }
}

app.http("import-one", {
  route: "import-one",
  methods: ["POST", "OPTIONS"],
  authLevel: "anonymous",
  handler: async (req, context) => {
    if (String(req.method || "").toUpperCase() === "OPTIONS") {
      return json({}, 200);
    }
    return handleImportOne(req, context);
  },
});

module.exports = {
  handleImportOne,
};
