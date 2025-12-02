const { app } = require('@azure/functions');
const { CosmosClient } = require('@azure/cosmos');

function env(k, d = "") {
  const v = process.env[k];
  return (v == null ? d : String(v)).trim();
}

function json(obj, status = 200) {
  return {
    status,
    headers: {
      "Content-Type": "application/json",
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Methods": "GET,POST,OPTIONS",
    },
    body: JSON.stringify(obj),
  };
}

function getCompaniesContainer() {
  const endpoint = env("COSMOS_DB_ENDPOINT", "");
  const key = env("COSMOS_DB_KEY", "");
  const database = env("COSMOS_DB_DATABASE", "tabarnam-db");
  const container = env("COSMOS_DB_COMPANIES_CONTAINER", "companies");

  if (!endpoint || !key) return null;

  try {
    const client = new CosmosClient({ endpoint, key });
    return client.database(database).container(container);
  } catch (e) {
    return null;
  }
}

app.http('adminSaveDiagnostic', {
  route: 'admin-save-diagnostic',
  methods: ['GET', 'POST', 'OPTIONS'],
  authLevel: 'anonymous',
}, async (req, context) => {
  context.log("[admin-save-diagnostic] Request received:", { method: req.method });

  const method = (req.method || "").toUpperCase();

  if (method === "OPTIONS") {
    return json({}, 204);
  }

  const container = getCompaniesContainer();

  if (method === "GET") {
    const diagnostics = {
      timestamp: new Date().toISOString(),
      cosmosConfigured: !!container,
      environment: {
        endpoint: env("COSMOS_DB_ENDPOINT") ? "✓ Set" : "✗ Missing",
        key: env("COSMOS_DB_KEY") ? "✓ Set" : "✗ Missing",
        database: env("COSMOS_DB_DATABASE") || "tabarnam-db",
        container: env("COSMOS_DB_COMPANIES_CONTAINER") || "companies",
      },
    };

    if (container) {
      try {
        const { resources } = await container.items
          .query(
            "SELECT TOP 1 * FROM c ORDER BY c._ts DESC"
          )
          .fetchAll();
        
        diagnostics.latestCompany = resources?.[0] ? {
          id: resources[0].id,
          company_name: resources[0].company_name,
          updated_at: resources[0].updated_at,
        } : null;
      } catch (e) {
        diagnostics.queryError = e?.message;
      }
    }

    return json(diagnostics, 200);
  }

  if (method === "POST") {
    if (!container) {
      return json(
        { error: "Cosmos DB not configured", environment: env("COSMOS_DB_ENDPOINT") ? "vars_set" : "vars_missing" },
        503
      );
    }

    let body = {};
    try {
      body = typeof req.body === "string" ? JSON.parse(req.body) : (req.body || {});
    } catch (e) {
      return json({ error: "Invalid JSON", detail: e?.message }, 400);
    }

    const testDoc = body.test_doc || {
      id: `test_${Date.now()}_${Math.random().toString(36).slice(2)}`,
      company_name: "TEST Company",
      test: true,
      created_at: new Date().toISOString(),
    };

    context.log("[admin-save-diagnostic] Testing save with document:", {
      id: testDoc.id,
      hasName: !!testDoc.company_name,
    });

    try {
      const testDocWithPartition = {
        ...testDoc,
        company_id: testDoc.id,
      };

      context.log("[admin-save-diagnostic] Attempting upsert with partitionKey");
      const result = await container.items.upsert(testDocWithPartition, {
        partitionKey: testDoc.id,
      });

      context.log("[admin-save-diagnostic] Upsert success", {
        statusCode: result.statusCode,
        id: result.resource?.id,
      });

      try {
        const { resource } = await container
          .item(testDoc.id, testDoc.id)
          .read();
        context.log("[admin-save-diagnostic] Read success", {
          id: resource.id,
          name: resource.company_name,
        });

        return json(
          {
            ok: true,
            message: "Save and read successful",
            testDoc: resource,
            timestamp: new Date().toISOString(),
          },
          200
        );
      } catch (readError) {
        return json(
          {
            ok: false,
            message: "Save succeeded but read failed",
            saveResult: { statusCode: result.statusCode },
            readError: readError?.message,
            testDocId: testDoc.id,
          },
          500
        );
      }
    } catch (e) {
      context.log("[admin-save-diagnostic] Upsert failed", {
        message: e?.message,
        code: e?.code,
        statusCode: e?.statusCode,
      });

      return json(
        {
          ok: false,
          message: "Upsert failed",
          error: e?.message,
          code: e?.code,
          statusCode: e?.statusCode,
        },
        500
      );
    }
  }

  return json({ error: "Method not allowed" }, 405);
});

console.log("[admin-save-diagnostic] ✅ Diagnostic endpoint registered");
