let app;
try {
  ({ app } = require("@azure/functions"));
} catch {
  app = { http() {} };
}

const crypto = require("node:crypto");
const { CosmosClient } = require("@azure/cosmos");
const { getBuildInfo } = require("../_buildInfo");
const { getContainerPartitionKeyPath, buildPartitionKeyCandidates } = require("../_cosmosPartitionKey");

const BUILD_INFO = getBuildInfo();
const HANDLER_ID = "admin-apply-reviews-from-notes";

function env(k, d = "") {
  const v = process.env[k];
  return (v == null ? d : String(v)).trim();
}

function nowIso() {
  return new Date().toISOString();
}

function json(obj, status = 200) {
  return {
    status,
    headers: {
      "Content-Type": "application/json",
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Methods": "POST,OPTIONS",
      "Access-Control-Allow-Headers": "Content-Type, Authorization, x-functions-key",
      "X-Api-Handler": HANDLER_ID,
      "X-Api-Build-Id": String(BUILD_INFO.build_id || ""),
      "X-Api-Build-Source": String(BUILD_INFO.build_id_source || ""),
    },
    body: JSON.stringify(obj),
  };
}

function asString(v) {
  return v == null ? "" : typeof v === "string" ? v : String(v);
}

async function readJsonBody(req) {
  if (!req) return {};

  if (typeof req.json === "function") {
    try {
      const val = await req.json();
      if (val && typeof val === "object") return val;
      return {};
    } catch {
      return {};
    }
  }

  if (req.body && typeof req.body === "object") return req.body;

  const raw = typeof req.rawBody === "string" ? req.rawBody : "";
  if (raw && raw.trim()) {
    try {
      const parsed = JSON.parse(raw);
      if (parsed && typeof parsed === "object") return parsed;
    } catch {
      return {};
    }
  }

  return {};
}

function getCompaniesContainer() {
  const endpoint = env("COSMOS_DB_ENDPOINT") || env("COSMOS_ENDPOINT");
  const key = env("COSMOS_DB_KEY") || env("COSMOS_KEY");
  const database = env("COSMOS_DB_DATABASE") || env("COSMOS_DB") || "tabarnam-db";
  const containerName = env("COSMOS_DB_COMPANIES_CONTAINER") || env("COSMOS_CONTAINER") || "companies";

  if (!endpoint || !key) return null;
  if (!CosmosClient) return null;

  try {
    const client = new CosmosClient({ endpoint, key });
    return client.database(database).container(containerName);
  } catch {
    return null;
  }
}

let companiesPkPathPromise;
async function getCompaniesPartitionKeyPath(companiesContainer) {
  if (!companiesContainer) return "/normalized_domain";
  companiesPkPathPromise ||= getContainerPartitionKeyPath(companiesContainer, "/normalized_domain");
  try {
    return await companiesPkPathPromise;
  } catch {
    return "/normalized_domain";
  }
}

async function getCompanyByCompanyId(companiesContainer, companyId) {
  const requestedId = asString(companyId).trim();
  if (!requestedId) throw new Error("Missing company_id");
  if (!companiesContainer) throw new Error("Cosmos not configured");

  const sql = `SELECT TOP 1 * FROM c WHERE (c.id = @id OR c.company_id = @id OR c.companyId = @id)\n               AND (NOT IS_DEFINED(c.is_deleted) OR c.is_deleted != true)\n               ORDER BY c._ts DESC`;

  const { resources } = await companiesContainer.items
    .query({ query: sql, parameters: [{ name: "@id", value: requestedId }] }, { enableCrossPartitionQuery: true })
    .fetchAll();

  const doc = Array.isArray(resources) && resources.length ? resources[0] : null;
  if (!doc) throw new Error(`Company not found (${requestedId})`);
  return doc;
}

async function patchCompany(companiesContainer, companyDoc, patch) {
  const id = asString(companyDoc?.id).trim();
  if (!id) throw new Error("Missing company doc id");

  const containerPkPath = await getCompaniesPartitionKeyPath(companiesContainer);
  const candidates = buildPartitionKeyCandidates({ doc: companyDoc, containerPkPath, requestedId: id });

  const ops = Object.keys(patch || {}).map((key) => ({ op: "set", path: `/${key}`, value: patch[key] }));

  let lastError;
  for (const pk of candidates) {
    try {
      const itemRef = companiesContainer.item(id, pk);
      await itemRef.patch(ops);
      return { ok: true, pk };
    } catch (e) {
      lastError = e;
    }
  }

  return { ok: false, error: asString(lastError?.message || lastError || "patch failed"), candidates };
}

function clampRating(raw) {
  if (raw == null || raw === "") return null;
  const n = typeof raw === "number" ? raw : typeof raw === "string" && raw.trim() ? Number(raw) : NaN;
  if (!Number.isFinite(n)) return null;
  const clamped = Math.max(1, Math.min(5, n));
  return clamped;
}

