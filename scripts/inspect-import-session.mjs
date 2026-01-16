import { CosmosClient } from "@azure/cosmos";

function asString(v) {
  return typeof v === "string" ? v : v == null ? "" : String(v);
}

function pickEnv(...keys) {
  for (const key of keys) {
    const value = asString(process.env[key]).trim();
    if (value) return value;
  }
  return "";
}

function redactError(err) {
  if (!err) return null;
  const message = asString(err.message || err).trim();
  return message || "Unknown error";
}

function safeIso(raw) {
  const s = asString(raw).trim();
  return s || null;
}

function summarizeCompany(doc) {
  if (!doc) return null;

  const industries = Array.isArray(doc.industries) ? doc.industries : null;
  const mfg = Array.isArray(doc.manufacturing_locations) ? doc.manufacturing_locations : null;
  const missing = Array.isArray(doc.import_missing_fields)
    ? doc.import_missing_fields
    : Array.isArray(doc.missing_fields)
      ? doc.missing_fields
      : null;

  return {
    id: asString(doc.id).trim() || null,
    company_name: asString(doc.company_name || doc.name).trim() || null,
    website_url: asString(doc.website_url || doc.url).trim() || null,

    // Cosmos PK diagnostics
    normalized_domain: asString(doc.normalized_domain).trim() || null,
    partition_key_field: asString(doc.partition_key).trim() || null,

    created_at: safeIso(doc.created_at),
    updated_at: safeIso(doc.updated_at),

    // core fields user cares about
    logo_url: doc.logo_url ?? null,
    headquarters_location: doc.headquarters_location ?? null,
    manufacturing_locations_preview:
      mfg && mfg.length
        ? mfg
            .slice(0, 5)
            .map((v) => (typeof v === "string" ? v : asString(v?.formatted || v?.address || v?.location).trim()))
            .filter(Boolean)
        : [],
    industries_preview: industries && industries.length ? industries.slice(0, 10).map((v) => asString(v).trim()).filter(Boolean) : [],
    product_keywords: doc.product_keywords ?? null,
    review_count: typeof doc.review_count === "number" ? doc.review_count : null,

    import_missing_fields: missing,
  };
}

function summarizeControlDoc(doc) {
  if (!doc) return null;

  return {
    id: asString(doc.id).trim() || null,
    type: asString(doc.type).trim() || null,
    status: asString(doc.status).trim() || null,
    stage_beacon: asString(doc.stage_beacon || doc.stage).trim() || null,
    reason: asString(doc.reason).trim() || null,

    created_at: safeIso(doc.created_at),
    updated_at: safeIso(doc.updated_at),
    completed_at: safeIso(doc.completed_at),

    companies_count: typeof doc.companies_count === "number" ? doc.companies_count : null,

    saved: typeof doc.saved === "number" ? doc.saved : null,
    failed: typeof doc.failed === "number" ? doc.failed : null,
    skipped: typeof doc.skipped === "number" ? doc.skipped : null,

    saved_ids_count: Array.isArray(doc.saved_ids) ? doc.saved_ids.length : null,
    saved_company_ids_verified: Array.isArray(doc.saved_company_ids_verified) ? doc.saved_company_ids_verified : null,
    saved_company_ids_unverified: Array.isArray(doc.saved_company_ids_unverified) ? doc.saved_company_ids_unverified : null,

    resume_needed: typeof doc.resume_needed === "boolean" ? doc.resume_needed : null,
    resume_error: asString(doc.resume_error).trim() || null,
    resume_error_details: doc.resume_error_details && typeof doc.resume_error_details === "object" ? doc.resume_error_details : null,

    // Resume worker evidence (some of these are added in newer handlers)
    resume_worker_last_invoked_at: safeIso(doc.resume_worker_last_invoked_at),
    resume_worker_last_finished_at: safeIso(doc.resume_worker_last_finished_at),
    resume_worker_last_result: asString(doc.resume_worker_last_result).trim() || null,
    resume_worker_last_error: asString(doc.resume_worker_last_error).trim() || null,
    resume_worker_last_company_id: asString(doc.resume_worker_last_company_id).trim() || null,
    resume_worker_last_written_fields: Array.isArray(doc.resume_worker_last_written_fields) ? doc.resume_worker_last_written_fields : null,

    job_state: asString(doc.job_state).trim() || null,
    last_error: doc.last_error || doc.error || null,
  };
}

