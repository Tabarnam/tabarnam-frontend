import { calculateInitialRating, clampStarValue, normalizeRating } from "@/lib/stars/calculateRating";
import { normalizeExternalUrl } from "@/lib/externalUrl";

export const DEFAULT_TAKE = 200;

export function asString(value) {
  return typeof value === "string" ? value : value == null ? "" : String(value);
}

export function prettyJson(value) {
  try {
    return JSON.stringify(value, null, 2);
  } catch {
    return asString(value);
  }
}

export function getResponseHeadersForDebug(res) {
  const headers = res?.headers;
  const pick = (name) => {
    try {
      return asString(headers?.get?.(name)).trim();
    } catch {
      return "";
    }
  };

  return {
    "content-type": pick("content-type"),
    "x-api-handler": pick("x-api-handler"),
    "x-api-build-id": pick("x-api-build-id"),
    "x-api-build-source": pick("x-api-build-source"),
    "x-api-version": pick("x-api-version"),
    "x-request-id": pick("x-request-id"),
    "x-ms-request-id": pick("x-ms-request-id"),
    "x-functions-execution-id": pick("x-functions-execution-id"),
  };
}

export function deepClone(value) {
  if (typeof structuredClone === "function") {
    try {
      return structuredClone(value);
    } catch {
      // ignore
    }
  }

  try {
    return JSON.parse(JSON.stringify(value));
  } catch {
    return value;
  }
}

export function normalizeBuildIdString(value) {
  const s = asString(value).trim();
  if (!s) return "";
  const m = s.match(/[0-9a-f]{7,40}/i);
  return m ? m[0] : s;
}

export function normalizeHttpStatusNumber(value) {
  if (typeof value === "number" && Number.isFinite(value)) return value;

  if (typeof value === "string") {
    const s = value.trim();
    if (!s) return null;
    if (/^\d+$/.test(s)) return Number(s);
  }

  return null;
}

export async function fetchStaticBuildId() {
  try {
    const res = await fetch("/__build_id.txt", { cache: "no-store" });
    if (!res.ok) return "";
    const txt = await res.text();
    return normalizeBuildIdString(txt);
  } catch {
    return "";
  }
}

export function normalizeLocationList(value) {
  if (Array.isArray(value)) {
    return value.map((v) => asString(v).trim()).filter(Boolean);
  }
  const s = asString(value).trim();
  if (!s) return [];
  return s
    .split(/\s*[,;|]\s*/g)
    .map((v) => v.trim())
    .filter(Boolean);
}

export function normalizeStringList(value) {
  if (Array.isArray(value)) {
    return value.map((v) => asString(v).trim()).filter(Boolean);
  }

  const s = asString(value).trim();
  if (!s) return [];

  return s
    .split(/\s*[,;|]\s*/g)
    .map((v) => v.trim())
    .filter(Boolean);
}

export function mergeStringListsCaseInsensitive(existing, additions) {
  const base = normalizeStringList(existing);
  const next = [...base];
  const seen = new Set(base.map((v) => v.toLowerCase()));

  for (const item of normalizeStringList(additions)) {
    const key = item.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    next.push(item);
  }

  return next;
}

export function normalizeLocationSources(value) {
  if (!Array.isArray(value)) return [];

  return value
    .filter((v) => v && typeof v === "object")
    .map((v) => {
      const location = asString(v.location).trim();
      if (!location) return null;
      const source_url = asString(v.source_url).trim();
      const source_type = asString(v.source_type).trim();
      const location_type = asString(v.location_type).trim();
      return {
        location,
        ...(source_url ? { source_url } : {}),
        ...(source_type ? { source_type } : {}),
        ...(location_type ? { location_type } : {}),
      };
    })
    .filter(Boolean);
}

export function normalizeVisibility(value) {
  const v = value && typeof value === "object" ? value : {};
  const out = {
    hq_public: v.hq_public == null ? true : Boolean(v.hq_public),
    manufacturing_public: v.manufacturing_public == null ? true : Boolean(v.manufacturing_public),
    admin_rating_public: v.admin_rating_public == null ? true : Boolean(v.admin_rating_public),
  };
  return out;
}

export function keywordStringToList(value) {
  return normalizeLocationList(value);
}

export function keywordListToString(list) {
  if (!Array.isArray(list)) return "";
  return list
    .map((v) => asString(v).trim())
    .filter(Boolean)
    .join(", ");
}