function sha1Hex(value) {
  return crypto.createHash("sha1").update(String(value || ""), "utf8").digest("hex");
}

function lowerPart(value) {
  return asString(value).toLowerCase().trim();
}

function computeDedupeKey({ title, text, author, date }) {
  const base = `${lowerPart(title)}|${lowerPart(text)}|${lowerPart(author)}|${asString(date).trim()}`;
  return sha1Hex(base);
}

function normalizeManualReview(candidate) {
  const base = candidate && typeof candidate === "object" ? candidate : {};

  const rating = clampRating(base.rating);
  const title = asString(base.title).trim();
  const text = asString(base.text).trim();
  const author = asString(base.author).trim();
  const date = asString(base.date).trim();
  const urlRaw = asString(base.url).trim();
  const url = urlRaw ? urlRaw : null;

  if (!text) return null;

  const _dedupe_key = computeDedupeKey({ title, text, author, date });

  return {
    id: `manual_${_dedupe_key.slice(0, 12)}`,
    rating: rating == null ? null : rating,
    title,
    text,
    author,
    date,
    source: "manual_notes",
    url,
    _dedupe_key,
  };
}

function computeExistingKey(review) {
  const r = review && typeof review === "object" ? review : {};

  const title = asString(r.title).trim();
  const text = asString(r.text || r.excerpt || r.abstract || r.body || r.content).trim();
  const author = asString(r.author).trim();
  const date = asString(r.date).trim();

  if (!text) return "";
  return computeDedupeKey({ title, text, author, date });
}

function parseJsonArray(text) {
  const raw = asString(text).trim();
  const parsed = JSON.parse(raw);
  if (!Array.isArray(parsed)) throw new Error("JSON notes must be an array");

  const out = [];
  for (const item of parsed) {
    if (typeof item === "string") {
      out.push({ rating: null, title: "", author: "", date: "", text: item, url: null });
      continue;
    }

    if (item && typeof item === "object") {
      const textVal = item.text ?? item.body ?? item.content;
      out.push({
        rating: item.rating,
        title: item.title,
        author: item.author,
        date: item.date,
        text: textVal,
        url: item.url,
      });
    }
  }

  return out;
}

const YAML_KEYS = {
  rating: "rating",
  stars: "rating",
  score: "rating",
  title: "title",
  headline: "title",
  author: "author",
  name: "author",
  user: "author",
  date: "date",
  created: "date",
  time: "date",
  text: "text",
  body: "text",
  content: "text",
  review: "text",
  url: "url",
  link: "url",
  sourceurl: "url",
  source_url: "url",
};

function normalizeYamlKey(keyRaw) {
  const k = asString(keyRaw)
    .trim()
    .toLowerCase()
    .replace(/\s+/g, "")
    .replace(/-/g, "")
    .replace(/_/g, "");
  return k;
}

function looksLikeYamlKeyLine(line) {
  // Only treat "Key: value" lines as keys when the key looks like a human label.
  // This prevents URLs like "https://..." from being mistaken as a key.
  return /^\s*[A-Za-z][A-Za-z0-9 _-]{0,60}:\s*/.test(String(line || ""));
}

function parseYamlBlocks(text) {
  const raw = asString(text).replace(/\r\n/g, "\n");
  const blocks = raw
    .split(/\n{2,}/)
    .map((b) => b.trim())
    .filter(Boolean);

  const out = [];

  for (const block of blocks) {
    const lines = block.split("\n");
    const record = { rating: null, title: "", author: "", date: "", text: "", url: null };

    let currentKey = "";

    for (let i = 0; i < lines.length; i += 1) {
      const line = lines[i];
      const m = line.match(/^\s*([A-Za-z][A-Za-z0-9 _-]{0,60}):\s*(.*)$/);

      if (m) {
        const rawKey = normalizeYamlKey(m[1]);
        const mapped = YAML_KEYS[rawKey];
        currentKey = mapped || "";

        if (!mapped) continue;

        const value = m[2] == null ? "" : String(m[2]);

        if (mapped === "text") {
          const parts = [value.trim()];

          // Multiline text: subsequent lines without a key become continuation
          let j = i + 1;
          for (; j < lines.length; j += 1) {
            const nextLine = lines[j];
            if (looksLikeYamlKeyLine(nextLine)) break;
            parts.push(String(nextLine || "").replace(/^\s+/, ""));
          }

          record.text = parts.join("\n").trim();
          i = j - 1;
          continue;
        }

        if (mapped === "rating") record.rating = value;
        else if (mapped === "title") record.title = value;
        else if (mapped === "author") record.author = value;
        else if (mapped === "date") record.date = value;
        else if (mapped === "url") record.url = value;

        continue;
      }

      // Continuation lines: only apply to text
      if (currentKey === "text") {
        record.text = `${record.text || ""}${record.text ? "\n" : ""}${String(line || "").replace(/^\s+/, "")}`.trim();
      }
    }

    const hasAny =
      asString(record.text).trim() ||
      asString(record.title).trim() ||
      asString(record.author).trim() ||
      asString(record.date).trim() ||
      asString(record.url).trim() ||
      asString(record.rating).trim();

    if (!hasAny) continue;

    out.push(record);
  }

  return out;
}

