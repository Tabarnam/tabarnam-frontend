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

async function main() {
  const sessionId = asString(process.argv[2]).trim();
  if (!sessionId) {
    console.error("Usage: node scripts/inspect-import-session.mjs <session_id>");
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

  async function fetchById(id) {
    const q = {
      query: "SELECT * FROM c WHERE c.id = @id",
      parameters: [{ name: "@id", value: id }],
    };

    const { resources } = await container.items
      .query(q, { enableCrossPartitionQuery: true })
      .fetchAll();

    return Array.isArray(resources) && resources.length ? resources[0] : null;
  }

  async function fetchCompaniesBySession(limit = 250) {
    const top = Math.max(1, Math.min(Number(limit) || 50, 500));
    const q = {
      query:
        "SELECT TOP " +
        top +
        " c.id, c.company_name, c.website_url, c.normalized_domain, c.created_at, c.source " +
        "FROM c WHERE c.session_id = @sid AND NOT STARTSWITH(c.id, '_import_') ORDER BY c.created_at DESC",
      parameters: [{ name: "@sid", value: sessionId }],
    };

    const { resources } = await container.items
      .query(q, { enableCrossPartitionQuery: true })
      .fetchAll();

    return Array.isArray(resources) ? resources : [];
  }

  const idsToCheck = [
    `_import_session_${sessionId}`,
    `_import_accept_${sessionId}`,
    `_import_complete_${sessionId}`,
    `_import_timeout_${sessionId}`,
    `_import_stop_${sessionId}`,
    `_import_error_${sessionId}`,
    `_import_primary_job_${sessionId}`,
  ];

  const controlDocs = {};
  for (const id of idsToCheck) {
    try {
      const doc = await fetchById(id);
      if (!doc) continue;

      controlDocs[id] = {
        id: doc.id,
        type: doc.type || null,
        stage_beacon: doc.stage_beacon || doc.stage || null,
        reason: doc.reason || null,
        saved: typeof doc.saved === "number" ? doc.saved : null,
        failed: typeof doc.failed === "number" ? doc.failed : null,
        skipped: typeof doc.skipped === "number" ? doc.skipped : null,
        created_at: doc.created_at || null,
        updated_at: doc.updated_at || null,
        completed_at: doc.completed_at || null,
        job_state: doc.job_state || null,
        companies_count: typeof doc.companies_count === "number" ? doc.companies_count : null,
        last_error: doc.last_error || doc.error || null,
        saved_ids_count: Array.isArray(doc.saved_ids) ? doc.saved_ids.length : null,
        failed_items_count: Array.isArray(doc.failed_items) ? doc.failed_items.length : null,
      };
    } catch (e) {
      controlDocs[id] = { id, error: redactError(e) };
    }
  }

  let companies = [];
  let companiesError = null;
  try {
    companies = await fetchCompaniesBySession(250);
  } catch (e) {
    companiesError = redactError(e);
  }

  const controlDocsFound = Object.values(controlDocs).filter((d) => d && d.id).length;

  console.log(
    JSON.stringify(
      {
        ok: true,
        session_id: sessionId,
        database: databaseId,
        container: containerId,
        control_docs_found: controlDocsFound,
        control_docs: controlDocs,
        companies_saved_found: companies.length,
        companies_error: companiesError,
        companies_preview: companies.slice(0, 25),
      },
      null,
      2
    )
  );
}

main().catch((e) => {
  console.error(JSON.stringify({ ok: false, error: redactError(e) }, null, 2));
  process.exit(1);
});
