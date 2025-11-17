const { CosmosClient } = require("@azure/cosmos");

const E = (key, def = "") => (process.env[key] ?? def).toString().trim();

function getHeader(req, name) {
  if (!req || !req.headers) return "";
  const headers = req.headers;
  if (typeof headers.get === "function") {
    try {
      return headers.get(name) || headers.get(name.toLowerCase()) || "";
    } catch {
      return "";
    }
  }
  return headers[name] || headers[name.toLowerCase()] || "";
}

const cors = (req) => {
  const origin = getHeader(req, "origin") || "*";
  return {
    "Access-Control-Allow-Origin": origin,
    Vary: "Origin",
    "Access-Control-Allow-Methods": "GET, POST, PUT, DELETE, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type, Authorization",
  };
};

const json = (obj, status = 200, req) => ({
  status,
  headers: { ...cors(req), "Content-Type": "application/json" },
  body: JSON.stringify(obj),
});

let cosmosClient = null;

function getCosmosClient() {
  const endpoint = E("COSMOS_DB_ENDPOINT");
  const key = E("COSMOS_DB_KEY");
  if (!endpoint || !key) return null;
  cosmosClient ||= new CosmosClient({ endpoint, key });
  return cosmosClient;
}

function getCompaniesContainer() {
  const client = getCosmosClient();
  if (!client) return null;
  const databaseId = E("COSMOS_DB_DATABASE", "tabarnam-db");
  const containerId = E("COSMOS_DB_COMPANIES_CONTAINER", "companies");
  return client.database(databaseId).container(containerId);
}

function getUndoContainer() {
  const client = getCosmosClient();
  if (!client) return null;
  const databaseId = E("COSMOS_DB_DATABASE", "tabarnam-db");
  const containerId = E("COSMOS_DB_UNDO_CONTAINER", "undo_history");
  return client.database(databaseId).container(containerId);
}

async function findCompanyById(container, id) {
  if (!container || !id) return null;
  const query = {
    query: "SELECT * FROM c WHERE c.id = @id",
    parameters: [{ name: "@id", value: id }],
  };
  const { resources } = await container.items
    .query(query, { enableCrossPartitionQuery: true })
    .fetchAll();
  return resources && resources.length > 0 ? resources[0] : null;
}

function normalizeCompany(doc) {
  if (!doc) return doc;
  const normalized = { ...doc };
  if (!Array.isArray(normalized.industries)) normalized.industries = [];
  if (!Array.isArray(normalized.manufacturing_locations)) normalized.manufacturing_locations = [];
  if (!Array.isArray(normalized.affiliate_links)) normalized.affiliate_links = [];
  if (!Array.isArray(normalized.star_explanation)) normalized.star_explanation = [];
  return normalized;
}

function computeChangedFields(oldDoc, newDoc) {
  if (!oldDoc || !newDoc) return [];
  const keys = new Set([...Object.keys(oldDoc), ...Object.keys(newDoc)]);
  const changed = [];
  for (const key of keys) {
    const beforeVal = oldDoc[key];
    const afterVal = newDoc[key];
    if (JSON.stringify(beforeVal) !== JSON.stringify(afterVal)) {
      changed.push(key);
    }
  }
  return changed;
}

function getActorFromRequest(req, body) {
  const override = body && typeof body.actor === "string" && body.actor.trim();
  if (override) return override.trim();

  const header = getHeader(req, "x-ms-client-principal") || "";
  if (!header) return null;
  try {
    const decoded = Buffer.from(header, "base64").toString("utf8");
    const principal = JSON.parse(decoded);
    return principal?.userDetails || principal?.userId || null;
  } catch {
    return null;
  }
}

async function logUndoAction(undoContainer, { companyId, oldDoc, newDoc, actor, actionType }) {
  if (!undoContainer || !companyId) return;
  try {
    const now = new Date().toISOString();
    const changedFields = computeChangedFields(oldDoc || {}, newDoc || {});
    const descriptionParts = [];
    if (actionType === "create") descriptionParts.push("Created company");
    if (actionType === "update") descriptionParts.push("Updated company");
    if (actionType === "delete") descriptionParts.push("Soft-deleted company");
    if (changedFields.length > 0) {
      descriptionParts.push(`Fields: ${changedFields.join(", ")}`);
    }

    const historyDoc = {
      id: `undo_${companyId}_${Date.now()}_${Math.random().toString(36).slice(2)}`,
      company_id: companyId,
      action_type: actionType,
      description: descriptionParts.join(" - ") || actionType,
      changed_fields: changedFields,
      old_doc: oldDoc || null,
      new_doc: newDoc || null,
      actor: actor || null,
      created_at: now,
      is_undone: false,
    };

    await undoContainer.items.create(historyDoc);
  } catch (e) {
    if (context && typeof context.log === "function") {
      context.log("Failed to log undo action", e?.message || e);
    }
  }
}