function parseDelimitedBlocks(text) {
  const raw = asString(text).replace(/\r\n/g, "\n");
  const lines = raw.split("\n");

  const blocks = [];
  let current = null;

  for (const line of lines) {
    if (String(line || "").trim() === "---") {
      if (current && current.length) blocks.push(current);
      current = [];
      continue;
    }
    if (current) current.push(line);
  }
  if (current && current.length) blocks.push(current);

  const out = [];

  for (const blockLines of blocks) {
    const trimmed = blockLines.map((l) => String(l || ""));

    // Remove leading/trailing empty lines
    while (trimmed.length && !trimmed[0].trim()) trimmed.shift();
    while (trimmed.length && !trimmed[trimmed.length - 1].trim()) trimmed.pop();
    if (trimmed.length === 0) continue;

    const headerLine = trimmed[0];
    const parts = headerLine
      .split("|")
      .map((p) => p.trim())
      .slice(0, 4);

    const rating = parts[0] || "";
    const titleRaw = parts[1] || "";
    const authorRaw = parts[2] || "";
    const date = parts[3] || "";

    const title = /\(no title\)/i.test(titleRaw) ? "" : titleRaw;
    const author = /\(anonymous\)/i.test(authorRaw) ? "" : authorRaw;

    const bodyLines = trimmed.slice(1);
    let url = null;
    const textLines = [];

    for (const l of bodyLines) {
      const m = String(l || "").match(/^\s*url\s*:\s*(.+)$/i);
      if (m && !url) {
        url = m[1].trim();
        continue;
      }
      textLines.push(l);
    }

    const textOut = textLines.join("\n").trim();

    out.push({ rating, title, author, date, text: textOut, url });
  }

  return out;
}

function parseNotesToCandidates(notesText) {
  const raw = asString(notesText);
  const trimmed = raw.trim();
  if (!trimmed) return { candidates: [], format: "" };

  if (trimmed.startsWith("[")) {
    const candidates = parseJsonArray(trimmed);
    return { candidates, format: "json" };
  }

  const yamlCandidates = parseYamlBlocks(raw);
  // Only treat the input as YAML-ish if at least one block contains a Text/body/content field.
  // This prevents delimited blocks (---) that happen to contain "URL:" lines from being
  // misclassified as YAML.
  const yamlHasText = Array.isArray(yamlCandidates) && yamlCandidates.some((c) => asString(c?.text).trim());
  if (yamlCandidates.length > 0 && yamlHasText) return { candidates: yamlCandidates, format: "yaml" };

  const delimitedCandidates = parseDelimitedBlocks(raw);
  if (delimitedCandidates.length > 0) return { candidates: delimitedCandidates, format: "delimited" };

  return { candidates: [], format: "" };
}

function dedupeParsedNormalized(normalized) {
  const seen = new Set();
  const out = [];
  for (const r of normalized) {
    const k = asString(r?._dedupe_key).trim();
    if (!k) continue;
    if (seen.has(k)) continue;
    seen.add(k);
    out.push(r);
  }
  return out;
}