export function normalizeStructuredLocationEntry(value) {
  if (!value) return null;

  if (typeof value === "string") {
    const s = value.trim();
    if (!s) return null;
    return { city: s, state: "", region: "", country: "" };
  }

  if (typeof value !== "object") return null;

  const city = asString(value.city).trim();
  const region = asString(value.region || value.state).trim();
  const state = asString(value.state || value.region).trim();
  const country = asString(value.country).trim();

  const address = asString(value.address).trim();
  const formatted = asString(value.formatted).trim();
  const location = asString(value.location).trim();

  const latRaw = value.lat;
  const lngRaw = value.lng;
  const lat = Number.isFinite(latRaw) ? latRaw : Number.isFinite(Number(latRaw)) ? Number(latRaw) : null;
  const lng = Number.isFinite(lngRaw) ? lngRaw : Number.isFinite(Number(lngRaw)) ? Number(lngRaw) : null;

  const hasAny = Boolean(city || region || state || country || address || formatted || location);
  if (!hasAny) return null;

  return {
    ...value,
    city,
    region,
    state,
    country,
    address: address || undefined,
    formatted: formatted || undefined,
    location: location || undefined,
    lat: lat == null ? undefined : lat,
    lng: lng == null ? undefined : lng,
  };
}

export function normalizeStructuredLocationList(value) {
  if (Array.isArray(value)) {
    return value
      .map((v) => normalizeStructuredLocationEntry(v))
      .filter(Boolean);
  }

  const single = normalizeStructuredLocationEntry(value);
  return single ? [single] : [];
}

export function formatStructuredLocation(loc) {
  if (!loc) return "";
  if (typeof loc === "string") return loc.trim();
  if (typeof loc !== "object") return "";

  const formatted = asString(loc.formatted).trim();
  if (formatted) return formatted;

  const address = asString(loc.full_address || loc.address || loc.location).trim();
  if (address) return address;

  const parts = [];
  const city = asString(loc.city).trim();
  const region = asString(loc.region || loc.state).trim();
  const country = asString(loc.country).trim();

  if (city) parts.push(city);
  if (region) parts.push(region);
  if (country) parts.push(country);

  return parts.join(", ");
}

export function getLocationGeocodeStatus(loc) {
  if (!loc) return "missing";
  if (typeof loc === "string") return "missing";
  if (typeof loc !== "object") return "missing";

  const lat = Number.isFinite(loc.lat) ? loc.lat : Number.isFinite(Number(loc.lat)) ? Number(loc.lat) : null;
  const lng = Number.isFinite(loc.lng) ? loc.lng : Number.isFinite(Number(loc.lng)) ? Number(loc.lng) : null;

  if (lat != null && lng != null) return "found";
  if (asString(loc.geocode_status).trim() === "failed") return "failed";
  return "missing";
}

export function getCompanyName(company) {
  return asString(company?.company_name).trim() || asString(company?.name).trim();
}

export function inferDisplayNameOverride(draft) {
  const companyName = asString(draft?.company_name).trim();
  const name = asString(draft?.name).trim();
  if (!name) return "";
  if (!companyName) return name;
  return name !== companyName ? name : "";
}

export function getCompanyUrl(company) {
  return asString(company?.website_url || company?.url || company?.canonical_url || company?.website).trim();
}

export function getCompanyId(company) {
  return asString(company?.company_id || company?.id).trim();
}

export function isDeletedCompany(company) {
  const v = company?.is_deleted;
  if (v === true) return true;
  if (v == null) return false;
  return String(v).toLowerCase() === "true" || String(v) === "1";
}

export function normalizeRatingIconType(value, rating) {
  if (value === "heart" || value === "star") return value;

  const starKeys = ["star1", "star2", "star3", "star4", "star5"];
  const icons = starKeys.map((k) => rating?.[k]?.icon_type).filter(Boolean);

  if (icons.length === 0) return "star";
  if (icons.every((i) => i === "heart")) return "heart";
  if (icons.every((i) => i === "star")) return "star";

  // Mixed icons: default to circle on places that don't support per-star icon overrides.
  return "star";
}

