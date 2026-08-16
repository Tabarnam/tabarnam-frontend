import { normalizeStructuredLocationEntry } from "./dashboardUtils";


// ── helpers ──────────────────────────────────────────────────────────

function asStr(v) {
  if (v == null) return "";
  if (typeof v === "string") return v;
  return String(v);
}

/**
 * Parse a semicolon-separated location string into structured entries.
 * "City, State, Country; City2, State2, Country2" → [{city,state,region,country}, ...]
 */
function parseBulkLocations(text) {
  if (!text || typeof text !== "string") return [];
  return text
    .split(";")
    .map((chunk) => {
      const parts = chunk.split(",").map((p) => p.trim()).filter(Boolean);
      if (parts.length === 0) return null;
      const [city = "", region = "", country = ""] = parts;
      return normalizeStructuredLocationEntry({ city, region, state: region, country });
    })
    .filter(Boolean);
}

/**
 * Parse a semicolon-separated street-address string into structured entries.
 * Format per entry (5 comma-separated parts): street, locality, region,
 * postal_code, country. Missing country defaults to "US". Entries with an
 * empty street are dropped (city-only entries belong in HQ:/Mfg:, not here).
 *
 * Emitted entries match api/_addresses.js shape so the backend's normalizer
 * accepts them unchanged. is_public defaults to false — admin flips per-entry
 * in the AddressesEditor after apply. type comes from the caller (label).
 */
function parseBulkAddresses(text, type) {
  if (!text || typeof text !== "string") return [];
  const nowIso = new Date().toISOString();
  return text
    .split(";")
    .map((chunk) => {
      // Preserve positions — do NOT filter empty parts before destructuring,
      // or `, Chicago, IL, ...` would silently shift Chicago into the street
      // slot and pass the non-empty gate.
      const parts = chunk.split(",").map((p) => p.trim());
      const [street = "", locality = "", region = "", postal_code = "", country = ""] = parts;
      if (!street) return null;
      return {
        street,
        locality,
        region,
        postal_code,
        country: country || "US",
        type,
        source_url: "",
        fetched_at: nowIso,
        is_public: false,
      };
    })
    .filter(Boolean);
}

// ── field-label regex ────────────────────────────────────────────────

