// Plain-English rendering of company edit-history entries.
//
// The audit log stores raw top-level field diffs (`amazon_url`, `unknown_hq`,
// `enrichment_health`…). Those names tell an admin nothing about what actually
// happened. Everything here turns one diff entry into a sentence a second admin
// can read without being taught the schema:
//
//   amazon_url        →  "Amazon store link — set to amazon.com/stores/foo"
//   amazon_url_approved → "Amazon link — approved"
//   unknown_manufacturing → "Marked manufacturing location as unknown"
//
// It also separates fields an admin deliberately edited from derived bookkeeping
// the server rewrites on every save (search tokens, issue counts, enrichment
// health). Those are tagged `system: true` so the UI can fold them away — most
// of the noise in a raw entry is them.

export function asString(value) {
  return typeof value === "string" ? value : value == null ? "" : String(value);
}

// MUST always return a string. JSON.stringify RETURNS undefined (it does not
// throw) for undefined/functions/symbols, and a diff entry legitimately has an
// undefined `before` when the field was newly added — the raw result used to
// crash the renderer on text.length.
export function pretty(value) {
  if (typeof value === "string") return value;
  if (value === undefined) return "—";
  try {
    const out = JSON.stringify(value, null, 2);
    return typeof out === "string" ? out : asString(value);
  } catch {
    return asString(value);
  }
}

// ── field vocabulary ────────────────────────────────────────────────
//
// label   — what an admin calls this in the editor UI
// system  — server-derived; changes on its own, not an admin decision
// type    — how to summarize a change: text | url | list | locations |
//           flag | rating | count | blob

const FIELD_META = {
  company_name: { label: "Company name", type: "text" },
  name: { label: "Display name", type: "text" },
  website_url: { label: "Website", type: "url" },
  url: { label: "Website", type: "url" },
  tagline: { label: "Tagline", type: "text" },
  email: { label: "Contact email", type: "text" },
  phone: { label: "Contact phone", type: "text" },

  industries: { label: "Industries", type: "list" },
  keywords: { label: "Products", type: "list" },
  product_keywords: { label: "Products", type: "list" },
  keywords_completeness: { label: "Products completeness", type: "text" },
  keywords_complete_acknowledged: {
    label: "Products list",
    type: "flag",
    on: "Confirmed the products list is complete",
    off: "Withdrew the products-list-complete confirmation",
  },

  headquarters_locations: { label: "Headquarters", type: "locations" },
  headquarters: { label: "Headquarters", type: "locations" },
  headquarters_location: { label: "Headquarters", type: "text" },
  manufacturing_locations: { label: "Manufacturing locations", type: "locations" },
  manufacturing_geocodes: { label: "Manufacturing locations", type: "locations" },
  location_sources: { label: "Location sources", type: "blob" },
  show_location_sources_to_users: {
    label: "Location sources",
    type: "flag",
    on: "Made location sources visible to users",
    off: "Hid location sources from users",
  },
  unknown_hq: {
    label: "Headquarters",
    type: "flag",
    on: "Marked the headquarters as unknown",
    off: "Cleared the unknown-headquarters mark",
  },
  unknown_manufacturing: {
    label: "Manufacturing",
    type: "flag",
    on: "Marked the manufacturing location as unknown",
    off: "Cleared the unknown-manufacturing mark",
  },
  limited_manufacturing: {
    label: "Manufacturing",
    type: "flag",
    on: "Marked manufacturing as limited",
    off: "Cleared the limited-manufacturing mark",
  },

  amazon_url: { label: "Amazon store link", type: "url" },
  amazon_store_url: { label: "Amazon store link", type: "url" },
  amazon_url_short: { label: "Amazon short link", type: "url" },
  amazon_url_approved: {
    label: "Amazon link",
    type: "flag",
    on: "Approved the Amazon store link",
    off: "Withdrew approval of the Amazon store link",
  },
  no_amazon_store: {
    label: "Amazon store",
    type: "flag",
    on: "Marked this company as having no Amazon store",
    off: "Cleared the no-Amazon-store mark",
  },
  affiliate_link_urls: { label: "Affiliate links", type: "list" },

  logo_url: { label: "Logo image", type: "url" },
  logo_approved: {
    label: "Logo",
    type: "flag",
    on: "Approved the logo",
    off: "Withdrew approval of the logo",
  },
  homepage_image_url: { label: "Homepage screenshot", type: "url" },
  homepage_issue_cleared: {
    label: "Homepage screenshot",
    type: "flag",
    on: "Dismissed the missing-homepage-screenshot issue",
    off: "Restored the missing-homepage-screenshot issue",
  },

  reviews: { label: "Reviews", type: "count" },
  curated_reviews: { label: "Curated reviews", type: "count" },
  no_reviews: {
    label: "Reviews",
    type: "flag",
    on: "Marked this company as having no reviews to find",
    off: "Cleared the no-reviews mark",
  },

  rating: { label: "Star rating", type: "rating" },
  visibility: { label: "Visibility", type: "text" },
  is_published: { label: "Publication", type: "flag", on: "Published the company", off: "Unpublished the company" },
  published: { label: "Publication", type: "flag", on: "Published the company", off: "Unpublished the company" },

  notes: { label: "Admin notes", type: "text" },
  notes_entries: { label: "Admin notes", type: "count" },

  // Server-derived. Rewritten on nearly every save; never an admin decision.
  enrichment_health: { label: "Enrichment health", type: "blob", system: true },
  search_tokens: { label: "Search tokens", type: "list", system: true },
  issues_count: { label: "Open issues count", type: "count", system: true },
  qq_score: { label: "Quality score", type: "count", system: true },
  normalized_domain: { label: "Normalized domain", type: "text", system: true },
  last_enriched_at: { label: "Last enriched", type: "text", system: true },
  _kwRelevantCount: { label: "Keyword cache count", type: "count", system: true },
  _kwCacheKey: { label: "Keyword cache key", type: "text", system: true },
};