export function computeAutoRatingInput(draft) {
  const manuList = normalizeStructuredLocationList(draft?.manufacturing_locations);
  const hqList = normalizeStructuredLocationList(draft?.headquarters_locations);

  const reviewCount =
    Number(draft?.review_count ?? draft?.reviews_count ?? draft?.review_count_approved ?? 0) ||
    Number(draft?.editorial_review_count ?? 0) ||
    Number(draft?.amazon_review_count ?? 0) ||
    Number(draft?.public_review_count ?? 0) ||
    Number(draft?.private_review_count ?? 0) ||
    0;

  const curatedCount = Array.isArray(draft?.curated_reviews) ? draft.curated_reviews.length : 0;
  const embeddedCount = Array.isArray(draft?.reviews) ? draft.reviews.length : 0;

  return {
    hasManufacturingLocations: manuList.length > 0,
    hasHeadquarters: hqList.length > 0,
    hasReviews: reviewCount >= 1 || curatedCount >= 1 || embeddedCount >= 1,
  };
}

export function buildCompanyDraft(company) {
  const base = company && typeof company === "object" ? company : {};
  const baseCompany = base;

  const manuBase =
    Array.isArray(baseCompany?.manufacturing_geocodes) && baseCompany.manufacturing_geocodes.length > 0
      ? baseCompany.manufacturing_geocodes
      : baseCompany?.manufacturing_locations;

  const draft = {
    ...baseCompany,
    company_id: asString(baseCompany?.company_id || baseCompany?.id).trim(),
    company_name: asString(baseCompany?.company_name).trim() || asString(baseCompany?.name).trim(),
    name: asString(baseCompany?.name).trim(),
    website_url: getCompanyUrl(baseCompany),
    headquarters_location: asString(baseCompany?.headquarters_location).trim(),
    headquarters_locations: normalizeStructuredLocationList(
      baseCompany?.headquarters_locations || baseCompany?.headquarters || baseCompany?.headquarters_location
    ),
    manufacturing_locations: normalizeStructuredLocationList(manuBase),
    industries: normalizeStringList(baseCompany?.industries),
    keywords: normalizeStringList(baseCompany?.keywords || baseCompany?.product_keywords),
    amazon_url: asString(baseCompany?.amazon_url).trim(),
    amazon_store_url: asString(baseCompany?.amazon_store_url).trim(),
    affiliate_link_urls: normalizeStringList(baseCompany?.affiliate_link_urls),
    show_location_sources_to_users: Boolean(baseCompany?.show_location_sources_to_users),
    visibility: normalizeVisibility(baseCompany?.visibility),
    location_sources: normalizeLocationSources(baseCompany?.location_sources),
    rating: baseCompany?.rating ? normalizeRating(baseCompany.rating) : null,
    notes_entries: normalizeCompanyNotes(baseCompany?.notes_entries || baseCompany?.notesEntries),
    notes: asString(baseCompany?.notes).trim(),
    tagline: asString(baseCompany?.tagline).trim(),
    logo_url: asString(baseCompany?.logo_url).trim(),
  };

  if (!draft.name) draft.name = draft.company_name;

  if (!draft.rating) {
    draft.rating = calculateInitialRating(computeAutoRatingInput(draft));
  }

  draft.rating_icon_type = normalizeRatingIconType(draft.rating_icon_type, draft.rating);

  return draft;
}