// 2026-08-16 — accept "Mfg" as an abbreviated Manufacturing label alongside
// the full word (paired with the "mfg" the bulk-paste dialog placeholder
// hints at, and matched by admins pasting Grok output that shortened it).
// The address-branch (HQ|Mfg)\s+(address...) already accepted both forms;
// only the location branch was full-word-only, so "Mfg: Aÿ-Champagne,
// France" fell through and the field silently didn't populate.
const FIELD_LABEL_RE =
  /^\s*(Tagline|Website|URL|HQ|Headquarters(?:\s+locations?)?|Manufacturing(?:\s+locations?)?|Mfg(?:\s+locations?)?|Industries|Products|Keywords|Reviews|(?:HQ|Mfg)\s+(?:address(?:es)?|street\s*#?\s*s))\s*:\s*(.*)$/i;

function normalizeFieldLabel(raw) {
  const l = raw.trim().toLowerCase().replace(/\s+/g, " ");
  if (l === "tagline") return "tagline";
  if (/^hq\s+(?:address(?:es)?|street\s*#?\s*s)$/.test(l))  return "hq_addresses";
  if (/^mfg\s+(?:address(?:es)?|street\s*#?\s*s)$/.test(l)) return "mfg_addresses";
  if (l === "hq" || l.startsWith("headquarters")) return "headquarters_locations";
  if (l.startsWith("manufacturing") || l === "mfg" || l.startsWith("mfg location")) return "manufacturing_locations";
  if (l === "industries") return "industries";
  if (l === "keywords" || l === "products") return "keywords";
  if (l === "website" || l === "url") return "website_url";
  if (l === "reviews") return null; // section label only — consumed but ignored
  return null;
}

// ── review-block YAML parser (ported from server-side) ───────────────

const REVIEW_YAML_KEYS = {
  rating: "rating", stars: "rating", score: "rating",
  title: "title", headline: "title",
  author: "author", name: "author", user: "author",
  date: "date", created: "date", time: "date",
  text: "text", body: "text", content: "text",
  review: "text", excerpt: "text", summary: "text",
  url: "url", link: "url", sourceurl: "url", source_url: "url",
  sourcename: "source_name", source: "source_name", sourcename: "source_name",
};

function normalizeYamlKey(keyRaw) {
  return asStr(keyRaw).trim().toLowerCase().replace(/[\s_-]/g, "");
}

function looksLikeYamlKeyLine(line) {
  return /^\s*[A-Za-z][A-Za-z0-9 _-]{0,60}:\s*/.test(String(line || ""));
}

function looksLikeReviewBlock(block) {
  return /^\s*Source\s*:/im.test(block);
}

function parseReviewBlock(block) {
  const lines = block.split("\n");
  const record = { rating: null, title: "", author: "", date: "", text: "", url: null, source_name: "" };
  let currentKey = "";

  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i];
    const m = line.match(/^\s*([A-Za-z][A-Za-z0-9 _-]{0,60}):\s*(.*)$/);

    if (m) {
      const rawKey = normalizeYamlKey(m[1]);
      const mapped = REVIEW_YAML_KEYS[rawKey];
      currentKey = mapped || "";
      if (!mapped) continue;

      const value = m[2] == null ? "" : String(m[2]);

      if (mapped === "text") {
        const parts = [value.trim()];
        let j = i + 1;
        for (; j < lines.length; j += 1) {
          if (looksLikeYamlKeyLine(lines[j])) break;
          parts.push(String(lines[j] || "").replace(/^\s+/, ""));
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
      else if (mapped === "source_name") record.source_name = value;
      continue;
    }

    if (currentKey === "text") {
      record.text = `${record.text || ""}${record.text ? "\n" : ""}${String(line || "").replace(/^\s+/, "")}`.trim();
    }
  }

  const hasAny =
    asStr(record.text).trim() ||
    asStr(record.title).trim() ||
    asStr(record.author).trim() ||
    asStr(record.url).trim() ||
    asStr(record.source_name).trim();

  return hasAny ? record : null;
}

function normalizeReview(r) {
  const text = asStr(r.text).trim();
  const title = asStr(r.title).trim();
  const author = asStr(r.author).trim();
  const date = asStr(r.date).trim();
  const url = asStr(r.url).trim() || null;
  const source_name = asStr(r.source_name).trim();

  if (!text && !title) return null;

  return {
    source_name: source_name || "",
    author,
    url,
    title,
    date,
    text,
    excerpt: text,
    abstract: text,
    content: text,
  };
}

// ── main parser ──────────────────────────────────────────────────────

/**
 * Parse a full Grok AI bulk response into a proposed-company object
 * compatible with the refresh diff UI.
 *
 * Expected labeled format:
 *   Company Name
 *   Website: https://example.com
 *   Tagline: ...
 *   HQ: City, ST, Country; City2, ST2, Country2
 *   Manufacturing: City, ST, Country; ...
 *   Industries: ind1, ind2, ind3
 *   Keywords: kw1, kw2, kw3
 *
 *   Source: YouTube
 *   Author: ...
 *   URL: ...
 *   Title: ...
 *   Date: ...
 *   Text: ...
 *
 * @param {string} text — raw pasted text
 * @returns {{ proposed: object, companyNameLine: string, warnings: string[] }}
 */
export function parseBulkPasteText(text) {
  const warnings = [];

  // Normalize
  let raw = asStr(text).replace(/\r\n/g, "\n").replace(/\*\*/g, "");

  // A "Reviews:" section label may sit inline with the first review's "Source:"
  // field ("Reviews: Source: Wine Enthusiast"). Strip the inline label so the
  // line starts at "Source:" and the block below is recognized as a review.
  // Without this, that first review block is parsed as company header fields —
  // and its "URL:" line becomes website_url, clobbering the real website on
  // apply (regression: C.H. Berres, 2026-08-14).
  raw = raw.replace(/^[ \t]*Reviews\s*:[ \t]*(?=Source\s*:)/gim, "");

  // Ensure each "Source:" line (review block start) is preceded by a blank
  // line.  This prevents header fields from being swallowed into a review
  // block when the paste has no blank line between headers and reviews.
  raw = raw.replace(/\n([ \t]*Source\s*:)/gi, "\n\n$1");

  // Split into blank-line-delimited blocks
  const blocks = raw.split(/\n{2,}/).map((b) => b.trim()).filter(Boolean);

  if (blocks.length === 0) {
    return { proposed: {}, companyNameLine: "", warnings: ["Empty input"] };
  }

  // ── pass 1: separate header lines from review blocks ──

  const headerLines = [];   // non-review lines from the top
  const reviewBlocks = [];  // blocks that look like reviews
  let hitFirstReview = false;

  for (const block of blocks) {
    if (looksLikeReviewBlock(block)) {
      hitFirstReview = true;
      reviewBlocks.push(block);
    } else if (hitFirstReview) {
      // non-review block after reviews started — still treat as review
      // (could be a malformed review block)
      reviewBlocks.push(block);
    } else {
      // header block — split its lines for field parsing
      for (const line of block.split("\n")) {
        headerLines.push(line);
      }
    }
  }

  // ── pass 2: parse header lines ──

  let companyNameLine = "";
  const fields = {};   // { tagline, headquarters_locations, ... }
  let firstNonEmptyConsumed = false;

  for (const line of headerLines) {
    const trimmed = line.trim();
    if (!trimmed) continue;

    // Try labeled match
    const m = trimmed.match(FIELD_LABEL_RE);
    if (m) {
      const fieldKey = normalizeFieldLabel(m[1]);
      const value = (m[2] || "").trim();
      if (fieldKey && value) {
        // Append to existing value if field appears on multiple lines
        fields[fieldKey] = fields[fieldKey] ? `${fields[fieldKey]}, ${value}` : value;
      }
      firstNonEmptyConsumed = true;
      continue;
    }

    // First non-labeled, non-empty line = company name
    if (!firstNonEmptyConsumed) {
      companyNameLine = trimmed;
      firstNonEmptyConsumed = true;
      continue;
    }

    // Subsequent unlabeled lines are ignored (ambiguous without labels)
  }

  // ── pass 3: convert parsed field strings to structured data ──

  const proposed = {};

  if (companyNameLine) {
    proposed.company_name = companyNameLine;
  }

  if (fields.website_url) {
    proposed.website_url = fields.website_url.trim();
  }

  if (fields.tagline) {
    proposed.tagline = fields.tagline;
  }

  if (fields.headquarters_locations) {
    const locs = parseBulkLocations(fields.headquarters_locations);
    if (locs.length) proposed.headquarters_locations = locs;
  }

  if (fields.manufacturing_locations) {
    const locs = parseBulkLocations(fields.manufacturing_locations);
    if (locs.length) proposed.manufacturing_locations = locs;
  }

  if (fields.industries) {
    const list = fields.industries.split(",").map((s) => s.trim()).filter(Boolean);
    if (list.length) proposed.industries = list;
  }

  if (fields.keywords) {
    const list = fields.keywords.split(",").map((s) => s.trim()).filter(Boolean);
    if (list.length) proposed.keywords = list;
  }

  // Structured addresses. Two labels (HQ address / Mfg address) map to
  // type=hq / type=manufacturing and merge into a single addresses array so
  // the downstream diff view + AddressesEditor see one field.
  const hqAddrs = fields.hq_addresses ? parseBulkAddresses(fields.hq_addresses, "hq") : [];
  const mfgAddrs = fields.mfg_addresses ? parseBulkAddresses(fields.mfg_addresses, "manufacturing") : [];
  const addressesMerged = [...hqAddrs, ...mfgAddrs];
  if (addressesMerged.length) proposed.addresses = addressesMerged;

  // ── pass 4: parse review blocks ──

  const reviews = [];
  for (const block of reviewBlocks) {
    const parsed = parseReviewBlock(block);
    if (!parsed) continue;
    const normalized = normalizeReview(parsed);
    if (normalized) reviews.push(normalized);
  }

  if (reviews.length) {
    proposed.curated_reviews = reviews;
  }

  // ── warnings ──

  if (!companyNameLine) warnings.push("No company name found (expected first line)");
  if (!fields.website_url) warnings.push("No website URL found");
  if (!fields.tagline) warnings.push("No tagline found");
  if (!fields.headquarters_locations) warnings.push("No HQ location found");
  if (!fields.manufacturing_locations) warnings.push("No manufacturing locations found");
  if (!fields.industries) warnings.push("No industries found");
  if (!fields.keywords) warnings.push("No keywords found");
  if (reviews.length === 0) warnings.push("No reviews found");

  return { proposed, companyNameLine, warnings };
}