async function getJson(req) {
  if (!req) return {};
  if (typeof req.json === "function") {
    try {
      const val = await req.json();
      if (val && typeof val === "object") return val;
    } catch {}
  }
  if (req.body && typeof req.body === "object") return req.body;
  if (typeof req.rawBody === "string" && req.rawBody) {
    try {
      const parsed = JSON.parse(req.rawBody);
      if (parsed && typeof parsed === "object") return parsed;
    } catch {}
  }
  return {};
}

async function handle(req, context) {
  const method = String(req.method || "").toUpperCase();

  if (method === "OPTIONS") {
    return { status: 204, headers: cors(req) };
  }

  const companiesContainer = getCompaniesContainer();
  if (!companiesContainer) {
    return json({ error: "Cosmos DB not configured" }, 500, req);
  }

  const undoContainer = getUndoContainer();

  try {
    if (method === "GET") {
      const url = new URL(req.url);
      const search = (url.searchParams.get("search") || "").toLowerCase().trim();
      const take = Math.min(500, Math.max(1, Number(url.searchParams.get("take") || "200")));

      const parameters = [{ name: "@take", value: take }];
      let whereClause = "";

      if (search) {
        parameters.push({ name: "@q", value: search });
        whereClause =
          "WHERE (" +
          [
            "(IS_DEFINED(c.company_name) AND CONTAINS(LOWER(c.company_name), @q))",
            "(IS_DEFINED(c.name) AND CONTAINS(LOWER(c.name), @q))",
            "(IS_DEFINED(c.product_keywords) AND CONTAINS(LOWER(c.product_keywords), @q))",
            "(IS_DEFINED(c.industries) AND ARRAY_LENGTH(ARRAY(SELECT VALUE i FROM i IN c.industries WHERE CONTAINS(LOWER(i), @q))) > 0)",
            "(IS_DEFINED(c.normalized_domain) AND CONTAINS(LOWER(c.normalized_domain), @q))",
            "(IS_DEFINED(c.amazon_url) AND CONTAINS(LOWER(c.amazon_url), @q))",
          ].join(" OR ") +
          ")";
      }

      const sql =
        "SELECT TOP @take * FROM c " +
        whereClause +
        " ORDER BY c._ts DESC";

      const { resources } = await companiesContainer.items
        .query({ query: sql, parameters }, { enableCrossPartitionQuery: true })
        .fetchAll();

      const items = (resources || []).map((doc) => normalizeCompany(doc));
      context.res = json({ items, count: items.length }, 200, req);
      return;
    }

    if (method === "POST" || method === "PUT") {
      const body = await getJson(req);

      const actor = getActorFromRequest(req, body);
      const incoming = body.company || body;
      const now = new Date().toISOString();

      if (!incoming) {
        context.res = json({ error: "company payload required" }, 400, req);
        return;
      }

      let id = incoming.id || incoming.company_id || incoming.company_name || null;
      if (!id) {
        id = `company_${Date.now()}_${Math.random().toString(36).slice(2)}`;
      }

      const existing = await findCompanyById(companiesContainer, id);
      const actionType = existing ? "update" : "create";

      const merged = normalizeCompany({
        ...existing,
        ...incoming,
        id,
        company_name: incoming.company_name || incoming.name || existing?.company_name || "",
        name: incoming.name || incoming.company_name || existing?.name || "",
        updated_at: now,
        created_at: existing?.created_at || incoming.created_at || now,
      });

      await companiesContainer.items.upsert(merged);
      await logUndoAction(undoContainer, {
        companyId: id,
        oldDoc: existing || null,
        newDoc: merged,
        actor,
        actionType,
      });

      context.res = json({ ok: true, company: merged }, existing ? 200 : 201, req);
      return;
    }

    if (method === "DELETE") {
      const body = await getJson(req);

      const id = body.id || body.company_id;
      if (!id) {
        context.res = json({ error: "id required" }, 400, req);
        return;
      }

      const actor = getActorFromRequest(req, body);
      const existing = await findCompanyById(companiesContainer, id);
      if (!existing) {
        context.res = json({ error: "Company not found" }, 404, req);
        return;
      }

      const now = new Date().toISOString();
      const softDeleted = {
        ...existing,
        is_deleted: true,
        deleted_at: now,
        updated_at: now,
      };

      await companiesContainer.items.upsert(softDeleted);
      await logUndoAction(undoContainer, {
        companyId: id,
        oldDoc: existing,
        newDoc: softDeleted,
        actor,
        actionType: "delete",
      });

      context.res = json({ ok: true, company: softDeleted }, 200, req);
      return;
    }

    context.res = json({ error: "Method not allowed" }, 405, req);
  } catch (e) {
    if (context && typeof context.log === "function") {
      context.log("Error in admin-companies:", e?.message || e);
    }
    context.res = json({ error: e?.message || "Internal error" }, 500, req);
  }
}

module.exports = async function (context, req) {
  await handle(req, context);
};