async function adminApplyReviewsFromNotesHandler(req, context, deps = {}) {
  const method = String(req?.method || "").toUpperCase();
  if (method === "OPTIONS") return json({}, 200);

  const company_id =
    (context && context.bindingData && (context.bindingData.company_id || context.bindingData.companyId)) ||
    (req && req.params && (req.params.company_id || req.params.companyId)) ||
    "";

  const requestedCompanyId = asString(company_id).trim();

  if (!requestedCompanyId) {
    return json({ ok: false, root_cause: "bad_request", message: "Missing company_id", retryable: false, warnings: [] }, 200);
  }

  const body = await readJsonBody(req);
  const modeRaw = asString(body?.mode).trim().toLowerCase();
  const mode = modeRaw === "replace" ? "replace" : "append";
  const dry_run = Boolean(body?.dry_run ?? body?.dryRun ?? false);

  if (modeRaw && modeRaw !== "append" && modeRaw !== "replace") {
    return json(
      {
        ok: false,
        root_cause: "bad_request",
        message: `Invalid mode: ${modeRaw}`,
        retryable: false,
        warnings: [],
      },
      200
    );
  }

  const companiesContainer = deps.companiesContainer || getCompaniesContainer();
  if (!companiesContainer) {
    return json(
      {
        ok: false,
        root_cause: "cosmos_write_error",
        message: "Cosmos not configured",
        retryable: true,
        warnings: [],
      },
      200
    );
  }

  let company;
  try {
    company = await getCompanyByCompanyId(companiesContainer, requestedCompanyId);
  } catch (e) {
    return json(
      {
        ok: false,
        root_cause: "bad_request",
        message: asString(e?.message || e) || "Company not found",
        retryable: false,
        warnings: [],
      },
      200
    );
  }

  const notesOverride = asString(body?.notes_text ?? body?.notesText ?? "").trim();
  const notes = notesOverride || asString(company?.notes).trim();
  if (!notes) {
    return json(
      {
        ok: false,
        root_cause: "parse_error",
        message: "Notes are empty",
        retryable: false,
        warnings: [],
      },
      200
    );
  }

  let candidates;
  let parsedFormat = "";
  try {
    const parsed = parseNotesToCandidates(notes);
    candidates = parsed.candidates;
    parsedFormat = parsed.format;
  } catch (e) {
    return json(
      {
        ok: false,
        root_cause: "parse_error",
        message: asString(e?.message || e) || "Failed to parse notes",
        retryable: false,
        warnings: [],
      },
      200
    );
  }

  const normalized = candidates.map(normalizeManualReview).filter(Boolean);

  if (normalized.length === 0) {
    return json(
      {
        ok: false,
        root_cause: "parse_error",
        message: "No reviews parsed from notes",
        retryable: false,
        warnings: [],
      },
      200
    );
  }

  const parsed_count = normalized.length;
  const dedupedParsed = dedupeParsedNormalized(normalized);

  const existing = Array.isArray(company?.curated_reviews) ? company.curated_reviews : [];
  const existingKeys = new Set();
  for (const r of existing) {
    const k = asString(r?._dedupe_key).trim() || computeExistingKey(r);
    if (k) existingKeys.add(k);
  }

  const warnings = [];
  if (parsedFormat) warnings.push(`parsed_format:${parsedFormat}`);
  if (dedupedParsed.length !== parsed_count) warnings.push(`deduped_within_notes:${parsed_count - dedupedParsed.length}`);

  let updatedCurated;
  let saved_count;

  if (mode === "replace") {
    updatedCurated = dedupedParsed;
    saved_count = updatedCurated.length;
  } else {
    const toAdd = [];
    for (const r of dedupedParsed) {
      if (!existingKeys.has(r._dedupe_key)) {
        toAdd.push(r);
      }
    }
    updatedCurated = toAdd.length ? existing.concat(toAdd) : existing;
    saved_count = toAdd.length;
  }

  const review_count = updatedCurated.length;

  if (dry_run) {
    return json(
      {
        ok: true,
        parsed_count,
        saved_count,
        review_count,
        warnings,
        preview: dedupedParsed.slice(0, 25),
      },
      200
    );
  }

  const now = deps.nowIso ? deps.nowIso() : nowIso();
  const cursor = company.review_cursor && typeof company.review_cursor === "object" ? { ...company.review_cursor } : {};
  cursor.source = "manual_notes";
  cursor.last_success_at = now;

  const patch = {
    curated_reviews: updatedCurated,
    review_count,
    reviews_last_updated_at: now,
    review_cursor: cursor,
  };

  try {
    const patchRes = await patchCompany(companiesContainer, company, patch);

    if (!patchRes.ok) {
      // Fallback: upsert full doc
      const merged = { ...(company || {}), ...patch };
      const pk = asString(company?.normalized_domain || merged?.normalized_domain || "unknown").trim() || "unknown";
      await companiesContainer.items.upsert(merged, { partitionKey: pk });
    }
  } catch (e) {
    return json(
      {
        ok: false,
        root_cause: "cosmos_write_error",
        message: asString(e?.message || e) || "Cosmos write failed",
        retryable: true,
        warnings,
      },
      200
    );
  }

  return json(
    {
      ok: true,
      parsed_count,
      saved_count,
      review_count,
      warnings,
    },
    200
  );
}

app.http("adminApplyReviewsFromNotes", {
  route: "admin/companies/{company_id}/apply-reviews-from-notes",
  methods: ["POST", "OPTIONS"],
  authLevel: "anonymous",
  handler: (req, context) => adminApplyReviewsFromNotesHandler(req, context),
});

module.exports = {
  handler: adminApplyReviewsFromNotesHandler,
  _test: {
    adminApplyReviewsFromNotesHandler,
    parseNotesToCandidates,
    normalizeManualReview,
    dedupeParsedNormalized,
    computeDedupeKey,
  },
};
