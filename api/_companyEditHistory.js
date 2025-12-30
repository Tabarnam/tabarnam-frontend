let CosmosClient;
try {
  ({ CosmosClient } = require("@azure/cosmos"));
} catch {
  CosmosClient = null;
}

function env(k, d = "") {
  const v = process.env[k];
  return (v == null ? d : String(v)).trim();
}

function isPlainObject(value) {
  if (!value || typeof value !== "object") return false;
  if (Array.isArray(value)) return false;
  if (typeof value.getReader === "function") return false;
  if (typeof value.arrayBuffer === "function") return false;
  if (ArrayBuffer.isView(value)) return false;
  return Object.prototype.toString.call(value) === "[object Object]";
}

function stableStringify(value) {
  try {
    return JSON.stringify(value);
  } catch {
    return undefined;
  }
}

function shouldRedactField(fieldName) {
  const k = String(fieldName || "").toLowerCase();
  if (!k) return false;
  return (
    k.includes("password") ||
    k.includes("secret") ||
    k.includes("token") ||
    (k.endsWith("key") && k !== "company_key") ||
    k.includes("authorization")
  );
}

function truncateString(s, maxLen) {
  const str = typeof s === "string" ? s : s == null ? "" : String(s);
  if (str.length <= maxLen) return str;
  return str.slice(0, maxLen) + `… (truncated, ${str.length} chars)`;
}

function truncateForStorage(value, opts) {
  const maxStringLength = Number(opts?.maxStringLength ?? 2000);
  const maxArrayLength = Number(opts?.maxArrayLength ?? 50);
  const maxObjectKeys = Number(opts?.maxObjectKeys ?? 80);
  const maxDepth = Number(opts?.maxDepth ?? 4);

  function walk(v, depth) {
    if (depth > maxDepth) return "[TRUNCATED_DEPTH]";

    if (v == null) return v;

    const t = typeof v;
    if (t === "string") return truncateString(v, maxStringLength);
    if (t === "number" || t === "boolean") return v;

    if (Array.isArray(v)) {
      const out = [];
      const limit = Math.min(v.length, maxArrayLength);
      for (let i = 0; i < limit; i += 1) out.push(walk(v[i], depth + 1));
      if (v.length > limit) out.push(`[TRUNCATED_ARRAY_${v.length - limit}]`);
      return out;
    }

    if (isPlainObject(v)) {
      const keys = Object.keys(v);
      keys.sort();
      const limited = keys.slice(0, maxObjectKeys);
      const out = {};
      for (const k of limited) out[k] = walk(v[k], depth + 1);
      if (keys.length > limited.length) {
        out.__truncated_keys__ = keys.length - limited.length;
      }
      return out;
    }

    try {
      return truncateString(String(v), maxStringLength);
    } catch {
      return "[UNSERIALIZABLE]";
    }
  }

  return walk(value, 0);
}

function normalizeDiffValue(fieldName, value) {
  if (shouldRedactField(fieldName)) return "[REDACTED]";
  return truncateForStorage(value, {
    maxStringLength: 2000,
    maxArrayLength: 50,
    maxObjectKeys: 80,
    maxDepth: 4,
  });
}

function computeTopLevelDiff(beforeDoc, afterDoc, opts = {}) {
  const ignore = new Set([
    "_rid",
    "_self",
    "_etag",
    "_attachments",
    "_ts",
    "updated_at",
    "updatedAt",
    "created_at",
    "createdAt",
    ...(Array.isArray(opts.ignoreKeys) ? opts.ignoreKeys : []),
  ]);

  const before = beforeDoc && typeof beforeDoc === "object" ? beforeDoc : {};
  const after = afterDoc && typeof afterDoc === "object" ? afterDoc : {};

  const keys = new Set([...Object.keys(before), ...Object.keys(after)]);
  for (const k of ignore) keys.delete(k);

  const changed_fields = [];
  const diff = {};

  for (const k of Array.from(keys).sort()) {
    const hasBefore = Object.prototype.hasOwnProperty.call(before, k);
    const hasAfter = Object.prototype.hasOwnProperty.call(after, k);

    const b = hasBefore ? before[k] : undefined;
    const a = hasAfter ? after[k] : undefined;

    const bs = stableStringify(b);
    const as = stableStringify(a);

    const equal = bs !== undefined && as !== undefined ? bs === as : Object.is(b, a);
    if (equal) continue;

    changed_fields.push(k);
    diff[k] = {
      before: normalizeDiffValue(k, b),
      after: normalizeDiffValue(k, a),
    };
  }

  return { changed_fields, diff };
}

let cachedClient = null;
let cachedContainerPromise = null;

function getCosmosClient() {
  const endpoint = env("COSMOS_DB_ENDPOINT", "");
  const key = env("COSMOS_DB_KEY", "");
  if (!endpoint || !key) return null;

  try {
    cachedClient ||= new CosmosClient({ endpoint, key });
    return cachedClient;
  } catch (e) {
    console.error("[company-edit-history] Failed to create Cosmos client:", e?.message);
    return null;
  }
}

async function getCompanyEditHistoryContainer() {
  if (cachedContainerPromise) return cachedContainerPromise;

  cachedContainerPromise = (async () => {
    const client = getCosmosClient();
    if (!client) return null;

    const databaseId = env("COSMOS_DB_DATABASE", "tabarnam-db");
    const containerId = env("COSMOS_DB_COMPANY_EDIT_HISTORY_CONTAINER", "company_edit_history");

    try {
      const db = client.database(databaseId);
      const { container } = await db.containers.createIfNotExists({
        id: containerId,
        partitionKey: { paths: ["/company_id"] },
      });
      return container;
    } catch (e) {
      console.error("[company-edit-history] Failed to get/create container:", e?.message);
      return null;
    }
  })();

  return cachedContainerPromise;
}

function randomId() {
  return `${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 10)}`;
}

async function writeCompanyEditHistoryEntry(params) {
  const company_id = String(params?.company_id || "").trim();
  if (!company_id) return { ok: false, error: "company_id required" };

  const container = params?.container || (await getCompanyEditHistoryContainer());
  if (!container) return { ok: false, error: "history container unavailable" };

  const created_at = new Date().toISOString();
  const action = String(params?.action || "update").trim() || "update";
  const source = String(params?.source || "admin-ui").trim() || "admin-ui";

  const beforeDoc = params?.before && typeof params.before === "object" ? params.before : null;
  const afterDoc = params?.after && typeof params.after === "object" ? params.after : null;

  const { changed_fields, diff } = computeTopLevelDiff(beforeDoc, afterDoc, {
    ignoreKeys: ["id", "company_id", "deleted_at", "deleted_by"],
  });

  const actor_user_id = params?.actor_user_id != null ? String(params.actor_user_id).trim() : "";
  const actor_email = params?.actor_email != null ? String(params.actor_email).trim() : "";

  const request_id = params?.request_id != null ? String(params.request_id).trim() : "";

  const doc = {
    id: `audit_${company_id}_${randomId()}`,
    company_id,
    created_at,
    actor_user_id: actor_user_id || undefined,
    actor_email: actor_email || undefined,
    action,
    changed_fields,
    diff,
    request_id: request_id || undefined,
    source,
  };

  try {
    await container.items.create(doc, { partitionKey: company_id });
    return { ok: true, id: doc.id };
  } catch (e) {
    console.error("[company-edit-history] Failed to write entry:", e?.message);
    return { ok: false, error: e?.message || "write failed" };
  }
}

module.exports = {
  getCompanyEditHistoryContainer,
  writeCompanyEditHistoryEntry,
  computeTopLevelDiff,
  truncateForStorage,
};
