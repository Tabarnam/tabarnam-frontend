try {
  ({ app } = require("@azure/functions"));
} catch {
  app = { http() {} };
}

let CosmosClient;
try {
  ({ CosmosClient } = require("@azure/cosmos"));
} catch {
  CosmosClient = null;
}

const {
  getContainerPartitionKeyPath,
  buildPartitionKeyCandidates,
  getValueAtPath,
} = require("../_cosmosPartitionKey");

function json(obj, status = 200) {
  return {
    status,
    headers: {
      "Content-Type": "application/json",
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Methods": "GET,OPTIONS",
      "Access-Control-Allow-Headers": "content-type,x-functions-key",
    },
    body: JSON.stringify(obj),
  };
}

function env(k, d = "") {
  const v = process.env[k];
  return (v == null ? d : String(v)).trim();
}

let cosmosCompaniesClient = null;
let companiesPkPathPromise;

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

async function getCompaniesPartitionKeyPath(container) {
  if (!container) return "/normalized_domain";
  companiesPkPathPromise ||= getContainerPartitionKeyPath(container, "/normalized_domain");
  try {
    return await companiesPkPathPromise;
  } catch {
    return "/normalized_domain";
  }
}

function toNormalizedDomain(s = "") {
  try {
    const raw = String(s || "").trim();
    if (!raw) return "";
    const ensured = raw.startsWith("http://") || raw.startsWith("https://") ? raw : `https://${raw}`;
    const u = new URL(ensured);
    const host = String(u.hostname || "")
      .toLowerCase()
      .replace(/^www\./, "")
      .trim();
    return host;
  } catch {
    return "";
  }
}

async function readItemWithPkCandidates(container, id, docForCandidates) {
  if (!container || !id) return null;
  const containerPkPath = await getCompaniesPartitionKeyPath(container);

  const candidates = buildPartitionKeyCandidates({
    doc: docForCandidates,
    containerPkPath,
    requestedId: id,
  });

  let lastErr = null;
  for (const partitionKeyValue of candidates) {
    try {
      const item =
        partitionKeyValue !== undefined
          ? container.item(id, partitionKeyValue)
          : container.item(id);

      const { resource } = await item.read();
      return resource || null;
    } catch (e) {
      lastErr = e;
      if (e?.code === 404) continue;
    }
  }

  if (lastErr && lastErr.code !== 404) {
    console.warn(`[admin-company] readItem failed id=${id} pkPath=${containerPkPath}: ${lastErr.message}`);
  }

  return null;
}

async function querySingle(container, { query, parameters }) {
  try {
    const { resources } = await container.items
      .query({ query, parameters }, { enableCrossPartitionQuery: true })
      .fetchAll();

    return Array.isArray(resources) && resources[0] ? resources[0] : null;
  } catch (e) {
    console.warn(`[admin-company] query failed: ${e?.message || String(e)}`);
    return null;
  }
}

app.http("admin-company", {
  route: "admin/company",
  methods: ["GET", "OPTIONS"],
  authLevel: "anonymous",
  handler: async (req) => {
    const method = String(req.method || "").toUpperCase();

    if (method === "OPTIONS") {
      return {
        status: 200,
        headers: {
          "Access-Control-Allow-Origin": "*",
          "Access-Control-Allow-Methods": "GET,OPTIONS",
          "Access-Control-Allow-Headers": "content-type,x-functions-key",
        },
      };
    }

    if (method !== "GET") {
      return json({ ok: false, error: "Method not allowed" }, 405);
    }

    const container = getCompaniesCosmosContainer();
    if (!container) {
      return json(
        {
          ok: false,
          error: "Cosmos DB not configured",
          details: {
            has_cosmos_module: Boolean(CosmosClient),
            has_endpoint: Boolean(env("COSMOS_DB_ENDPOINT") || env("COSMOS_DB_DB_ENDPOINT")),
            has_key: Boolean(env("COSMOS_DB_KEY") || env("COSMOS_DB_DB_KEY")),
            databaseId: env("COSMOS_DB_DATABASE", "tabarnam-db"),
            containerId: env("COSMOS_DB_COMPANIES_CONTAINER", "companies"),
          },
        },
        500
      );
    }

    const query = req.query || new URLSearchParams();

    const id = String(query.get("id") || "").trim();
    const domainRaw = String(query.get("domain") || "").trim();
    const includeDeletedRaw = String(query.get("include_deleted") || query.get("includeDeleted") || "").trim();
    const include_deleted = includeDeletedRaw === "1" || includeDeletedRaw.toLowerCase() === "true";

    if (!id && !domainRaw) {
      return json(
        {
          ok: false,
          error: "Missing required query param. Provide id=company_... or domain=example.com",
        },
        400
      );
    }

    const domain = domainRaw ? toNormalizedDomain(domainRaw) : "";

    const notDeletedClause = "(NOT IS_DEFINED(c.is_deleted) OR c.is_deleted != true)";
    const baseFilter = include_deleted ? "" : ` AND ${notDeletedClause}`;

    let item = null;
    let lookup = "";

    if (id) {
      const seedDoc = domain
        ? { id, normalized_domain: domain }
        : {
            id,
            normalized_domain: "unknown",
            pk: "unknown",
            partition_key: "unknown",
          };

      item = await readItemWithPkCandidates(container, id, seedDoc);

      if (!item) {
        item = await querySingle(container, {
          query: `SELECT TOP 1 * FROM c WHERE c.id = @id${baseFilter}`,
          parameters: [{ name: "@id", value: id }],
        });
      }

      lookup = "id";
    } else if (domain) {
      item = await querySingle(container, {
        query: `SELECT TOP 1 * FROM c WHERE NOT STARTSWITH(c.id, '_import_') AND c.normalized_domain = @domain${baseFilter}`,
        parameters: [{ name: "@domain", value: domain }],
      });
      lookup = "domain";
    }

    return json(
      {
        ok: true,
        found: Boolean(item),
        lookup,
        request: {
          id: id || null,
          domain: domain || null,
          include_deleted,
        },
        item,
        meta: item
          ? {
              id: item.id || null,
              normalized_domain: item.normalized_domain || null,
              is_deleted: Boolean(item.is_deleted),
              deleted_at: item.deleted_at || null,
              pk_value: getValueAtPath(item, await getCompaniesPartitionKeyPath(container)) ?? null,
            }
          : null,
      },
      200
    );
  },
});
