const { app, hasRoute } = require("../_app");
const { getBuildInfo } = require("../_buildInfo");
const { getCompanyEditHistoryContainer } = require("../_companyEditHistory");
const { app, hasRoute } = require("../_app");

const BUILD_INFO = getBuildInfo();
const HANDLER_ID = "admin-company-history";

function json(obj, status = 200) {
  return {
    status,
    headers: {
      "Content-Type": "application/json",
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Methods": "GET,OPTIONS",
      "Access-Control-Allow-Headers": "Content-Type, Authorization, x-functions-key",
      "X-Api-Handler": HANDLER_ID,
      "X-Api-Build-Id": String(BUILD_INFO.build_id || ""),
      "X-Api-Build-Source": String(BUILD_INFO.build_id_source || ""),
    },
    body: JSON.stringify(obj),
  };
}

function decodeCursor(value) {
  const raw = String(value || "").trim();
  if (!raw) return null;
  try {
    const jsonStr = Buffer.from(raw, "base64").toString("utf8");
    const parsed = JSON.parse(jsonStr);
    const created_at = typeof parsed?.created_at === "string" ? parsed.created_at : "";
    const id = typeof parsed?.id === "string" ? parsed.id : "";
    if (!created_at || !id) return null;
    return { created_at, id };
  } catch {
    return null;
  }
}

function encodeCursor(value) {
  if (!value || typeof value !== "object") return "";
  const created_at = typeof value.created_at === "string" ? value.created_at : "";
  const id = typeof value.id === "string" ? value.id : "";
  if (!created_at || !id) return "";
  try {
    return Buffer.from(JSON.stringify({ created_at, id }), "utf8").toString("base64");
  } catch {
    return "";
  }
}

function clampLimit(value) {
  const n = Number(value);
  if (!Number.isFinite(n)) return 50;
  return Math.max(1, Math.min(200, Math.trunc(n)));
}

function normalizeQuery(req) {
  const q = (req && req.query) || {};
  return q && typeof q === "object" ? q : {};
}

function getParam(req, name) {
  const q = normalizeQuery(req);
  const v = q?.[name];
  return v == null ? "" : String(v);
}

async function handler(req, context) {
  const method = String(req?.method || "GET").toUpperCase();
  if (method === "OPTIONS") return json({ ok: true }, 200);
  if (method !== "GET") return json({ error: "Method not allowed" }, 405);

  const company_id = String(
    (context && context.bindingData && (context.bindingData.company_id || context.bindingData.companyId)) ||
      (req && req.params && (req.params.company_id || req.params.companyId)) ||
      getParam(req, "company_id") ||
      getParam(req, "companyId") ||
      getParam(req, "id") ||
      ""
  ).trim();

  if (!company_id) return json({ error: "company_id required" }, 400);

  const container = await getCompanyEditHistoryContainer();
  if (!container) return json({ error: "Cosmos DB not configured" }, 503);

  const limit = clampLimit(getParam(req, "limit") || 50);
  const cursor = decodeCursor(getParam(req, "cursor"));
  const field = String(getParam(req, "field") || "").trim();
  const search = String(getParam(req, "q") || "").trim().toLowerCase();

  const parameters = [{ name: "@company_id", value: company_id }, { name: "@limit", value: limit }];

  const where = ["c.company_id = @company_id"];

  if (cursor) {
    where.push("(c.created_at < @cursor_created_at OR (c.created_at = @cursor_created_at AND c.id < @cursor_id))");
    parameters.push({ name: "@cursor_created_at", value: cursor.created_at });
    parameters.push({ name: "@cursor_id", value: cursor.id });
  }

  if (field) {
    where.push("(IS_DEFINED(c.changed_fields) AND IS_ARRAY(c.changed_fields) AND ARRAY_CONTAINS(c.changed_fields, @field, true))");
    parameters.push({ name: "@field", value: field });
  }

  if (search) {
    where.push(
      "(CONTAINS(LOWER(c.action), @q) OR CONTAINS(LOWER(c.source), @q) OR (IS_DEFINED(c.actor_email) AND CONTAINS(LOWER(c.actor_email), @q)) OR (IS_DEFINED(c.actor_user_id) AND CONTAINS(LOWER(c.actor_user_id), @q)) OR (IS_DEFINED(c.changed_fields) AND IS_ARRAY(c.changed_fields) AND ARRAY_LENGTH(ARRAY(SELECT VALUE f FROM f IN c.changed_fields WHERE IS_STRING(f) AND CONTAINS(LOWER(f), @q))) > 0))"
    );
    parameters.push({ name: "@q", value: search });
  }

  const sql = `SELECT TOP @limit * FROM c WHERE ${where.join(" AND ")} ORDER BY c.created_at DESC, c.id DESC`;

  try {
    const { resources } = await container.items
      .query({ query: sql, parameters }, { partitionKey: company_id })
      .fetchAll();

    const items = Array.isArray(resources) ? resources : [];
    const last = items.length > 0 ? items[items.length - 1] : null;
    const next_cursor = items.length === limit && last ? encodeCursor({ created_at: last.created_at, id: last.id }) : "";

    return json({ ok: true, items, next_cursor: next_cursor || null }, 200);
  } catch (e) {
    context?.log?.("[admin-company-history] query error", e?.message || e);
    return json({ error: "Failed to load history", detail: e?.message || String(e) }, 500);
  }
}

const ROUTE = "admin/companies/{company_id}/history";
const ALIAS_ROUTE = "admin-company-history";

if (!hasRoute(ROUTE)) {
  app.http("adminCompanyHistory", {
    route: ROUTE,
    methods: ["GET", "OPTIONS"],
    authLevel: "anonymous",
    handler,
  });
}

// Backup route: avoids path-param routing issues in some deployments.
// Usage: /api/admin-company-history?company_id=company_...&limit=25
if (!hasRoute(ALIAS_ROUTE)) {
  app.http("adminCompanyHistoryAlias", {
    route: ALIAS_ROUTE,
    methods: ["GET", "OPTIONS"],
    authLevel: "anonymous",
    handler,
  });
}

module.exports.handler = handler;
module.exports._test = { handler, decodeCursor, encodeCursor };