function metaFor(field) {
  const key = asString(field).trim();
  const hit = FIELD_META[key];
  if (hit) return { key, ...hit };

  // Unknown field: humanize the key rather than showing raw snake_case, and
  // treat obvious internals (leading underscore, sort/cache keys) as system.
  const system = key.startsWith("_") || /(^|_)(sort_key|cache|etag|ts)($|_)/.test(key);
  const label = key
    .replace(/^_+/, "")
    .replace(/_/g, " ")
    .replace(/\b\w/g, (c) => c.toUpperCase());
  return { key, label: label || key, type: "blob", system };
}

export function fieldLabel(field) {
  return metaFor(field).label;
}

export function isSystemField(field) {
  return Boolean(metaFor(field).system);
}

// ── value formatting ────────────────────────────────────────────────

function isBlank(v) {
  if (v === undefined || v === null) return true;
  if (typeof v === "string") return v.trim() === "";
  if (Array.isArray(v)) return v.length === 0;
  if (typeof v === "object") return Object.keys(v).length === 0;
  return false;
}

export function shortenUrl(value, maxLen = 60) {
  const raw = asString(value).trim();
  if (!raw) return "";
  const stripped = raw.replace(/^https?:\/\//i, "").replace(/^www\./i, "").replace(/\/$/, "");
  return stripped.length > maxLen ? `${stripped.slice(0, maxLen - 1)}…` : stripped;
}

export function formatLocation(loc) {
  if (typeof loc === "string") return loc.trim();
  if (!loc || typeof loc !== "object") return "";
  const parts = [loc.city, loc.state || loc.region, loc.country]
    .map((p) => asString(p).trim())
    .filter(Boolean);
  if (parts.length > 0) return parts.join(", ");
  for (const k of ["label", "name", "full", "address", "raw", "location"]) {
    const v = asString(loc[k]).trim();
    if (v) return v;
  }
  return "";
}

function toDisplayList(value, type) {
  if (isBlank(value)) return [];
  const arr = Array.isArray(value) ? value : [value];
  const out = [];
  for (const item of arr) {
    const s = type === "locations" ? formatLocation(item) : typeof item === "string" ? item.trim() : pretty(item);
    if (s) out.push(s);
  }
  return out;
}

function quoteText(value, maxLen = 70) {
  const s = asString(value).trim();
  if (!s) return "";
  return s.length > maxLen ? `“${s.slice(0, maxLen - 1)}…”` : `“${s}”`;
}

function countOf(value) {
  if (Array.isArray(value)) return value.length;
  if (typeof value === "number") return value;
  if (isBlank(value)) return 0;
  return null;
}

function joinList(items, maxShown = 4) {
  if (items.length === 0) return "";
  if (items.length <= maxShown) return items.join(", ");
  return `${items.slice(0, maxShown).join(", ")} +${items.length - maxShown} more`;
}

function ratingSummary(before, after) {
  const b = before && typeof before === "object" ? before : {};
  const a = after && typeof after === "object" ? after : {};
  const names = { star1: "Manufacturing", star2: "HQ", star3: "Reviews", star4: "Reputation", star5: "Quality" };
  const bits = [];
  for (const key of Object.keys(names)) {
    const bv = b[key];
    const av = a[key];
    if (JSON.stringify(bv) === JSON.stringify(av)) continue;
    const from = isBlank(bv) ? "unscored" : asString(bv);
    const to = isBlank(av) ? "unscored" : asString(av);
    bits.push(`${names[key]} ${from} → ${to}`);
  }
  return bits.length > 0 ? bits.join(" · ") : "Rating recalculated";
}

/**
 * Turn one field's before/after into a readable line.
 *
 * @returns {{key: string, label: string, system: boolean, tone: string, summary: string,
 *            before: unknown, after: unknown}}
 *   tone ∈ "added" | "removed" | "changed" | "on" | "off"
 */
export function describeChange(field, before, after) {
  const meta = metaFor(field);
  const base = { key: meta.key, label: meta.label, system: Boolean(meta.system), before, after };

  const hadBefore = !isBlank(before);
  const hasAfter = !isBlank(after);

  if (meta.type === "flag") {
    const on = after === true || after === "true";
    return {
      ...base,
      tone: on ? "on" : "off",
      summary: on ? meta.on || `${meta.label} turned on` : meta.off || `${meta.label} turned off`,
    };
  }

  if (meta.type === "rating") {
    return { ...base, tone: "changed", summary: ratingSummary(before, after) };
  }

  if (meta.type === "count") {
    const b = countOf(before);
    const a = countOf(after);
    if (b !== null && a !== null) {
      if (a > b) return { ...base, tone: "added", summary: `${a - b} added (${b} → ${a})` };
      if (a < b) return { ...base, tone: "removed", summary: `${b - a} removed (${b} → ${a})` };
      return { ...base, tone: "changed", summary: `Edited in place (${a} total)` };
    }
    return { ...base, tone: "changed", summary: "Updated" };
  }

  if (meta.type === "list" || meta.type === "locations") {
    const b = toDisplayList(before, meta.type);
    const a = toDisplayList(after, meta.type);
    const bSet = new Set(b.map((s) => s.toLowerCase()));
    const aSet = new Set(a.map((s) => s.toLowerCase()));
    const added = a.filter((s) => !bSet.has(s.toLowerCase()));
    const removed = b.filter((s) => !aSet.has(s.toLowerCase()));

    if (added.length > 0 && removed.length === 0) {
      return { ...base, tone: "added", summary: `Added ${joinList(added)}` };
    }
    if (removed.length > 0 && added.length === 0) {
      return { ...base, tone: "removed", summary: `Removed ${joinList(removed)}` };
    }
    if (added.length > 0 && removed.length > 0) {
      return {
        ...base,
        tone: "changed",
        summary: `Added ${joinList(added, 3)} · removed ${joinList(removed, 3)}`,
      };
    }
    // Same members, different order or nested detail.
    return { ...base, tone: "changed", summary: a.length > 0 ? `Reordered or refined (${a.length})` : "Updated" };
  }

  if (meta.type === "url") {
    if (!hadBefore && hasAfter) return { ...base, tone: "added", summary: `Set to ${shortenUrl(after)}` };
    if (hadBefore && !hasAfter) return { ...base, tone: "removed", summary: `Cleared (was ${shortenUrl(before)})` };
    return { ...base, tone: "changed", summary: `${shortenUrl(before)} → ${shortenUrl(after)}` };
  }

  if (meta.type === "text") {
    if (!hadBefore && hasAfter) return { ...base, tone: "added", summary: `Set to ${quoteText(after)}` };
    if (hadBefore && !hasAfter) return { ...base, tone: "removed", summary: `Cleared (was ${quoteText(before)})` };
    return { ...base, tone: "changed", summary: `${quoteText(before, 40)} → ${quoteText(after, 40)}` };
  }

  // blob / unknown
  if (!hadBefore && hasAfter) return { ...base, tone: "added", summary: "Set" };
  if (hadBefore && !hasAfter) return { ...base, tone: "removed", summary: "Cleared" };
  return { ...base, tone: "changed", summary: "Updated" };
}

// ── entry-level copy ────────────────────────────────────────────────

const SOURCE_LABELS = {
  "admin-ui": "Admin editor",
  admin: "Admin editor",
  import: "Import",
  "bulk-import": "Bulk import",
  "import-start": "Import",
  "resume-worker": "Enrichment worker",
  enrichment: "Enrichment worker",
  scoring: "Scoring",
  api: "API",
};

export function sourceLabel(source) {
  const s = asString(source).trim();
  if (!s) return "";
  return SOURCE_LABELS[s] || s.replace(/[-_]/g, " ");
}

export function actorLabel(entry) {
  const email = asString(entry?.actor_email).trim();
  if (email) return email;
  const uid = asString(entry?.actor_user_id).trim();
  if (uid) return uid;
  return "System";
}

/**
 * Split an entry's diff into admin-meaningful changes and derived noise, and
 * build the one-line headline.
 */
export function describeEntry(entry) {
  const diff = entry?.diff && typeof entry.diff === "object" ? entry.diff : {};
  const action = asString(entry?.action).trim() || "update";

  const all = Object.entries(diff).map(([field, change]) => describeChange(field, change?.before, change?.after));
  const changes = all.filter((c) => !c.system);
  const systemChanges = all.filter((c) => c.system);

  let headline;
  if (action === "create") {
    headline = "Created this company";
  } else if (action === "delete") {
    headline = "Deleted this company";
  } else if (action === "restore") {
    headline = "Restored this company";
  } else if (changes.length === 0 && systemChanges.length > 0) {
    headline = "Saved — no field changes";
  } else if (changes.length === 0) {
    headline = action === "update" ? "Saved with no changes" : action.replace(/[-_]/g, " ");
  } else if (changes.length <= 3) {
    headline = `Edited ${changes.map((c) => c.label.toLowerCase()).join(", ")}`;
  } else {
    headline = `Edited ${changes.length} fields`;
  }

  return { action, headline, changes, systemChanges, actor: actorLabel(entry), source: sourceLabel(entry?.source) };
}

// ── time ────────────────────────────────────────────────────────────

export function formatAbsoluteTime(iso) {
  const raw = asString(iso).trim();
  if (!raw) return "";
  const t = Date.parse(raw);
  if (!Number.isFinite(t)) return raw;
  return new Date(t).toLocaleString();
}

export function formatRelativeTime(iso, now = Date.now()) {
  const raw = asString(iso).trim();
  if (!raw) return "";
  const t = Date.parse(raw);
  if (!Number.isFinite(t)) return raw;
  const sec = Math.floor((now - t) / 1000);
  if (sec < 0) return "just now";
  if (sec < 60) return `${sec}s ago`;
  const min = Math.floor(sec / 60);
  if (min < 60) return `${min}m ago`;
  const hr = Math.floor(min / 60);
  if (hr < 24) return `${hr}h ago`;
  const day = Math.floor(hr / 24);
  if (day < 7) return `${day}d ago`;
  return new Date(t).toLocaleDateString();
}

/** "Today" / "Yesterday" / "Jul 18, 2026" — the timeline's day separator. */
export function dayHeading(iso, now = Date.now()) {
  const raw = asString(iso).trim();
  const t = Date.parse(raw);
  if (!Number.isFinite(t)) return "Unknown date";

  const d = new Date(t);
  const today = new Date(now);
  const startOf = (x) => new Date(x.getFullYear(), x.getMonth(), x.getDate()).getTime();
  const dayDelta = Math.round((startOf(today) - startOf(d)) / 86400000);

  if (dayDelta === 0) return "Today";
  if (dayDelta === 1) return "Yesterday";
  return d.toLocaleDateString(undefined, { year: "numeric", month: "short", day: "numeric" });
}
