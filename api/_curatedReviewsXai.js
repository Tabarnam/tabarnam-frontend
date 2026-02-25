const crypto = require("crypto");

function asString(value) {
  return typeof value === "string" ? value : value == null ? "" : String(value);
}

function safeJsonParse(text) {
  if (typeof text !== "string") return null;
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

/**
 * Repair malformed JSON where Grok wraps fields in orphan { } objects without keys.
 * Example malformation:
 *   { "tagline": "...", { "hq": "NYC" }, { "mfg": ["LA"] }, "industries": [...] }
 * Repaired:
 *   { "tagline": "...", "hq": "NYC", "mfg": ["LA"], "industries": [...] }
 *
 * Walks the string tracking brace depth and string state. Any { at depth >= 1
 * that is NOT preceded by : is an orphan — remove its { and matching }.
 */
function repairOrphanObjects(text) {
  const raw = typeof text === "string" ? text.trim() : "";
  if (!raw || raw[0] !== "{") return null;

  const remove = new Set();
  // Stack tracks each { we encounter: { isOrphan: bool }
  const braceStack = [];
  let depth = 0;
  let inStr = false;
  let esc = false;

  for (let i = 0; i < raw.length; i++) {
    const ch = raw[i];
    if (esc) { esc = false; continue; }
    if (ch === "\\" && inStr) { esc = true; continue; }
    if (ch === '"') { inStr = !inStr; continue; }
    if (inStr) continue;

    if (ch === "{") {
      let isOrphan = false;
      if (depth >= 1) {
        // Check if preceded by : (skip whitespace) — normal key:value pattern
        let j = i - 1;
        while (j >= 0 && /\s/.test(raw[j])) j--;
        if (j < 0 || raw[j] !== ":") {
          isOrphan = true;
          remove.add(i);
        }
      }
      braceStack.push({ isOrphan });
      depth++;
    } else if (ch === "}") {
      depth--;
      const entry = braceStack.pop();
      if (entry && entry.isOrphan) {
        remove.add(i);
      }
    }
  }

  if (remove.size === 0) return null;

  const repaired = [...raw].filter((_, idx) => !remove.has(idx)).join("");
  return safeJsonParse(repaired);
}

function extractJsonFromText(text) {
  const raw = asString(text).trim();
  if (!raw) return null;

  const direct = safeJsonParse(raw);
  if (direct != null) return direct;

  // Prefer object extraction first, as it can contain embedded arrays and metadata.
  const objStart = raw.indexOf("{");
  const objEnd = raw.lastIndexOf("}");
  if (objStart !== -1 && objEnd !== -1 && objEnd > objStart) {
    const slice = raw.slice(objStart, objEnd + 1);
    const parsed = safeJsonParse(slice);
    if (parsed != null) return parsed;

    // Repair: Grok sometimes wraps fields in orphan { } objects without keys.
    // This is invalid JSON but the data inside is valid — unwrap and retry.
    const repaired = repairOrphanObjects(slice);
    if (repaired != null) {
      console.log(`[extractJsonFromText] Repaired orphan objects in malformed JSON`);
      return repaired;
    }
  }

  // Fallback: try extracting an array.
  const arrStart = raw.indexOf("[");
  const arrEnd = raw.lastIndexOf("]");
  if (arrStart !== -1 && arrEnd !== -1 && arrEnd > arrStart) {
    const slice = raw.slice(arrStart, arrEnd + 1);
    const parsed = safeJsonParse(slice);
    if (parsed != null) return parsed;
  }

  return null;
}

function normalizeUpstreamReviewsResult(result, opts = {}) {
  const fallbackOffset = Math.max(0, Math.trunc(Number(opts.fallbackOffset ?? 0) || 0));

  const base = result && typeof result === "object" ? result : null;
  const isArray = Array.isArray(result);

  if (!base && !isArray) {
    return {
      reviews: [],
      next_offset: fallbackOffset,
      exhausted: null,
      parse_error: "no_json_found",
    };
  }

  const unwrapReviewsValue = (value) => {
    if (Array.isArray(value)) return value;
    if (typeof value === "string") {
      const parsed = safeJsonParse(value.trim());
      if (Array.isArray(parsed)) return parsed;
    }
    return [];
  };

  const reviews = isArray
    ? result
    : unwrapReviewsValue(base.reviews ?? base.items ?? base.proposed_reviews ?? base.proposedReviews);

  const next_offset_raw = isArray ? null : base.next_offset ?? base.nextOffset ?? null;
  const exhausted_raw = isArray ? null : base.exhausted ?? base.done ?? null;

  const next_offset =
    typeof next_offset_raw === "number" && Number.isFinite(next_offset_raw)
      ? next_offset_raw
      : fallbackOffset + (Array.isArray(reviews) ? reviews.length : 0);

  const exhausted = typeof exhausted_raw === "boolean" ? exhausted_raw : null;

  return {
    reviews: Array.isArray(reviews) ? reviews : [],
    next_offset,
    exhausted,
    parse_error: null,
  };
}

function computeReviewDedupeKey(review) {
  const r = review && typeof review === "object" ? review : {};
  const url = asString(r.source_url || r.url).trim().toLowerCase();
  const title = asString(r.title).trim().toLowerCase();
  const author = asString(r.author).trim().toLowerCase();
  const date = asString(r.date).trim();
  const rating = r.rating == null ? "" : String(r.rating);
  const excerpt = asString(r.excerpt || r.abstract || r.text).trim().toLowerCase().slice(0, 160);

  const base = [url, title, author, date, rating, excerpt].filter(Boolean).join("|");
  if (!base) return "";

  try {
    return crypto.createHash("sha1").update(base).digest("hex");
  } catch {
    return base;
  }
}

module.exports = {
  asString,
  safeJsonParse,
  extractJsonFromText,
  normalizeUpstreamReviewsResult,
  computeReviewDedupeKey,
};