export function slugifyCompanyId(name) {
  const base = asString(name)
    .trim()
    .toLowerCase()
    .replace(/[']/g, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 80);
  return base;
}

export function toNonNegativeInt(value, fallback = 0) {
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  return Math.max(0, Math.trunc(n));
}

export function getComputedReviewCount(company) {
  // review_count is intended to be canonical, but older records may have it missing or stale.
  // So we treat it as one input among several and pick the best available signal.
  const canonical = toNonNegativeInt(company?.review_count, 0);

  const publicCount = toNonNegativeInt(company?.public_review_count, 0);
  const privateCount = toNonNegativeInt(company?.private_review_count, 0);
  const publicPrivateTotal = publicCount + privateCount;

  const curatedCount = Array.isArray(company?.curated_reviews) ? company.curated_reviews.length : 0;
  const embeddedReviewsCount = Array.isArray(company?.reviews) ? company.reviews.length : 0;
  const embeddedTotal = curatedCount + embeddedReviewsCount;

  const bestNumericFallback = Math.max(
    0,
    canonical,
    toNonNegativeInt(company?.reviews_count, 0),
    toNonNegativeInt(company?.review_count_approved, 0),
    toNonNegativeInt(company?.editorial_review_count, 0),
    toNonNegativeInt(company?.amazon_review_count, 0),
    toNonNegativeInt(company?.public_review_count, 0),
    toNonNegativeInt(company?.private_review_count, 0)
  );

  return Math.max(0, publicPrivateTotal, bestNumericFallback, embeddedTotal);
}

export function toLegacyIssueTags(company) {
  const issues = [];

  const name = asString(company?.company_name).trim();
  if (!name) issues.push("missing company name");

  const url = getCompanyUrl(company);
  if (!url) issues.push("missing url");

  const logo = asString(company?.logo_url).trim();
  if (!logo) issues.push("missing logo");

  const hqList = normalizeStructuredLocationList(
    company?.headquarters_locations || company?.headquarters || company?.headquarters_location
  );
  if (hqList.length === 0) issues.push("missing HQ");

  const manuBase =
    Array.isArray(company?.manufacturing_geocodes) && company.manufacturing_geocodes.length > 0
      ? company.manufacturing_geocodes
      : company?.manufacturing_locations;
  const mfgList = normalizeStructuredLocationList(manuBase);
  if (mfgList.length === 0) issues.push("missing MFG");

  const keywords = normalizeStringList(company?.keywords || company?.product_keywords);
  if (keywords.length === 0) issues.push("missing keywords");

  if (getComputedReviewCount(company) === 0) issues.push("reviews");

  return issues;
}

export function getContractMissingFields(company) {
  const raw =
    company?.enrichment_health?.missing_fields ??
    company?.enrichment_health?.missing ??
    company?.enrichment_health?.missingFields;

  const list = Array.isArray(raw) ? raw : [];

  const fields = list
    .filter((v) => typeof v === "string")
    .map((v) => v.trim())
    .filter(Boolean);

  // Check for missing Amazon URL (unless marked as "no_amazon_store")
  const hasAmazonUrl = Boolean(asString(company?.amazon_url).trim());
  const noAmazonStore = Boolean(company?.no_amazon_store);
  if (!hasAmazonUrl && !noAmazonStore) {
    fields.push("amazon_url");
  }

  return fields;
}

export function formatContractMissingField(field) {
  const f = asString(field).trim();
  if (!f) return "";

  switch (f) {
    case "headquarters_location":
      return "HQ";
    case "manufacturing_locations":
      return "MFG";
    case "product_keywords":
      return "keywords";
    case "amazon_url":
      return "Amz";
    default:
      return f.replace(/_/g, " ");
  }
}

export function toIssueTags(company) {
  // Issues column must render from enrichment_health.missing_fields (contract), not legacy heuristics.
  // Legacy heuristics treat placeholders like "Unknown" as present and hide real missing fields.
  return getContractMissingFields(company);
}

export function toDisplayDate(value) {
  const s = asString(value).trim();
  if (!s) return "";
  const d = new Date(s);
  if (Number.isNaN(d.getTime())) return s;
  return d.toLocaleString();
}

export function validateCompanyDraft(draft) {
  const name = asString(draft?.company_name).trim();
  const url = getCompanyUrl(draft);
  if (!name) return "Company name is required.";
  if (!url) return "Website URL is required.";
  return null;
}

export function normalizeCompanyNotes(value) {
  const list = Array.isArray(value) ? value : [];
  const out = [];
  for (const n of list) {
    if (!n || typeof n !== "object") continue;
    const title = asString(n.title).trim();
    const body = asString(n.body).trim();
    const createdAt = asString(n.created_at || n.createdAt).trim() || new Date().toISOString();
    const isPublic = n.is_public === true || String(n.is_public).toLowerCase() === "true";

    if (!title && !body) continue;

    out.push({
      id: asString(n.id).trim() || `note_${Date.now()}_${Math.random().toString(36).slice(2)}`,
      title,
      body,
      is_public: isPublic,
      created_at: createdAt,
      updated_at: asString(n.updated_at || n.updatedAt).trim() || createdAt,
      created_by: asString(n.created_by || n.createdBy || n.actor).trim() || "admin_ui",
    });
  }

  out.sort((a, b) => String(b.created_at).localeCompare(String(a.created_at)));
  return out;
}

export function truncateMiddle(value, maxLen = 80) {
  const s = asString(value).trim();
  if (!s) return "";
  if (s.length <= maxLen) return s;
  const keep = Math.max(10, Math.floor((maxLen - 1) / 2));
  return `${s.slice(0, keep)}\u2026${s.slice(-keep)}`;
}

export function normalizeImportedReviewsPayload(data) {
  if (!data || typeof data !== "object") return { ok: false, items: [] };
  const ok = data.ok === true;
  const items = Array.isArray(data.items) ? data.items : Array.isArray(data.reviews) ? data.reviews : [];
  return { ok, items };
}

export function getReviewSourceName(review) {
  if (!review || typeof review !== "object") return "";
  return (
    asString(review.source_name).trim() ||
    asString(review.source).trim() ||
    asString(review.reviewer).trim() ||
    asString(review.user_name).trim() ||
    asString(review.author).trim()
  );
}

export function getReviewText(review) {
  if (!review || typeof review !== "object") return "";
  return (
    asString(review.text).trim() ||
    asString(review.abstract).trim() ||
    asString(review.excerpt).trim() ||
    asString(review.snippet).trim() ||
    asString(review.body).trim()
  );
}

export function getReviewUrl(review) {
  if (!review || typeof review !== "object") return "";
  return asString(review.source_url).trim() || asString(review.url).trim() || asString(review.link).trim();
}

export function normalizeIsPublicFlag(value, defaultValue = true) {
  if (value === undefined || value === null) return defaultValue;
  if (value === false) return false;
  if (value === true) return true;

  if (typeof value === "string") {
    const v = value.trim().toLowerCase();
    if (!v) return defaultValue;
    if (v === "false" || v === "0" || v === "no" || v === "off") return false;
    if (v === "true" || v === "1" || v === "yes" || v === "on") return true;
  }

  return Boolean(value);
}

export function isCuratedReviewPubliclyVisible(review) {
  if (!review || typeof review !== "object") return false;

  const flag =
    review?.show_to_users ??
    review?.showToUsers ??
    review?.is_public ??
    review?.visible_to_users ??
    review?.visible;

  if (normalizeIsPublicFlag(flag, true) === false) return false;

  const urlRaw = getReviewUrl(review);
  const url = normalizeExternalUrl(urlRaw);
  if (!url) return false;

  // Note: link_status and match_confidence are informational signals displayed
  // as badges in the admin UI, but they must NOT silently hide admin-curated
  // reviews. This matches the backend get-reviews filter logic.

  return true;
}

export function getReviewDate(review) {
  if (!review || typeof review !== "object") return "";
  return (
    asString(review.date).trim() ||
    asString(review.created_at).trim() ||
    asString(review.imported_at).trim() ||
    asString(review.published_at).trim() ||
    asString(review.updated_at).trim() ||
    asString(review.last_updated_at).trim()
  );
}

export function getReviewRating(review) {
  const raw = review && typeof review === "object" ? review.rating : null;
  if (raw == null) return null;
  const n = Number(raw);
  return Number.isFinite(n) ? n : null;
}

export function extractReviewMetadata(review) {
  if (!review || typeof review !== "object") return [];

  const excluded = new Set([
    "id",
    "company_id",
    "companyId",
    "company_name",
    "company",
    "source_name",
    "source",
    "reviewer",
    "author",
    "user_name",
    "text",
    "abstract",
    "excerpt",
    "snippet",
    "body",
    "html",
    "content",
    "source_url",
    "url",
    "link",
    "date",
    "created_at",
    "imported_at",
    "published_at",
    "updated_at",
    "last_updated_at",
    "rating",
  ]);

  const entries = [];
  for (const [key, value] of Object.entries(review)) {
    if (excluded.has(key)) continue;
    if (value == null) continue;

    const type = typeof value;
    if (type === "string") {
      const s = value.trim();
      if (!s) continue;
      if (s.length > 140) continue;
      entries.push([key, s]);
    } else if (type === "number" || type === "boolean") {
      entries.push([key, String(value)]);
    }
  }

  entries.sort((a, b) => a[0].localeCompare(b[0]));
  return entries.slice(0, 8);
}

export function normalizeReviewDedupText(value) {
  return asString(value)
    .trim()
    .toLowerCase()
    .replace(/\s+/g, " ")
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

export function normalizeReviewDedupUrl(value) {
  const raw = asString(value).trim();
  if (!raw) return "";

  const withScheme = raw.includes("://") ? raw : `https://${raw}`;
  try {
    const u = new URL(withScheme);
    if (u.protocol !== "http:" && u.protocol !== "https:") return "";
    u.hash = "";

    const host = u.hostname.toLowerCase().replace(/^www\./, "");
    const pathname = u.pathname.replace(/\/+$/, "");
    const search = u.searchParams.toString();

    return `${u.protocol}//${host}${pathname}${search ? `?${search}` : ""}`;
  } catch {
    return raw.toLowerCase();
  }
}

export function computeReviewDedupKey(review) {
  const title = normalizeReviewDedupText(review?.title);
  const excerpt = normalizeReviewDedupText(review?.excerpt ?? review?.abstract ?? review?.text);
  const author = normalizeReviewDedupText(review?.author ?? review?.source ?? review?.source_name);
  const date = normalizeReviewDedupText(review?.date);

  const blob = [title, excerpt, author, date].filter(Boolean).join("|");
  return blob;
}

export function mergeCuratedReviews(existingCurated, proposedReviews) {
  const existingList = Array.isArray(existingCurated) ? existingCurated : [];
  const proposedList = Array.isArray(proposedReviews) ? proposedReviews : [];

  const urlSet = new Set(existingList.map((r) => normalizeReviewDedupUrl(r?.source_url || r?.url)).filter(Boolean));
  const hashSet = new Set(existingList.map(computeReviewDedupKey).filter(Boolean));

  const nowIso = new Date().toISOString();
  const appended = [];
  let skippedDuplicates = 0;

  for (const p of proposedList) {
    const urlKey = normalizeReviewDedupUrl(p?.source_url || p?.url);
    const hashKey = computeReviewDedupKey(p);

    if ((urlKey && urlSet.has(urlKey)) || (hashKey && hashSet.has(hashKey))) {
      skippedDuplicates += 1;
      continue;
    }

    if (urlKey) urlSet.add(urlKey);
    if (hashKey) hashSet.add(hashKey);

    const excerpt = asString(p?.excerpt ?? p?.abstract ?? p?.text).trim();

    const linkStatus = asString(p?.link_status).trim();
    const matchConfidenceRaw = p?.match_confidence;
    const matchConfidence =
      typeof matchConfidenceRaw === "number"
        ? matchConfidenceRaw
        : typeof matchConfidenceRaw === "string" && matchConfidenceRaw.trim()
          ? Number(matchConfidenceRaw)
          : null;

    appended.push({
      id: `admin_reviews_import_${Date.now()}_${Math.random().toString(36).slice(2)}`,
      source: asString(p?.source).trim() || "professional_review",
      source_name: asString(p?.source_name || p?.source).trim(),
      source_url: asString(p?.source_url || p?.url).trim(),
      url: asString(p?.source_url || p?.url).trim(),
      title: asString(p?.title).trim(),
      content: excerpt,
      excerpt,
      abstract: excerpt,
      rating: getReviewRating(p) ?? null,
      author: asString(p?.author).trim(),
      date: asString(p?.date).trim() || null,
      include_on_save: true,
      visibility: "public",
      link_status: linkStatus || null,
      match_confidence: typeof matchConfidence === "number" && Number.isFinite(matchConfidence) ? matchConfidence : null,
      created_at: nowIso,
      last_updated_at: nowIso,
      imported_via: "admin_reviews_import",
      show_to_users: true,
      is_public: true,
    });
  }

  return {
    merged: existingList.concat(appended),
    addedCount: appended.length,
    skippedDuplicates,
  };
}

export function formatProposedReviewForClipboard(review) {
  const title = asString(review?.title).trim();
  const excerpt = asString(review?.excerpt ?? review?.abstract ?? review?.text).trim();
  const url = asString(review?.source_url || review?.url).trim();
  const author = asString(review?.author).trim();
  const date = asString(review?.date).trim();

  const header = title || author || url ? [title, author].filter(Boolean).join(" \u2014 ") : "Review";
  const meta = [date, url].filter(Boolean).join(" \u2022 ");

  return [header, meta, excerpt].filter(Boolean).join("\n");
}

export async function copyToClipboard(value) {
  const s = asString(value).trim();
  if (!s) return false;

  try {
    // Clipboard API is the most reliable in modern browsers, but it can fail in some embedded
    // contexts or when permissions are restricted.
    if (typeof navigator !== "undefined" && navigator?.clipboard?.writeText && window?.isSecureContext) {
      await navigator.clipboard.writeText(s);
      return true;
    }
  } catch {
    // fall through to legacy path
  }

  try {
    // Legacy fallback: execCommand('copy')
    const el = document.createElement("textarea");
    el.value = s;
    el.setAttribute("readonly", "");
    el.style.position = "fixed";
    el.style.top = "0";
    el.style.left = "0";
    el.style.opacity = "0";
    el.style.pointerEvents = "none";
    document.body.appendChild(el);

    el.focus();
    el.select();
    try {
      el.setSelectionRange(0, el.value.length);
    } catch {
      // ignore (not supported in some browsers)
    }

    const ok = document.execCommand("copy");
    document.body.removeChild(el);
    return ok;
  } catch {
    return false;
  }
}