async function main() {
  const sessionId = asString(process.argv[2]).trim();
  const companyIdArg = asString(process.argv[3]).trim();

  if (!sessionId) {
    console.error("Usage: node scripts/inspect-import-session.mjs <session_id> [company_id]");
    process.exit(2);
  }

  const endpoint = pickEnv("COSMOS_DB_ENDPOINT", "COSMOS_ENDPOINT", "COSMOS_DB_DB_ENDPOINT");
  const key = pickEnv("COSMOS_DB_KEY", "COSMOS_KEY", "COSMOS_DB_DB_KEY");
  const databaseId = pickEnv("COSMOS_DB_DATABASE") || "tabarnam-db";
  const containerId = pickEnv("COSMOS_DB_COMPANIES_CONTAINER") || "companies";

  if (!endpoint || !key) {
    console.log(JSON.stringify({ ok: false, error: "Cosmos DB is not configured (missing endpoint/key)" }, null, 2));
    process.exit(2);
  }

  const client = new CosmosClient({ endpoint, key });
  const container = client.database(databaseId).container(containerId);

  async function fetchAllById(id) {
    const q = {
      query: "SELECT * FROM c WHERE c.id = @id",
      parameters: [{ name: "@id", value: id }],
    };

    const { resources } = await container.items.query(q, { enableCrossPartitionQuery: true }).fetchAll();
    return Array.isArray(resources) ? resources : [];
  }

  async function fetchCompaniesBySession(limit = 250) {
    const top = Math.max(1, Math.min(Number(limit) || 50, 500));

    const q = {
      query:
        "SELECT TOP " +
        top +
        " * FROM c WHERE (c.session_id = @sid OR c.import_session_id = @sid) AND NOT STARTSWITH(c.id, '_import_') ORDER BY c.created_at DESC",
      parameters: [{ name: "@sid", value: sessionId }],
    };

    const { resources } = await container.items.query(q, { enableCrossPartitionQuery: true }).fetchAll();
    return Array.isArray(resources) ? resources : [];
  }

  const idsToCheck = [
    `_import_session_${sessionId}`,
    `_import_accept_${sessionId}`,
    `_import_resume_${sessionId}`,
    `_import_complete_${sessionId}`,
    `_import_timeout_${sessionId}`,
    `_import_stop_${sessionId}`,
    `_import_error_${sessionId}`,
    `_import_primary_job_${sessionId}`,
  ];

  const controlDocs = {};
  for (const id of idsToCheck) {
    try {
      const docs = await fetchAllById(id);
      if (!docs.length) continue;

      controlDocs[id] = {
        count: docs.length,
        docs: docs.map(summarizeControlDoc),
      };
    } catch (e) {
      controlDocs[id] = { count: 0, error: redactError(e) };
    }
  }

  let companies = [];
  let companiesError = null;
  try {
    companies = await fetchCompaniesBySession(250);
  } catch (e) {
    companiesError = redactError(e);
  }

  const sessionDocs = controlDocs[`_import_session_${sessionId}`]?.docs || [];
  const sessionDoc = sessionDocs.length ? sessionDocs[0] : null;

  const savedIds = (() => {
    const list = [];
    const verified = Array.isArray(sessionDoc?.saved_company_ids_verified)
      ? sessionDoc.saved_company_ids_verified
      : Array.isArray(sessionDoc?.saved_ids)
        ? sessionDoc.saved_ids
        : [];

    for (const id of verified) {
      const s = asString(id).trim();
      if (s && !list.includes(s)) list.push(s);
    }

    return list;
  })();

  const savedCompaniesById = [];
  const companyIdDiagnostics = {};

  for (const id of savedIds.slice(0, 25)) {
    try {
      const docs = await fetchAllById(id);
      companyIdDiagnostics[id] = {
        count: docs.length,
        partitions: docs.map((d) => asString(d?.normalized_domain).trim() || null).filter(Boolean),
      };
      for (const doc of docs) savedCompaniesById.push(doc);
    } catch (e) {
      companyIdDiagnostics[id] = { count: 0, error: redactError(e) };
    }
  }

  let companyByIdDocs = [];
  if (companyIdArg) {
    try {
      companyByIdDocs = await fetchAllById(companyIdArg);
    } catch (e) {
      companyByIdDocs = [{ id: companyIdArg, error: redactError(e) }];
    }
  }

  const out = {
    ok: true,
    session_id: sessionId,
    database: databaseId,
    container: containerId,

    control_docs: controlDocs,

    companies_saved_found: companies.length,
    companies_error: companiesError,
    companies_preview: companies.slice(0, 25).map(summarizeCompany),

    saved_company_ids_from_session: savedIds,
    saved_company_id_diagnostics: companyIdDiagnostics,
    saved_companies_by_id_preview: savedCompaniesById.slice(0, 10).map(summarizeCompany),

    ...(companyIdArg
      ? {
          company_id_query: companyIdArg,
          company_id_hits: companyByIdDocs.length,
          company_id_preview: companyByIdDocs.slice(0, 10).map(summarizeCompany),
        }
      : {}),
  };

  console.log(JSON.stringify(out, null, 2));
}

main().catch((e) => {
  console.error(JSON.stringify({ ok: false, error: redactError(e) }, null, 2));
  process.exit(1);
});
