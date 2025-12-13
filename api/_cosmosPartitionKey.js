"use strict";

function splitPath(path) {
  const p = String(path || "").trim();
  if (!p || p === "/") return [];
  return p
    .split("/")
    .map((s) => s.trim())
    .filter(Boolean);
}

function getValueAtPath(doc, path) {
  if (!doc || typeof doc !== "object") return undefined;
  const parts = splitPath(path);
  if (parts.length === 0) return undefined;

  let cur = doc;
  for (const part of parts) {
    if (!cur || typeof cur !== "object") return undefined;
    cur = cur[part];
  }
  return cur;
}

function isImportArtifactId(id) {
  const s = String(id || "");
  return s.startsWith("_import_complete_") || s.startsWith("_import_timeout_") || s.startsWith("_import_stop_");
}

function uniqPartitionKeyCandidates(values) {
  const out = [];
  const seen = new Set();

  for (const v of values) {
    if (v === undefined) continue;

    const t = typeof v;
    if (v === null || t === "string" || t === "number" || t === "boolean") {
      const k = `${t}:${String(v)}`;
      if (seen.has(k)) continue;
      seen.add(k);
      out.push(v);
      continue;
    }

    try {
      const k = `json:${JSON.stringify(v)}`;
      if (seen.has(k)) continue;
      seen.add(k);
      out.push(v);
    } catch {
      const k = `obj:${Object.prototype.toString.call(v)}`;
      if (seen.has(k)) continue;
      seen.add(k);
      out.push(v);
    }
  }

  return out;
}

async function getContainerPartitionKeyPath(container, fallbackPath = "/normalized_domain") {
  try {
    const { resource } = await container.read();
    const path = resource?.partitionKey?.paths?.[0];
    if (typeof path === "string" && path.trim()) return path.trim();
  } catch {
  }
  return fallbackPath;
}

function buildPartitionKeyCandidates({ doc, containerPkPath, requestedId }) {
  const docId = String(doc?.id || requestedId || "");
  const candidates = [];

  candidates.push(getValueAtPath(doc, containerPkPath));

  candidates.push(doc?.partition_key);
  candidates.push(doc?.partitionKey);
  candidates.push(doc?.pk);
  candidates.push(doc?.normalized_domain);

  candidates.push(doc?.id);
  candidates.push(requestedId);

  if (isImportArtifactId(docId)) {
    candidates.push("import");
  }

  candidates.push(null);

  return uniqPartitionKeyCandidates(candidates);
}

module.exports = {
  getValueAtPath,
  getContainerPartitionKeyPath,
  buildPartitionKeyCandidates,
  isImportArtifactId,
};
