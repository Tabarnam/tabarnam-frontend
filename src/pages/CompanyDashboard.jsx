import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Helmet } from "react-helmet-async";
import { Link } from "react-router-dom";
import DataTable from "react-data-table-component";
import {
  Save,
  Trash2,
  Pencil,
  RefreshCcw,
  AlertTriangle,
  Plus,
  AlertCircle,
  Copy,
  ChevronDown,
} from "lucide-react";

import { calculateInitialRating, clampStarValue, normalizeRating } from "@/lib/stars/calculateRating";

import AdminHeader from "@/components/AdminHeader";
import ErrorBoundary from "@/components/ErrorBoundary";
import ScrollScrubber from "@/components/ScrollScrubber";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { toast } from "@/lib/toast";
import { apiFetch, getUserFacingConfigMessage } from "@/lib/api";
import { deleteLogoBlob, uploadLogoBlobFile } from "@/lib/blobStorage";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";

const DEFAULT_TAKE = 200;

function asString(value) {
  return typeof value === "string" ? value : value == null ? "" : String(value);
}

function prettyJson(value) {
  try {
    return JSON.stringify(value, null, 2);
  } catch {
    return asString(value);
  }
}

function deepClone(value) {
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

function normalizeBuildIdString(value) {
  const s = asString(value).trim();
  if (!s) return "";
  const m = s.match(/[0-9a-f]{7,40}/i);
  return m ? m[0] : s;
}

async function fetchStaticBuildId() {
  try {
    const res = await fetch("/__build_id.txt", { cache: "no-store" });
    if (!res.ok) return "";
    const txt = await res.text();
    return normalizeBuildIdString(txt);
  } catch {
    return "";
  }
}

function normalizeLocationList(value) {
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

function normalizeStringList(value) {
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

function normalizeLocationSources(value) {
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

function normalizeVisibility(value) {
  const v = value && typeof value === "object" ? value : {};
  const out = {
    hq_public: v.hq_public == null ? true : Boolean(v.hq_public),
    manufacturing_public: v.manufacturing_public == null ? true : Boolean(v.manufacturing_public),
    admin_rating_public: v.admin_rating_public == null ? true : Boolean(v.admin_rating_public),
  };
  return out;
}

function LocationSourcesEditor({ value, onChange }) {
  const list = normalizeLocationSources(value);

  const add = useCallback(() => {
    const next = [
      ...list,
      {
        location: "",
        source_url: "",
        source_type: "official_website",
        location_type: "headquarters",
      },
    ];
    onChange(next);
  }, [list, onChange]);

  const remove = useCallback(
    (idx) => {
      onChange(list.filter((_, i) => i !== idx));
    },
    [list, onChange]
  );

  const update = useCallback(
    (idx, patch) => {
      onChange(list.map((it, i) => (i === idx ? { ...it, ...patch } : it)));
    },
    [list, onChange]
  );

  return (
    <div className="space-y-2">
      <div className="text-sm text-slate-700 font-medium">Location sources</div>
      <div className="rounded-lg border border-slate-200 bg-white overflow-hidden">
        {list.length === 0 ? (
          <div className="p-3 text-xs text-slate-600">No sources yet.</div>
        ) : (
          <div className="p-3 space-y-3">
            {list.map((entry, idx) => (
              <div key={`${entry.location}-${idx}`} className="rounded border border-slate-200 bg-slate-50 p-3 space-y-2">
                <div className="grid grid-cols-1 lg:grid-cols-2 gap-2">
                  <div className="space-y-1">
                    <label className="text-xs font-medium text-slate-700">Location</label>
                    <Input
                      value={asString(entry.location)}
                      onChange={(e) => update(idx, { location: e.target.value })}
                    />
                  </div>
                  <div className="space-y-1">
                    <label className="text-xs font-medium text-slate-700">Source URL</label>
                    <Input
                      value={asString(entry.source_url)}
                      onChange={(e) => update(idx, { source_url: e.target.value })}
                    />
                  </div>
                </div>

                <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
                  <div className="space-y-1">
                    <label className="text-xs font-medium text-slate-700">Source type</label>
                    <select
                      className="h-10 w-full rounded-md border border-slate-200 bg-white px-3 text-sm"
                      value={asString(entry.source_type || "other")}
                      onChange={(e) => update(idx, { source_type: e.target.value })}
                    >
                      <option value="official_website">Official website</option>
                      <option value="government_guide">Government guide</option>
                      <option value="b2b_directory">B2B directory</option>
                      <option value="trade_data">Trade data</option>
                      <option value="packaging">Packaging</option>
                      <option value="media">Media</option>
                      <option value="other">Other</option>
                    </select>
                  </div>

                  <div className="space-y-1">
                    <label className="text-xs font-medium text-slate-700">Location type</label>
                    <select
                      className="h-10 w-full rounded-md border border-slate-200 bg-white px-3 text-sm"
                      value={asString(entry.location_type || "headquarters")}
                      onChange={(e) => update(idx, { location_type: e.target.value })}
                    >
                      <option value="headquarters">Headquarters</option>
                      <option value="manufacturing">Manufacturing</option>
                      <option value="other">Other</option>
                    </select>
                  </div>
                </div>

                <div className="flex justify-end">
                  <Button type="button" variant="outline" size="sm" onClick={() => remove(idx)}>
                    Remove
                  </Button>
                </div>
              </div>
            ))}
          </div>
        )}

        <div className="border-t border-slate-200 p-3">
          <Button type="button" variant="outline" onClick={add}>
            <Plus className="h-4 w-4 mr-2" />
            Add source
          </Button>
        </div>
      </div>
    </div>
  );
}

function StringListEditor({ label, value, onChange, placeholder = "" }) {
  const list = normalizeStringList(value);
  const [draft, setDraft] = useState("");

  const add = useCallback(() => {
    const next = asString(draft).trim();
    if (!next) return;
    if (list.some((v) => v.toLowerCase() === next.toLowerCase())) {
      setDraft("");
      return;
    }
    onChange([...list, next]);
    setDraft("");
  }, [draft, list, onChange]);

  const onKeyDown = useCallback(
    (e) => {
      if (e.key !== "Enter") return;
      e.preventDefault();
      add();
    },
    [add]
  );

  const remove = useCallback(
    (idx) => {
      onChange(list.filter((_, i) => i !== idx));
    },
    [list, onChange]
  );

  return (
    <div className="space-y-2">
      <div className="text-sm text-slate-700 font-medium">{label}</div>

      <div className="rounded-lg border border-slate-200 bg-white">
        {list.length === 0 ? (
          <div className="p-3 text-xs text-slate-500">None yet.</div>
        ) : (
          <div className="p-3 flex flex-wrap gap-2">
            {list.map((item, idx) => (
              <span
                key={`${item}-${idx}`}
                className="inline-flex items-center gap-2 rounded-full border border-slate-200 bg-slate-50 px-3 py-1 text-xs text-slate-800"
              >
                {item}
                <button
                  type="button"
                  className="text-slate-500 hover:text-red-600"
                  onClick={() => remove(idx)}
                  aria-label={`Remove ${item}`}
                >
                  ×
                </button>
              </span>
            ))}
          </div>
        )}

        <div className="border-t border-slate-200 p-3">
          <div className="flex flex-wrap items-end gap-2">
            <div className="min-w-[240px] flex-1 space-y-1">
              <label className="text-xs font-medium text-slate-700">Add</label>
              <Input value={draft} onChange={(e) => setDraft(e.target.value)} onKeyDown={onKeyDown} placeholder={placeholder} />
            </div>
            <Button type="button" onClick={add} disabled={!asString(draft).trim()}>
              <Plus className="h-4 w-4 mr-2" />
              Add
            </Button>
          </div>
        </div>
      </div>
    </div>
  );
}

function keywordStringToList(value) {
  return normalizeLocationList(value);
}

function keywordListToString(list) {
  if (!Array.isArray(list)) return "";
  return list
    .map((v) => asString(v).trim())
    .filter(Boolean)
    .join(", ");
}

function normalizeStructuredLocationEntry(value) {
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

function normalizeStructuredLocationList(value) {
  if (Array.isArray(value)) {
    return value
      .map((v) => normalizeStructuredLocationEntry(v))
      .filter(Boolean);
  }

  const single = normalizeStructuredLocationEntry(value);
  return single ? [single] : [];
}

function formatStructuredLocation(loc) {
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

function getLocationGeocodeStatus(loc) {
  if (!loc) return "missing";
  if (typeof loc === "string") return "missing";
  if (typeof loc !== "object") return "missing";

  const lat = Number.isFinite(loc.lat) ? loc.lat : Number.isFinite(Number(loc.lat)) ? Number(loc.lat) : null;
  const lng = Number.isFinite(loc.lng) ? loc.lng : Number.isFinite(Number(loc.lng)) ? Number(loc.lng) : null;

  if (lat != null && lng != null) return "found";
  if (asString(loc.geocode_status).trim() === "failed") return "failed";
  return "missing";
}

function LocationStatusBadge({ loc }) {
  const status = getLocationGeocodeStatus(loc);
  const cls =
    status === "found"
      ? "bg-emerald-50 text-emerald-800 border-emerald-200"
      : status === "failed"
        ? "bg-red-50 text-red-800 border-red-200"
        : "bg-slate-50 text-slate-700 border-slate-200";

  const label = status === "found" ? "Found" : status === "failed" ? "Failed" : "Missing";
  const detail =
    loc && typeof loc === "object"
      ? asString(loc.geocode_error || loc.geocode_google_status || loc.geocode_source).trim()
      : "";

  return (
    <span
      className={`inline-flex items-center rounded-full border px-2 py-0.5 text-[11px] font-medium ${cls}`}
      title={detail || label}
    >
      {label}
    </span>
  );
}

function StructuredLocationListEditor({ label, value, onChange }) {
  const list = normalizeStructuredLocationList(value);

  const [city, setCity] = useState("");
  const [region, setRegion] = useState("");
  const [country, setCountry] = useState("");

  const addEntry = useCallback(() => {
    const next = normalizeStructuredLocationEntry({ city, region, state: region, country });
    if (!next) return;

    onChange([...list, next]);
    setCity("");
    setRegion("");
    setCountry("");
  }, [city, country, list, onChange, region]);

  const onKeyDown = useCallback(
    (e) => {
      if (e.key !== "Enter") return;
      e.preventDefault();
      addEntry();
    },
    [addEntry]
  );

  const removeEntry = useCallback(
    (idx) => {
      const next = list.filter((_, i) => i !== idx);
      onChange(next);
    },
    [list, onChange]
  );

  return (
    <div className="space-y-2">
      <div className="text-sm text-slate-700 font-medium">{label}</div>

      <div className="rounded-lg border border-slate-200 bg-white">
        {list.length === 0 ? (
          <div className="p-3 text-xs text-slate-500">No locations yet.</div>
        ) : (
          <div className="divide-y divide-slate-100">
            {list.map((loc, idx) => {
              const display = formatStructuredLocation(loc) || "—";
              return (
                <div key={idx} className="flex items-center gap-2 p-3">
                  <div className="min-w-0 flex-1">
                    <div className="truncate text-sm text-slate-900">{display}</div>
                    <div className="mt-1 flex items-center gap-2">
                      <LocationStatusBadge loc={loc} />
                      {asString(loc?.geocode_source).trim() ? (
                        <span className="text-[11px] text-slate-500">{asString(loc.geocode_source).trim()}</span>
                      ) : null}
                    </div>
                  </div>

                  <Button
                    type="button"
                    variant="outline"
                    size="sm"
                    className="border-red-600 text-red-600 hover:bg-red-600 hover:text-white"
                    onClick={() => removeEntry(idx)}
                    title="Remove"
                  >
                    <Trash2 className="h-4 w-4" />
                  </Button>
                </div>
              );
            })}
          </div>
        )}

        <div className="border-t border-slate-200 p-3">
          <div className="grid grid-cols-1 gap-2 md:grid-cols-4 md:items-end">
            <div className="space-y-1">
              <label className="text-xs font-medium text-slate-700">City</label>
              <Input value={city} onChange={(e) => setCity(e.target.value)} onKeyDown={onKeyDown} />
            </div>
            <div className="space-y-1">
              <label className="text-xs font-medium text-slate-700">Region/State</label>
              <Input value={region} onChange={(e) => setRegion(e.target.value)} onKeyDown={onKeyDown} />
            </div>
            <div className="space-y-1">
              <label className="text-xs font-medium text-slate-700">Country</label>
              <Input value={country} onChange={(e) => setCountry(e.target.value)} onKeyDown={onKeyDown} />
            </div>
            <Button type="button" onClick={addEntry} disabled={!normalizeStructuredLocationEntry({ city, region, state: region, country })}>
              <Plus className="h-4 w-4 mr-2" />
              Add
            </Button>
          </div>
        </div>
      </div>
    </div>
  );
}

function getCompanyName(company) {
  return asString(company?.company_name).trim() || asString(company?.name).trim();
}

function inferDisplayNameOverride(draft) {
  const companyName = asString(draft?.company_name).trim();
  const name = asString(draft?.name).trim();
  if (!name) return "";
  if (!companyName) return name;
  return name !== companyName ? name : "";
}

function getCompanyUrl(company) {
  return asString(company?.website_url || company?.url || company?.canonical_url || company?.website).trim();
}

function getCompanyId(company) {
  return asString(company?.company_id || company?.id).trim();
}

function isDeletedCompany(company) {
  const v = company?.is_deleted;
  if (v === true) return true;
  if (v == null) return false;
  return String(v).toLowerCase() === "true" || String(v) === "1";
}

function buildCompanyDraft(company) {
  const base = company && typeof company === "object" ? company : {};
  const { rating_icon_type: _ignoredRatingIconType, ...baseCompany } = base;

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

  return draft;
}

function slugifyCompanyId(name) {
  const base = asString(name)
    .trim()
    .toLowerCase()
    .replace(/[']/g, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 80);
  return base;
}

function toIssueTags(company) {
  const issues = [];

  const name = asString(company?.company_name).trim();
  if (!name) issues.push("missing company name");

  const url = getCompanyUrl(company);
  if (!url) issues.push("missing url");

  const logo = asString(company?.logo_url).trim();
  if (!logo) issues.push("missing logo");

  const hqList = normalizeStructuredLocationList(company?.headquarters_locations || company?.headquarters || company?.headquarters_location);
  if (hqList.length === 0) issues.push("missing HQ");

  const manuBase =
    Array.isArray(company?.manufacturing_geocodes) && company.manufacturing_geocodes.length > 0
      ? company.manufacturing_geocodes
      : company?.manufacturing_locations;
  const mfgList = normalizeStructuredLocationList(manuBase);
  if (mfgList.length === 0) issues.push("missing MFG");

  const keywords = normalizeStringList(company?.keywords || company?.product_keywords);
  if (keywords.length === 0) issues.push("missing keywords");

  return issues;
}

function toDisplayDate(value) {
  const s = asString(value).trim();
  if (!s) return "";
  const d = new Date(s);
  if (Number.isNaN(d.getTime())) return s;
  return d.toLocaleString();
}

function validateCompanyDraft(draft) {
  const name = asString(draft?.company_name).trim();
  const url = getCompanyUrl(draft);
  if (!name) return "Company name is required.";
  if (!url) return "Website URL is required.";
  return null;
}

function computeAutoRatingInput(draft) {
  const manuList = normalizeStructuredLocationList(draft?.manufacturing_locations);
  const hqList = normalizeStructuredLocationList(draft?.headquarters_locations);

  const reviewCount =
    Number(draft?.review_count ?? draft?.reviews_count ?? draft?.review_count_approved ?? 0) ||
    Number(draft?.editorial_review_count ?? 0) ||
    Number(draft?.amazon_review_count ?? 0) ||
    Number(draft?.public_review_count ?? 0) ||
    Number(draft?.private_review_count ?? 0) ||
    0;

  return {
    hasManufacturingLocations: manuList.length > 0,
    hasHeadquarters: hqList.length > 0,
    hasReviews: reviewCount >= 1,
  };
}

function normalizeCompanyNotes(value) {
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

function CompanyNotesEditor({ value, onChange }) {
  const notes = normalizeCompanyNotes(value);

  const [open, setOpen] = useState(false);
  const [title, setTitle] = useState("");
  const [body, setBody] = useState("");
  const [isPublic, setIsPublic] = useState(false);

  const canAdd = Boolean(asString(title).trim() || asString(body).trim());

  const add = useCallback(() => {
    const t = asString(title).trim();
    const b = asString(body).trim();
    if (!t && !b) return;

    const now = new Date().toISOString();
    const entry = {
      id: `note_${Date.now()}_${Math.random().toString(36).slice(2)}`,
      title: t,
      body: b,
      is_public: isPublic,
      created_at: now,
      updated_at: now,
      created_by: "admin_ui",
    };

    onChange([entry, ...notes]);
    setTitle("");
    setBody("");
    setIsPublic(false);
    setOpen(false);
  }, [body, isPublic, notes, onChange, title]);

  const remove = useCallback(
    (idx) => {
      onChange(notes.filter((_, i) => i !== idx));
    },
    [notes, onChange]
  );

  const update = useCallback(
    (idx, patch) => {
      const next = notes.map((n, i) => {
        if (i !== idx) return n;
        const updated_at = new Date().toISOString();
        return { ...n, ...(patch || {}), updated_at };
      });
      onChange(next);
    },
    [notes, onChange]
  );

  return (
    <div className="space-y-3">
      <div className="flex items-center justify-between gap-2">
        <div className="text-sm text-slate-700 font-medium">Manual note (admin)</div>
        <Button type="button" onClick={() => setOpen((v) => !v)}>
          <Plus className="h-4 w-4 mr-2" />
          Note
        </Button>
      </div>

      {open && (
        <div className="rounded-lg border border-slate-200 bg-white p-3 space-y-2">
          <div className="grid grid-cols-1 gap-2">
            <div className="space-y-1">
              <label className="text-xs font-medium text-slate-700">Title</label>
              <Input value={title} onChange={(e) => setTitle(e.target.value)} placeholder="Short title…" />
            </div>
            <div className="space-y-1">
              <label className="text-xs font-medium text-slate-700">Body</label>
              <textarea
                value={body}
                onChange={(e) => setBody(e.target.value)}
                className="min-h-[120px] w-full rounded-md border border-slate-200 bg-white px-3 py-2 text-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-slate-400"
                placeholder="Write details…"
              />
            </div>
            <label className="flex items-center gap-2 text-sm text-slate-700">
              <input type="checkbox" checked={isPublic} onChange={(e) => setIsPublic(e.target.checked)} />
              Public
            </label>
            <div className="flex gap-2">
              <Button type="button" variant="outline" onClick={() => setOpen(false)}>
                Cancel
              </Button>
              <Button type="button" onClick={add} disabled={!canAdd}>
                Add note
              </Button>
            </div>
          </div>
        </div>
      )}

      {notes.length === 0 ? (
        <div className="rounded-lg border border-slate-200 bg-slate-50 p-3 text-xs text-slate-600">No notes yet.</div>
      ) : (
        <div className="space-y-3">
          {notes.map((n, idx) => (
            <div key={n.id} className="rounded-lg border border-slate-200 bg-white p-3 space-y-2">
              <div className="flex items-start justify-between gap-2">
                <div className="min-w-0 flex-1">
                  <Input
                    value={asString(n.title)}
                    onChange={(e) => update(idx, { title: e.target.value })}
                    placeholder="Title"
                    className="font-medium"
                  />
                  <div className="mt-1 flex flex-wrap items-center gap-2 text-xs text-slate-600">
                    <span>{n.is_public ? "Public" : "Private"}</span>
                    <span>·</span>
                    <span>{n.created_at ? new Date(n.created_at).toLocaleString() : ""}</span>
                  </div>
                </div>

                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  className="border-red-600 text-red-600 hover:bg-red-600 hover:text-white"
                  onClick={() => remove(idx)}
                  title="Delete note"
                >
                  <Trash2 className="h-4 w-4" />
                </Button>
              </div>

              <textarea
                value={asString(n.body)}
                onChange={(e) => update(idx, { body: e.target.value })}
                className="min-h-[100px] w-full rounded-md border border-slate-200 bg-white px-3 py-2 text-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-slate-400"
                placeholder="Body"
              />

              <label className="flex items-center gap-2 text-sm text-slate-700">
                <input
                  type="checkbox"
                  checked={Boolean(n.is_public)}
                  onChange={(e) => update(idx, { is_public: e.target.checked })}
                />
                Public
              </label>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

function truncateMiddle(value, maxLen = 80) {
  const s = asString(value).trim();
  if (!s) return "";
  if (s.length <= maxLen) return s;
  const keep = Math.max(10, Math.floor((maxLen - 1) / 2));
  return `${s.slice(0, keep)}…${s.slice(-keep)}`;
}

function normalizeImportedReviewsPayload(data) {
  if (!data || typeof data !== "object") return { ok: false, items: [] };
  const ok = data.ok === true;
  const items = Array.isArray(data.items) ? data.items : Array.isArray(data.reviews) ? data.reviews : [];
  return { ok, items };
}

function getReviewSourceName(review) {
  if (!review || typeof review !== "object") return "";
  return (
    asString(review.source_name).trim() ||
    asString(review.source).trim() ||
    asString(review.reviewer).trim() ||
    asString(review.user_name).trim() ||
    asString(review.author).trim()
  );
}

function getReviewText(review) {
  if (!review || typeof review !== "object") return "";
  return (
    asString(review.text).trim() ||
    asString(review.abstract).trim() ||
    asString(review.excerpt).trim() ||
    asString(review.snippet).trim() ||
    asString(review.body).trim()
  );
}

function getReviewUrl(review) {
  if (!review || typeof review !== "object") return "";
  return asString(review.source_url).trim() || asString(review.url).trim() || asString(review.link).trim();
}

function normalizeExternalUrl(value) {
  const raw = asString(value).trim();
  if (!raw) return "";

  const withScheme = raw.includes("://") ? raw : `https://${raw}`;
  try {
    const u = new URL(withScheme);
    if (u.protocol !== "http:" && u.protocol !== "https:") return "";
    return u.toString();
  } catch {
    return "";
  }
}

function getReviewDate(review) {
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

function getReviewRating(review) {
  const raw = review && typeof review === "object" ? review.rating : null;
  if (raw == null) return null;
  const n = Number(raw);
  return Number.isFinite(n) ? n : null;
}

function extractReviewMetadata(review) {
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

function ImportedReviewsPanel({ companyId }) {
  const stableId = asString(companyId).trim();
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(null);
  const [items, setItems] = useState([]);

  const load = useCallback(async () => {
    const id = asString(stableId).trim();
    if (!id) {
      setItems([]);
      setError(null);
      return;
    }

    setLoading(true);
    setError(null);

    try {
      const res = await apiFetch(`/get-reviews?company_id=${encodeURIComponent(id)}`);
      const data = await res.json().catch(() => ({ items: [], reviews: [] }));
      if (!res.ok) {
        throw new Error(asString(data?.error).trim() || res.statusText || "Failed to load imported reviews");
      }

      const normalized = normalizeImportedReviewsPayload(data);
      const list = Array.isArray(normalized.items) ? normalized.items : [];
      setItems(list);
    } catch (e) {
      setError({ message: asString(e?.message).trim() || "Failed to load imported reviews" });
    } finally {
      setLoading(false);
    }
  }, [stableId]);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      if (!stableId) {
        setItems([]);
        setError(null);
        return;
      }

      setLoading(true);
      setError(null);

      try {
        const res = await apiFetch(`/get-reviews?company_id=${encodeURIComponent(stableId)}`);
        const data = await res.json().catch(() => ({ items: [], reviews: [] }));
        if (!res.ok) {
          throw new Error(asString(data?.error).trim() || res.statusText || "Failed to load imported reviews");
        }

        const normalized = normalizeImportedReviewsPayload(data);
        const list = Array.isArray(normalized.items) ? normalized.items : [];
        if (!cancelled) setItems(list);
      } catch (e) {
        if (!cancelled) {
          setError({ message: asString(e?.message).trim() || "Failed to load imported reviews" });
        }
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [stableId]);

  return (
    <div className="space-y-2 rounded-lg border border-slate-200 bg-white p-4">
      <div className="flex flex-wrap items-start justify-between gap-2">
        <div>
          <div className="text-sm font-semibold text-slate-900">Imported reviews (read only)</div>
          <div className="text-xs text-slate-500">
            Fetched from <code className="text-[11px]">/api/get-reviews?company_id=…</code>
          </div>
        </div>
        <Button type="button" variant="outline" size="sm" onClick={load} disabled={!stableId || loading}>
          <RefreshCcw className="h-4 w-4 mr-2" />
          {loading ? "Loading…" : "Retry"}
        </Button>
      </div>

      {!stableId ? (
        <div className="rounded border border-slate-200 bg-slate-50 p-3 text-xs text-slate-600">
          Save the company first to generate a <code className="text-[11px]">company_id</code>.
        </div>
      ) : error ? (
        <div className="rounded border border-red-200 bg-red-50 p-3 text-sm text-red-900">
          <div className="flex items-start gap-2">
            <AlertCircle className="h-4 w-4 mt-0.5" />
            <div className="min-w-0">
              <div className="font-medium">Imported reviews failed to load</div>
              <div className="text-xs mt-1 break-words">{asString(error.message)}</div>
            </div>
          </div>
        </div>
      ) : loading ? (
        <div className="rounded border border-slate-200 bg-slate-50 p-3 text-xs text-slate-700">Loading imported reviews…</div>
      ) : items.length === 0 ? (
        <div className="rounded border border-slate-200 bg-slate-50 p-3 text-xs text-slate-600">
          No imported reviews found for this company_id.
        </div>
      ) : (
        <div className="space-y-3">
          {items.map((review, idx) => {
            const sourceName = getReviewSourceName(review) || "Unknown source";
            const text = getReviewText(review);
            const urlRaw = getReviewUrl(review);
            const url = normalizeExternalUrl(urlRaw);
            const date = getReviewDate(review);
            const rating = getReviewRating(review);
            const metadata = extractReviewMetadata(review);

            return (
              <div
                key={asString(review?.id).trim() || `${stableId}-${idx}`}
                className="rounded-lg border border-slate-200 bg-slate-50 p-3 space-y-2"
              >
                <div className="flex flex-wrap items-start justify-between gap-2">
                  <div className="min-w-0">
                    <div className="text-sm font-medium text-slate-900 truncate">{sourceName}</div>
                    {date ? <div className="text-xs text-slate-500">{toDisplayDate(date)}</div> : null}
                  </div>
                  <div className="flex items-center gap-2">
                    {rating != null ? (
                      <span className="inline-flex items-center rounded-full border border-slate-200 bg-white px-2 py-0.5 text-[11px] text-slate-700">
                        Rating: {rating}
                      </span>
                    ) : null}
                    {asString(review?.type).trim() ? (
                      <span className="inline-flex items-center rounded-full border border-slate-200 bg-white px-2 py-0.5 text-[11px] text-slate-700">
                        {asString(review.type).trim()}
                      </span>
                    ) : null}
                  </div>
                </div>

                {text ? (
                  <div className="text-sm text-slate-800 whitespace-pre-wrap break-words">{text}</div>
                ) : (
                  <div className="text-xs text-slate-500">(No text snippet returned)</div>
                )}

                {url ? (
                  <div className="text-xs">
                    <a
                      href={url}
                      target="_blank"
                      rel="noreferrer"
                      className="text-blue-700 hover:underline break-all"
                      title={urlRaw}
                    >
                      {truncateMiddle(urlRaw, 90)}
                    </a>
                  </div>
                ) : null}

                {metadata.length > 0 ? (
                  <div className="flex flex-wrap gap-2">
                    {metadata.map(([k, v]) => (
                      <span
                        key={k}
                        className="inline-flex items-center rounded-full border border-slate-200 bg-white px-2 py-0.5 text-[11px] text-slate-700"
                        title={`${k}: ${v}`}
                      >
                        {k}: {truncateMiddle(v, 40)}
                      </span>
                    ))}
                  </div>
                ) : null}
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}

function StarNotesEditor({ star, onChange }) {
  const [text, setText] = useState("");
  const [isPublic, setIsPublic] = useState(false);

  const notes = star?.notes && Array.isArray(star.notes) ? star.notes : [];

  const addNote = useCallback(() => {
    const t = asString(text).trim();
    if (!t) return;

    const next = {
      id: `note_${Date.now()}_${Math.random().toString(36).slice(2)}`,
      text: t,
      is_public: isPublic,
      created_at: new Date().toISOString(),
      created_by: "admin_ui",
    };

    onChange({ ...(star || {}), notes: [...notes, next] });
    setText("");
    setIsPublic(false);
  }, [isPublic, notes, onChange, star, text]);

  const deleteNote = useCallback(
    (idx) => {
      onChange({ ...(star || {}), notes: notes.filter((_, i) => i !== idx) });
    },
    [notes, onChange, star]
  );

  return (
    <div className="space-y-2">
      {notes.length > 0 ? (
        <div className="space-y-2">
          {notes.map((n, idx) => (
            <div key={n?.id || idx} className="rounded border border-slate-200 bg-slate-50 p-2">
              <div className="flex items-start justify-between gap-2">
                <div className="min-w-0 flex-1">
                  <div className="text-xs font-medium text-slate-700">
                    {n?.is_public ? "Public" : "Private"}
                    {n?.created_at ? ` · ${new Date(n.created_at).toLocaleString()}` : ""}
                  </div>
                  <div className="mt-1 text-sm text-slate-900 whitespace-pre-wrap break-words">{asString(n?.text)}</div>
                </div>
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  className="border-red-600 text-red-600 hover:bg-red-600 hover:text-white"
                  onClick={() => deleteNote(idx)}
                  title="Delete note"
                >
                  <Trash2 className="h-4 w-4" />
                </Button>
              </div>
            </div>
          ))}
        </div>
      ) : (
        <div className="text-xs text-slate-500">No notes.</div>
      )}

      <div className="rounded border border-slate-200 bg-white p-3 space-y-2">
        <div className="text-xs font-medium text-slate-700">Add note</div>
        <textarea
          value={text}
          onChange={(e) => setText(e.target.value)}
          className="min-h-[80px] w-full rounded-md border border-slate-200 bg-white px-3 py-2 text-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-slate-400"
          placeholder="Write a note…"
        />
        <div className="flex items-center justify-between gap-2">
          <label className="flex items-center gap-2 text-sm text-slate-700">
            <input type="checkbox" checked={isPublic} onChange={(e) => setIsPublic(e.target.checked)} />
            Public
          </label>
          <Button type="button" onClick={addNote} disabled={!asString(text).trim()}>
            <Plus className="h-4 w-4 mr-2" />
            Add note
          </Button>
        </div>
      </div>
    </div>
  );
}

function RatingEditor({ draft, onChange }) {
  const rating = normalizeRating(draft?.rating);
  const auto = calculateInitialRating(computeAutoRatingInput(draft));

  const setStar = (starKey, patch) => {
    const nextRating = {
      ...rating,
      [starKey]: {
        ...(rating[starKey] || {}),
        ...(patch || {}),
      },
    };
    onChange({ ...(draft || {}), rating: nextRating });
  };

  const renderRow = (starKey, label, autoValue) => {
    const star = rating[starKey] || { value: 0, notes: [] };
    const autoText = typeof autoValue === "number" ? String(autoValue.toFixed(1)) : null;
    const currentValue = clampStarValue(Number(star.value ?? 0));

    return (
      <div className="rounded-lg border border-slate-200 bg-white p-3 space-y-3">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <div className="text-sm font-semibold text-slate-900">{label}</div>
          {autoText != null ? (
            <div className="text-xs text-slate-600">Auto: {autoText}</div>
          ) : (
            <div className="text-xs text-slate-600">Manual</div>
          )}
        </div>

        <div className="grid grid-cols-1 md:grid-cols-3 gap-3 md:items-end">
          <div className="space-y-1">
            <label className="text-xs font-medium text-slate-700">Value (0.0–1.0)</label>
            <Input
              value={String(currentValue)}
              inputMode="decimal"
              onChange={(e) => setStar(starKey, { value: clampStarValue(Number(e.target.value)) })}
            />
          </div>

          <div className="space-y-1">
            <label className="text-xs font-medium text-slate-700">Icon</label>
            <div className="flex gap-2">
              <Button
                type="button"
                variant={star.icon_type === "heart" ? "outline" : "default"}
                onClick={() => setStar(starKey, { icon_type: "star" })}
              >
                Circle
              </Button>
              <Button
                type="button"
                variant={star.icon_type === "heart" ? "default" : "outline"}
                onClick={() => setStar(starKey, { icon_type: "heart" })}
              >
                Heart
              </Button>
            </div>
          </div>

          <div className="space-y-1">
            <label className="text-xs font-medium text-slate-700">Quick set</label>
            <div className="flex gap-2 flex-wrap">
              {[0, 0.5, 1].map((v) => (
                <Button key={v} type="button" variant="outline" onClick={() => setStar(starKey, { value: v })}>
                  {v.toFixed(1)}
                </Button>
              ))}
              {autoValue != null ? (
                <Button type="button" variant="outline" onClick={() => setStar(starKey, { value: autoValue })}>
                  Use auto
                </Button>
              ) : null}
            </div>
          </div>
        </div>

        <StarNotesEditor star={star} onChange={(nextStar) => setStar(starKey, nextStar)} />
      </div>
    );
  };

  return (
    <div className="space-y-3">
      <div className="text-sm text-slate-700 font-medium">Stars</div>
      <div className="space-y-3">
        {renderRow("star1", "Manufacturing (auto)", auto.star1.value)}
        {renderRow("star2", "HQ/Home (auto)", auto.star2.value)}
        {renderRow("star3", "Reviews (auto)", auto.star3.value)}
        {renderRow("star4", "Admin1 (manual)", null)}
        {renderRow("star5", "Admin2 (manual)", null)}
      </div>
    </div>
  );
}

async function copyToClipboard(value) {
  const s = asString(value).trim();
  if (!s) return false;

  try {
    if (navigator?.clipboard?.writeText) {
      await navigator.clipboard.writeText(s);
      return true;
    }
  } catch {
    // fall through
  }

  try {
    const el = document.createElement("textarea");
    el.value = s;
    el.setAttribute("readonly", "");
    el.style.position = "absolute";
    el.style.left = "-9999px";
    document.body.appendChild(el);
    el.select();
    const ok = document.execCommand("copy");
    document.body.removeChild(el);
    return ok;
  } catch {
    return false;
  }
}

export default function CompanyDashboard() {
  const [search, setSearch] = useState("");
  const [take, setTake] = useState(DEFAULT_TAKE);
  const [onlyIncomplete, setOnlyIncomplete] = useState(false);

  const [loading, setLoading] = useState(false);
  const [items, setItems] = useState([]);
  const [lastError, setLastError] = useState(null);
  const [rowErrors, setRowErrors] = useState({});

  const [selectedRows, setSelectedRows] = useState([]);

  const [editorOpen, setEditorOpen] = useState(false);
  const [editorSaving, setEditorSaving] = useState(false);
  const [editorLoading, setEditorLoading] = useState(false);
  const [editorLoadError, setEditorLoadError] = useState(null);
  const [editorDraft, setEditorDraft] = useState(null);
  const [editorOriginalId, setEditorOriginalId] = useState(null);
  const [editorShowAdvanced, setEditorShowAdvanced] = useState(false);
  const [editorDisplayNameOverride, setEditorDisplayNameOverride] = useState("");

  const [refreshLoading, setRefreshLoading] = useState(false);
  const [refreshError, setRefreshError] = useState(null);
  const [refreshProposed, setRefreshProposed] = useState(null);
  const [proposedDraft, setProposedDraft] = useState(null);
  const [proposedDraftText, setProposedDraftText] = useState({});
  const [refreshSelection, setRefreshSelection] = useState({});

  const [logoFile, setLogoFile] = useState(null);
  const [logoUploading, setLogoUploading] = useState(false);
  const [logoUpdating, setLogoUpdating] = useState(false);
  const [logoUploadError, setLogoUploadError] = useState(null);
  const [logoDeleting, setLogoDeleting] = useState(false);

  const [deleteConfirmOpen, setDeleteConfirmOpen] = useState(false);
  const [deleteConfirm, setDeleteConfirm] = useState(null);
  const [deleteConfirmLoading, setDeleteConfirmLoading] = useState(false);
  const [deleteConfirmError, setDeleteConfirmError] = useState(null);

  const requestSeqRef = useRef(0);
  const abortRef = useRef(null);
  const editorFetchSeqRef = useRef(0);
  const editorScrollRef = useRef(null);
  const [editorScrollEl, setEditorScrollEl] = useState(null);

  const setEditorScrollNode = useCallback((node) => {
    if (editorScrollRef.current === node) return;
    editorScrollRef.current = node;
    setEditorScrollEl((prev) => (prev === node ? prev : node));
  }, []);

  const incompleteCount = useMemo(() => {
    return items.reduce((sum, c) => sum + (toIssueTags(c).length > 0 ? 1 : 0), 0);
  }, [items]);

  const filteredItems = useMemo(() => {
    if (!onlyIncomplete) return items;
    return items.filter((c) => toIssueTags(c).length > 0);
  }, [items, onlyIncomplete]);

  const loadCompanies = useCallback(
    async (opts = {}) => {
      const q = typeof opts.search === "string" ? opts.search : search;
      const t = Number.isFinite(opts.take) ? opts.take : take;

      const seq = (requestSeqRef.current += 1);
      if (abortRef.current) {
        try {
          abortRef.current.abort();
        } catch {
          // ignore
        }
      }
      const controller = new AbortController();
      abortRef.current = controller;

      setLoading(true);
      setLastError(null);
      try {
        const params = new URLSearchParams();
        if (q.trim()) params.set("search", q.trim());
        params.set("take", String(Math.max(1, Math.min(500, Math.trunc(t || DEFAULT_TAKE)))));

        const res = await apiFetch(`/xadmin-api-companies?${params.toString()}`, { signal: controller.signal });
        const body = await res.json().catch(() => ({}));

        if (seq !== requestSeqRef.current) return;

        if (!res.ok) {
          const configMsg = await getUserFacingConfigMessage(res);
          const msg = configMsg || body?.error || `Failed to load companies (${res.status})`;
          const errorDetail = body?.detail || body?.error || res.statusText || "Unknown error";

          setLastError({
            status: res.status,
            message: msg,
            detail: errorDetail,
          });

          toast.error(msg);
          return;
        }

        const nextItems = Array.isArray(body?.items) ? body.items : [];
        setItems(nextItems);
        setRowErrors((prev) => {
          if (!prev || typeof prev !== "object") return {};
          const ids = new Set(nextItems.map((c) => getCompanyId(c)).filter(Boolean));
          const keep = {};
          for (const [key, value] of Object.entries(prev)) {
            if (ids.has(key)) keep[key] = value;
          }
          return keep;
        });
        setLastError(null);
      } catch (e) {
        if (controller.signal.aborted) return;
        const errMsg = e?.message || "Failed to load companies";
        setLastError({
          status: 503,
          message: errMsg,
          detail: e?.message || "Network or API unavailable",
        });
        toast.error(errMsg);
      } finally {
        if (seq === requestSeqRef.current) setLoading(false);
      }
    },
    [search, take]
  );

  useEffect(() => {
    const q = search.trim();
    const timeout = window.setTimeout(
      () => {
        loadCompanies({ search: q, take });
      },
      q ? 300 : 0
    );

    return () => {
      window.clearTimeout(timeout);
    };
  }, [loadCompanies, search, take]);

  useEffect(() => {
    return () => {
      if (abortRef.current) {
        try {
          abortRef.current.abort();
        } catch {
          // ignore
        }
      }
    };
  }, []);

  useEffect(() => {
    if (!editorOpen || !editorOriginalId) return;

    const companyId = asString(editorOriginalId).trim();
    if (!companyId) return;

    const seq = (editorFetchSeqRef.current += 1);
    const controller = new AbortController();

    setEditorLoading(true);
    setEditorLoadError(null);

    (async () => {
      try {
        // Contract: after a successful DELETE, GET /api/xadmin-api-companies/{id} returns 404 (deleted records are filtered out).
        const res = await apiFetch(`/xadmin-api-companies/${encodeURIComponent(companyId)}`, {
          signal: controller.signal,
        });
        const body = await res.json().catch(() => ({}));

        if (seq !== editorFetchSeqRef.current || controller.signal.aborted) return;

        if (res.status === 404) {
          const msg = "Company not found (it may have been deleted).";
          setEditorLoadError(msg);
          toast.error(msg);
          closeEditor();
          return;
        }

        const ok = (res.ok && body?.ok === true) || (!res.ok && body?.ok === true);
        const company = body?.company && typeof body.company === "object" ? body.company : null;

        if (!ok || !company) {
          const configMsg = await getUserFacingConfigMessage(res);
          const msg =
            configMsg ||
            body?.error ||
            body?.detail ||
            (!company ? "Company not found." : `Failed to load company (${res.status})`);
          setEditorLoadError(msg);
          toast.error(msg);
          return;
        }

        const draft = buildCompanyDraft(company);
        setEditorDraft(draft);
        setEditorShowAdvanced(false);
        setEditorDisplayNameOverride(inferDisplayNameOverride(draft));
      } catch (e) {
        if (controller.signal.aborted) return;
        const msg = e?.message || "Failed to load company";
        setEditorLoadError(msg);
        toast.error(msg);
      } finally {
        if (seq === editorFetchSeqRef.current) setEditorLoading(false);
      }
    })();

    return () => {
      try {
        controller.abort();
      } catch {
        // ignore
      }
    };
  }, [editorOpen, editorOriginalId]);

  const closeEditor = useCallback(() => {
    setEditorOpen(false);
    setEditorDraft(null);
    setEditorOriginalId(null);
    setEditorLoadError(null);
    setEditorLoading(false);
    setEditorSaving(false);
    setEditorShowAdvanced(false);
    setEditorDisplayNameOverride("");

    setLogoFile(null);
    setLogoUploadError(null);
    setLogoUploading(false);
    setLogoUpdating(false);
    setLogoDeleting(false);

    setRefreshLoading(false);
    setRefreshError(null);
    setRefreshProposed(null);
    setProposedDraft(null);
    setProposedDraftText({});
    setRefreshSelection({});
  }, []);

  const handleEditorOpenChange = useCallback(
    (open) => {
      if (open) {
        setEditorOpen(true);
        return;
      }
      closeEditor();
    },
    [closeEditor]
  );

  const openEditorForCompany = useCallback((company) => {
    const id = getCompanyId(company);
    const draft = buildCompanyDraft(company);

    setEditorOriginalId(id || null);
    setEditorDraft(draft);
    setEditorShowAdvanced(false);
    setEditorDisplayNameOverride(inferDisplayNameOverride(draft));
    setEditorLoadError(null);
    setLogoFile(null);
    setLogoUploadError(null);
    setRefreshLoading(false);
    setRefreshError(null);
    setRefreshProposed(null);
    setProposedDraft(null);
    setProposedDraftText({});
    setRefreshSelection({});
    setEditorOpen(true);
  }, []);

  const createNewCompany = useCallback(() => {
    const draft = {
      company_id: "",
      company_name: "",
      name: "",
      website_url: "",
      tagline: "",
      logo_url: "",
      amazon_url: "",
      amazon_store_url: "",
      affiliate_link_urls: [],
      show_location_sources_to_users: false,
      visibility: { hq_public: true, manufacturing_public: true, admin_rating_public: true },
      location_sources: [],
      headquarters_location: "",
      headquarters_locations: [],
      manufacturing_locations: [],
      industries: [],
      keywords: [],
      rating: calculateInitialRating({ hasManufacturingLocations: false, hasHeadquarters: false, hasReviews: false }),
      notes_entries: [],
      notes: "",
    };

    setEditorOriginalId(null);
    setEditorDraft(draft);
    setEditorShowAdvanced(false);
    setEditorDisplayNameOverride("");
    setLogoFile(null);
    setLogoUploadError(null);
    setRefreshLoading(false);
    setRefreshError(null);
    setRefreshProposed(null);
    setProposedDraft(null);
    setRefreshSelection({});
    setEditorOpen(true);
  }, []);

  const refreshDiffFields = useMemo(
    () => [
      { key: "company_name", label: "Company name" },
      { key: "website_url", label: "Website URL" },
      { key: "tagline", label: "Tagline" },
      { key: "headquarters_locations", label: "HQ locations" },
      { key: "manufacturing_locations", label: "Manufacturing locations" },
      { key: "industries", label: "Industries" },
      { key: "keywords", label: "Keywords" },
      { key: "red_flag", label: "Red flag" },
      { key: "red_flag_reason", label: "Red flag reason" },
      { key: "location_confidence", label: "Location confidence" },
      { key: "location_sources", label: "Location sources" },
    ],
    []
  );

  const normalizeForDiff = useCallback((key, value) => {
    switch (key) {
      case "industries":
      case "keywords": {
        return normalizeStringList(value)
          .map((v) => v.trim())
          .filter(Boolean)
          .map((v) => v.toLowerCase())
          .sort();
      }
      case "headquarters_locations":
      case "manufacturing_locations": {
        return normalizeStructuredLocationList(value)
          .map((v) => formatStructuredLocation(v))
          .map((v) => v.trim())
          .filter(Boolean)
          .map((v) => v.toLowerCase())
          .sort();
      }
      case "location_sources": {
        const list = Array.isArray(value) ? value : [];
        return list
          .filter((v) => v && typeof v === "object")
          .map((v) => {
            const location = asString(v.location).trim();
            const source_url = asString(v.source_url).trim();
            const source_type = asString(v.source_type).trim();
            const location_type = asString(v.location_type).trim();
            return [location, source_type, location_type, source_url]
              .filter(Boolean)
              .join(" | ")
              .toLowerCase();
          })
          .filter(Boolean)
          .sort();
      }
      case "red_flag": {
        return Boolean(value);
      }
      default:
        return asString(value).trim();
    }
  }, []);

  const diffToDisplay = useCallback((key, value) => {
    switch (key) {
      case "industries":
      case "keywords": {
        const list = normalizeStringList(value);
        return list.length ? list.join("\n") : "(empty)";
      }
      case "headquarters_locations":
      case "manufacturing_locations": {
        const list = normalizeStructuredLocationList(value).map((v) => formatStructuredLocation(v)).filter(Boolean);
        return list.length ? list.join("\n") : "(empty)";
      }
      case "location_sources": {
        const list = Array.isArray(value) ? value : [];
        const lines = list
          .filter((v) => v && typeof v === "object")
          .map((v) => {
            const location = asString(v.location).trim();
            const source_url = asString(v.source_url).trim();
            const source_type = asString(v.source_type).trim();
            const location_type = asString(v.location_type).trim();
            return [location, source_type, location_type, source_url].filter(Boolean).join(" — ");
          })
          .filter(Boolean);
        return lines.length ? lines.join("\n") : "(empty)";
      }
      case "red_flag": {
        return Boolean(value) ? "true" : "false";
      }
      default: {
        const s = asString(value).trim();
        return s || "(empty)";
      }
    }
  }, []);

  const diffRows = useMemo(() => {
    if (!editorDraft || !refreshProposed || typeof refreshProposed !== "object") return [];

    const rows = [];
    for (const f of refreshDiffFields) {
      if (!Object.prototype.hasOwnProperty.call(refreshProposed, f.key)) continue;

      const currentVal = editorDraft?.[f.key];
      const proposedVal = refreshProposed?.[f.key];

      const a = normalizeForDiff(f.key, currentVal);
      const b = normalizeForDiff(f.key, proposedVal);
      const changed = JSON.stringify(a) !== JSON.stringify(b);
      if (!changed) continue;

      rows.push({
        key: f.key,
        label: f.label,
        currentText: diffToDisplay(f.key, currentVal),
        proposedText: diffToDisplay(f.key, proposedVal),
      });
    }

    return rows;
  }, [diffToDisplay, editorDraft, normalizeForDiff, refreshDiffFields, refreshProposed]);

  const selectedDiffCount = useMemo(() => {
    return diffRows.reduce((sum, row) => sum + (refreshSelection[row.key] ? 1 : 0), 0);
  }, [diffRows, refreshSelection]);

  const selectAllDiffs = useCallback(() => {
    const next = {};
    for (const row of diffRows) next[row.key] = true;
    setRefreshSelection(next);
  }, [diffRows]);

  const clearAllDiffs = useCallback(() => {
    setRefreshSelection({});
  }, []);

  const applySelectedDiffs = useCallback(() => {
    if (!refreshProposed || typeof refreshProposed !== "object") return;

    setEditorDraft((prev) => {
      const base = prev && typeof prev === "object" ? prev : {};
      let next = base;

      for (const row of diffRows) {
        if (!refreshSelection[row.key]) continue;
        if (!Object.prototype.hasOwnProperty.call(refreshProposed, row.key)) continue;
        if (next === base) next = { ...base };
        next[row.key] = refreshProposed[row.key];
      }

      return next;
    });

    toast.success(`Applied ${selectedDiffCount} change${selectedDiffCount === 1 ? "" : "s"}`);
  }, [diffRows, refreshProposed, refreshSelection, selectedDiffCount]);

  const refreshCompany = useCallback(async () => {
    const companyId = asString(editorOriginalId || editorDraft?.company_id).trim();
    if (!companyId) {
      toast.error("Save the company first.");
      return;
    }

    setRefreshLoading(true);
    setRefreshError(null);
    setRefreshProposed(null);
    setRefreshSelection({});

    try {
      const refreshPaths = ["/admin-refresh-company", "/xadmin-api-refresh-company"];
      const attempts = [];

      let res;
      let usedPath = refreshPaths[0];

      for (const path of refreshPaths) {
        usedPath = path;
        res = await apiFetch(path, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ company_id: companyId }),
        });

        attempts.push({ path, status: res.status });

        if (res.status !== 404) break;
      }

      if (!res) {
        throw new Error("Refresh failed: no response");
      }

      const apiBuildId = normalizeBuildIdString(res.headers.get("x-api-build-id"));

      if (attempts.length && attempts.every((a) => a.status === 404)) {
        const staticBuildId = await fetchStaticBuildId();
        const buildId = apiBuildId || staticBuildId;

        const msg = `Refresh API missing in prod build${buildId ? ` (build ${buildId})` : ""}`;
        const errObj = {
          status: 404,
          message: msg,
          url: `/api${usedPath}`,
          attempts,
          build_id: buildId,
          response: { error: "both refresh endpoints returned 404" },
        };

        setRefreshError(errObj);
        toast.error(errObj.message);
        return;
      }

      const jsonBody = await res
        .clone()
        .json()
        .catch(() => null);
      const textBody =
        jsonBody == null
          ? await res
              .clone()
              .text()
              .catch(() => "")
          : null;

      const body = jsonBody && typeof jsonBody === "object" ? jsonBody : {};
      if (!res.ok || body?.ok !== true) {
        const msg =
          (await getUserFacingConfigMessage(res)) ||
          body?.error ||
          (typeof textBody === "string" && textBody.trim() ? textBody.trim().slice(0, 500) : "") ||
          res.statusText ||
          `Refresh failed (${res.status})`;

        const errObj = {
          status: res.status,
          message: asString(msg).trim() || `Refresh failed (${res.status})`,
          url: `/api${usedPath}`,
          attempts,
          build_id: apiBuildId,
          response: body && Object.keys(body).length ? body : textBody,
        };

        setRefreshError(errObj);
        toast.error(`${errObj.message} (${usedPath} → HTTP ${res.status})`);
        return;
      }

      const proposed = body?.proposed && typeof body.proposed === "object" ? body.proposed : null;
      if (!proposed) {
        const errObj = {
          status: res.status,
          message: "No proposed updates returned.",
          url: `/api${usedPath}`,
          attempts,
          build_id: apiBuildId,
          response: body,
        };
        setRefreshError(errObj);
        toast.error(`${errObj.message} (${usedPath} → HTTP ${res.status})`);
        return;
      }

      setRefreshProposed(proposed);

      const defaults = {};
      for (const f of refreshDiffFields) {
        if (!Object.prototype.hasOwnProperty.call(proposed, f.key)) continue;
        const a = normalizeForDiff(f.key, editorDraft?.[f.key]);
        const b = normalizeForDiff(f.key, proposed?.[f.key]);
        if (JSON.stringify(a) !== JSON.stringify(b)) defaults[f.key] = true;
      }
      setRefreshSelection(defaults);

      toast.success("Proposed updates loaded");
    } catch (e) {
      const errObj = {
        status: 0,
        message: e?.message || "Refresh failed",
        url: "(request failed)",
        response: { error: e?.message || String(e) },
      };
      setRefreshError(errObj);
      toast.error(errObj.message);
    } finally {
      setRefreshLoading(false);
    }
  }, [editorDraft, editorOriginalId, normalizeForDiff, refreshDiffFields]);

  const saveEditor = useCallback(async () => {
    if (!editorDraft) return;

    const validationError = validateCompanyDraft(editorDraft);
    if (validationError) {
      toast.error(validationError);
      return;
    }

    const isNew = !editorOriginalId;

    setEditorSaving(true);
    try {
      const draftCompanyId = asString(editorDraft.company_id).trim();
      const draftCompanyName = asString(editorDraft.company_name).trim();
      const draftDisplayOverride = asString(editorDisplayNameOverride).trim();

      const resolvedCompanyName = draftCompanyName;
      const resolvedName = draftDisplayOverride ? draftDisplayOverride : draftCompanyName;

      const suggestedId = slugifyCompanyId(resolvedCompanyName);

      const resolvedCompanyId = isNew
        ? draftCompanyId || suggestedId
        : draftCompanyId || asString(editorOriginalId).trim();

      const hqLocations = normalizeStructuredLocationList(editorDraft.headquarters_locations);
      const manuLocations = normalizeStructuredLocationList(editorDraft.manufacturing_locations);

      const industries = normalizeStringList(editorDraft.industries);
      const keywords = normalizeStringList(editorDraft.keywords);
      const rating = normalizeRating(editorDraft.rating);
      const notes_entries = normalizeCompanyNotes(editorDraft.notes_entries);
      const location_sources = normalizeLocationSources(editorDraft.location_sources);
      const visibility = normalizeVisibility(editorDraft.visibility);
      const affiliate_link_urls = normalizeStringList(editorDraft.affiliate_link_urls);

      const { rating_icon_type: _ignoredRatingIconType, ...draftBase } = editorDraft;

      const payload = {
        ...draftBase,
        company_id: resolvedCompanyId,
        id: asString(editorDraft.id).trim() || resolvedCompanyId,
        company_name: resolvedCompanyName,
        name: resolvedName,
        website_url: getCompanyUrl(editorDraft),
        url: asString(editorDraft.url || getCompanyUrl(editorDraft)).trim(),
        headquarters_location: hqLocations.length > 0 ? formatStructuredLocation(hqLocations[0]) : "",
        headquarters_locations: hqLocations,
        headquarters: hqLocations,
        manufacturing_locations: manuLocations,
        manufacturing_geocodes: manuLocations,
        industries,
        keywords,
        product_keywords: keywords,
        rating,
        notes_entries,
        notes: asString(editorDraft.notes).trim(),
        tagline: asString(editorDraft.tagline).trim(),
        logo_url: asString(editorDraft.logo_url).trim(),
        amazon_url: asString(editorDraft.amazon_url).trim(),
        amazon_store_url: asString(editorDraft.amazon_store_url).trim(),
        affiliate_link_urls,
        show_location_sources_to_users: Boolean(editorDraft.show_location_sources_to_users),
        visibility,
        location_sources,
      };

      if (!payload.company_id) {
        if (isNew) {
          payload.company_id = `company_${Date.now()}_${Math.random().toString(36).slice(2)}`;
          payload.id = payload.company_id;
        } else {
          payload.company_id = asString(editorOriginalId).trim();
          payload.id = asString(editorDraft.id).trim() || payload.company_id;
        }
      }

      const method = isNew ? "POST" : "PUT";

      const res = await apiFetch("/xadmin-api-companies", {
        method,
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ company: payload }),
      });

      const body = await res.json().catch(() => ({}));
      if (!res.ok || body?.ok !== true) {
        const msg = (await getUserFacingConfigMessage(res)) || body?.error || `Save failed (${res.status})`;
        toast.error(msg);
        return;
      }

      const savedCompany = body?.company || payload;
      const savedId = getCompanyId(savedCompany);

      setItems((prev) => {
        if (!savedId) return [savedCompany, ...prev];
        const next = prev.filter((c) => getCompanyId(c) !== savedId);
        return [savedCompany, ...next];
      });

      toast.success(isNew ? "Company created" : "Company saved");
      closeEditor();
    } catch (e) {
      toast.error(e?.message || "Save failed");
    } finally {
      setEditorSaving(false);
    }
  }, [closeEditor, editorDisplayNameOverride, editorDraft, editorOriginalId]);

  const updateCompanyInState = useCallback((companyId, patch) => {
    const id = asString(companyId).trim();
    if (!id) return;
    setItems((prev) =>
      prev.map((c) => {
        if (getCompanyId(c) !== id) return c;
        return { ...c, ...(patch || {}) };
      })
    );
  }, []);

  const isAllowedLogoType = useCallback((type) => {
    return type === "image/png" || type === "image/jpeg" || type === "image/webp";
  }, []);

  const handleLogoFileChange = useCallback(
    (e) => {
      const file = e?.target?.files?.[0] || null;
      setLogoUploadError(null);
      setLogoFile(null);

      if (!file) return;

      if (!isAllowedLogoType(file.type)) {
        setLogoUploadError("Invalid file type. Use PNG, JPG, or WebP.");
        return;
      }

      const maxBytes = 300 * 1024;
      if (typeof file.size === "number" && file.size > maxBytes) {
        setLogoUploadError("File too large. Max size is 300KB.");
        return;
      }

      setLogoFile(file);
    },
    [isAllowedLogoType]
  );

  const uploadLogo = useCallback(async () => {
    const companyId = asString(editorOriginalId).trim();
    if (!companyId) {
      toast.error("Save the company first to generate a company_id, then upload the logo.");
      return;
    }

    if (!logoFile) {
      toast.error("Choose a logo file first.");
      return;
    }

    setLogoUploading(true);
    setLogoUploadError(null);

    try {
      const url = await uploadLogoBlobFile(logoFile, companyId);

      setEditorDraft((d) => ({ ...(d || {}), logo_url: url }));
      updateCompanyInState(companyId, { logo_url: url });
      setLogoFile(null);
      toast.success("Logo uploaded");
    } catch (e) {
      const msg = e?.message || "Logo upload failed";
      setLogoUploadError(msg);
      toast.error(msg);
    } finally {
      setLogoUploading(false);
    }
  }, [editorOriginalId, logoFile, updateCompanyInState]);

  const clearLogoReference = useCallback(() => {
    const companyId = asString(editorOriginalId).trim();
    setEditorDraft((d) => ({ ...(d || {}), logo_url: "" }));
    if (companyId) updateCompanyInState(companyId, { logo_url: "" });
    toast.success("Logo cleared (save to persist)");
  }, [editorOriginalId, updateCompanyInState]);

  const deleteLogoFromStorage = useCallback(async () => {
    const companyId = asString(editorOriginalId).trim();
    const current = asString(editorDraft?.logo_url).trim();

    if (!companyId) {
      toast.error("Missing company_id");
      return;
    }

    if (!current) {
      toast.error("No logo to delete");
      return;
    }

    const isAzure = current.includes(".blob.core.windows.net") && current.includes("/company-logos/");
    if (!isAzure) {
      toast.error("This logo is not stored in Azure Blob Storage. Use Clear instead.");
      return;
    }

    setLogoDeleting(true);
    try {
      await deleteLogoBlob(current);

      setEditorDraft((d) => ({ ...(d || {}), logo_url: "" }));
      updateCompanyInState(companyId, { logo_url: "" });
      toast.success("Logo deleted");
    } catch (e) {
      const msg = e?.message || "Failed to delete logo";
      toast.error(msg);
    } finally {
      setLogoDeleting(false);
    }
  }, [editorDraft, editorOriginalId, updateCompanyInState]);

  const deleteCompany = useCallback(async (companyId) => {
    const safeId = asString(companyId).trim();
    if (!safeId) {
      toast.error("Missing company_id");
      return { ok: false, id: safeId, message: "Missing company_id" };
    }

    setRowErrors((prev) => {
      const next = { ...(prev || {}) };
      delete next[safeId];
      return next;
    });

    try {
      const res = await apiFetch(`/xadmin-api-companies/${encodeURIComponent(safeId)}`, {
        method: "DELETE",
      });

      const body = await res.json().catch(() => ({}));
      const ok = (res.ok && body?.ok === true) || (!res.ok && body?.ok === true);

      if (!ok) {
        const msg = (await getUserFacingConfigMessage(res)) || body?.error || `Delete failed (${res.status})`;
        const detail = body?.detail || body?.error || res.statusText || "Unknown error";

        setRowErrors((prev) => ({
          ...(prev || {}),
          [safeId]: { status: res.status, message: msg, detail, body },
        }));

        return { ok: false, id: safeId, message: msg, detail, body, status: res.status };
      }

      setItems((prev) => prev.filter((c) => getCompanyId(c) !== safeId));
      setRowErrors((prev) => {
        const next = { ...(prev || {}) };
        delete next[safeId];
        return next;
      });

      return { ok: true, id: safeId };
    } catch (e) {
      const msg = e?.message || "Delete failed";
      setRowErrors((prev) => ({
        ...(prev || {}),
        [safeId]: { status: 0, message: msg, detail: msg },
      }));
      return { ok: false, id: safeId, message: msg, detail: msg, status: 0 };
    }
  }, []);

  const openDeleteConfirm = useCallback((spec) => {
    setDeleteConfirmError(null);
    setDeleteConfirm(spec);
    setDeleteConfirmOpen(true);
  }, []);

  const confirmDelete = useCallback(async () => {
    if (!deleteConfirm) return;
    setDeleteConfirmLoading(true);
    setDeleteConfirmError(null);

    try {
      if (deleteConfirm.kind === "bulk") {
        let deleted = 0;
        for (const id of deleteConfirm.ids) {
          const res = await deleteCompany(id);
          if (res.ok) deleted += 1;
        }
        if (deleted > 0) toast.success(`Deleted ${deleted} compan${deleted === 1 ? "y" : "ies"}`);
        setSelectedRows([]);
        setDeleteConfirmOpen(false);
        return;
      }

      const res = await deleteCompany(deleteConfirm.company_id);
      if (!res.ok) {
        setDeleteConfirmError({
          message: asString(res.message || "Delete failed"),
          detail: asString(res.detail || ""),
          body: res.body,
        });
        toast.error(asString(res.message || "Delete failed"));
        return;
      }

      toast.success("Company deleted");
      setDeleteConfirmOpen(false);
      closeEditor();
    } finally {
      setDeleteConfirmLoading(false);
    }
  }, [closeEditor, deleteCompany, deleteConfirm]);

  const deleteSelected = useCallback(() => {
    const ids = selectedRows.map((r) => getCompanyId(r)).filter(Boolean);
    if (ids.length === 0) return;

    openDeleteConfirm({ kind: "bulk", ids, label: `${ids.length} selected compan${ids.length === 1 ? "y" : "ies"}` });
  }, [openDeleteConfirm, selectedRows]);

  const columns = useMemo(() => {
    return [
      {
        name: "Name",
        selector: (row) => getCompanyName(row),
        sortable: true,
        wrap: true,
        grow: 2,
        cell: (row) => {
          const name = getCompanyName(row);
          return (
            <div className="flex flex-wrap items-center gap-2 min-w-0">
              <span className={isDeletedCompany(row) ? "text-slate-500 line-through" : "text-slate-900"}>{name || "(missing)"}</span>
              {isDeletedCompany(row) ? (
                <span className="rounded-full bg-slate-100 border border-slate-200 px-2 py-0.5 text-[11px] text-slate-700">
                  deleted
                </span>
              ) : null}
            </div>
          );
        },
      },
      {
        name: "Domain",
        selector: (row) => asString(row?.normalized_domain).trim(),
        sortable: true,
        wrap: true,
      },
      {
        name: "HQ",
        selector: (row) => {
          const hqList = normalizeStructuredLocationList(
            row?.headquarters_locations || row?.headquarters || row?.headquarters_location
          );
          return hqList.map((l) => formatStructuredLocation(l)).filter(Boolean).join("; ");
        },
        sortable: true,
        wrap: true,
      },
      {
        name: "MFG",
        selector: (row) => {
          const manuBase =
            Array.isArray(row?.manufacturing_geocodes) && row.manufacturing_geocodes.length > 0
              ? row.manufacturing_geocodes
              : row?.manufacturing_locations;
          const list = normalizeStructuredLocationList(manuBase);
          return list.map((l) => formatStructuredLocation(l)).filter(Boolean).join("; ");
        },
        sortable: false,
        wrap: true,
      },
      {
        name: "Reviews",
        selector: (row) => Number(row?.review_count ?? row?.reviews_count ?? 0) || 0,
        sortable: true,
        right: true,
        width: "110px",
      },
      {
        name: "Updated",
        selector: (row) => asString(row?.updated_at || row?.created_at).trim(),
        sortable: true,
        cell: (row) => (
          <span className="text-xs text-slate-700">{toDisplayDate(row?.updated_at || row?.created_at)}</span>
        ),
        width: "160px",
      },
      {
        name: "Issues",
        sortable: false,
        cell: (row) => {
          const tags = toIssueTags(row);
          if (tags.length === 0) return <span className="text-xs text-emerald-700">OK</span>;

          const shown = tags.slice(0, 3);
          const more = tags.length - shown.length;
          return (
            <div className="flex flex-wrap gap-1">
              {shown.map((t) => (
                <span
                  key={t}
                  className="rounded-full bg-amber-50 border border-amber-200 px-2 py-0.5 text-[11px] text-amber-900"
                >
                  {t}
                </span>
              ))}
              {more > 0 ? (
                <span className="rounded-full bg-slate-50 border border-slate-200 px-2 py-0.5 text-[11px] text-slate-700">
                  +{more}
                </span>
              ) : null}
            </div>
          );
        },
        width: "240px",
      },
      {
        name: "Actions",
        button: true,
        cell: (row) => {
          const id = getCompanyId(row);
          const rowError = id ? rowErrors?.[id] : null;

          return (
            <div className="space-y-2">
              <div className="flex items-center gap-2">
                <Button size="sm" variant="outline" onClick={() => openEditorForCompany(row)}>
                  <Pencil className="h-4 w-4" />
                </Button>
                <Button
                  size="sm"
                  variant="outline"
                  className="border-red-600 text-red-600 hover:bg-red-600 hover:text-white"
                  onClick={() =>
                    openDeleteConfirm({
                      kind: "single",
                      company_id: id,
                      company_name: getCompanyName(row),
                    })
                  }
                  disabled={!id}
                >
                  <Trash2 className="h-4 w-4" />
                </Button>
              </div>

              {rowError ? (
                <div className="max-w-[520px] rounded border border-red-200 bg-red-50 p-2 text-[11px] text-red-900">
                  <div className="font-medium">Delete failed</div>
                  <div>{asString(rowError.message || "Delete failed")}</div>
                  {rowError.detail && rowError.detail !== rowError.message ? (
                    <div className="mt-1 whitespace-pre-wrap break-words font-mono text-red-800">
                      {asString(rowError.detail)}
                    </div>
                  ) : null}
                  {rowError.body && typeof rowError.body === "object" ? (
                    <pre className="mt-1 whitespace-pre-wrap break-words font-mono text-red-800">
                      {prettyJson(rowError.body)}
                    </pre>
                  ) : null}
                </div>
              ) : null}
            </div>
          );
        },
        width: "140px",
      },
    ];
  }, [openDeleteConfirm, openEditorForCompany, rowErrors]);

  const tableTheme = useMemo(
    () => ({
      header: {
        style: {
          minHeight: "48px",
        },
      },
      headCells: {
        style: {
          fontWeight: 600,
          fontSize: "12px",
          textTransform: "uppercase",
          letterSpacing: "0.06em",
        },
      },
    }),
    []
  );

  const contextActions = useMemo(() => {
    if (!selectedRows || selectedRows.length === 0) return null;
    return (
      <Button
        variant="outline"
        className="border-red-600 text-red-600 hover:bg-red-600 hover:text-white"
        onClick={deleteSelected}
      >
        <Trash2 className="h-4 w-4 mr-2" />
        Delete selected ({selectedRows.length})
      </Button>
    );
  }, [deleteSelected, selectedRows]);

  const noDataComponent = useMemo(() => {
    if (lastError && (lastError.status === 503 || lastError.status === 404 || lastError.status >= 500)) {
      return <div className="p-6 text-sm text-slate-600">Unable to load companies (see error above).</div>;
    }
    return <div className="p-6 text-sm text-slate-600">No companies found.</div>;
  }, [lastError]);

  const progressComponent = useMemo(() => {
    return <div className="p-6 text-sm text-slate-600">Loading companies…</div>;
  }, []);

  const editorValidationError = useMemo(() => {
    return editorDraft ? validateCompanyDraft(editorDraft) : null;
  }, [editorDraft]);

  const editorCompanyId = useMemo(() => {
    if (!editorDraft) return "";
    const isNew = !editorOriginalId;
    const existing = asString(editorDraft.company_id).trim();
    if (existing) return existing;
    if (!isNew) return "";

    const suggested = slugifyCompanyId(getCompanyName(editorDraft));
    return suggested;
  }, [editorDraft, editorOriginalId]);

  return (
    <>
      <Helmet>
        <title>Tabarnam Admin — Companies</title>
        <meta name="robots" content="noindex, nofollow" />
      </Helmet>

      <div className="min-h-screen bg-slate-50">
        <AdminHeader />

        <main className="container mx-auto py-6 px-4 space-y-4">
          <header className="flex flex-col gap-3">
            <div className="flex flex-wrap items-center justify-between gap-3">
              <h1 className="text-3xl font-bold text-slate-900">Companies</h1>

              <div className="flex flex-wrap items-center gap-2">
                <Button variant="outline" onClick={() => loadCompanies({ search: search.trim(), take })} disabled={loading}>
                  <RefreshCcw className="h-4 w-4 mr-2" />
                  {loading ? "Loading…" : "Refresh"}
                </Button>
                <Button onClick={createNewCompany}>
                  <Plus className="h-4 w-4 mr-2" />
                  New company
                </Button>
              </div>
            </div>

            <div className="flex flex-wrap items-center gap-3">
              <div className="flex items-center gap-2">
                <Input
                  value={search}
                  onChange={(e) => setSearch(e.target.value)}
                  placeholder="Search companies (server-side)…"
                  className="w-[320px]"
                />
              </div>

              <div className="flex items-center gap-2">
                <label className="text-sm text-slate-700">Take</label>
                <Input
                  value={String(take)}
                  onChange={(e) => setTake(Number(e.target.value || DEFAULT_TAKE))}
                  className="w-[100px]"
                  inputMode="numeric"
                />
              </div>

              <Button
                variant={onlyIncomplete ? "default" : "outline"}
                onClick={() => setOnlyIncomplete((v) => !v)}
                title="Show only companies missing key fields"
              >
                <AlertTriangle className="h-4 w-4 mr-2" />
                Incomplete ({incompleteCount})
              </Button>

              <div className="text-sm text-slate-600">
                Showing {filteredItems.length} companies{loading ? " · Loading…" : ""}
              </div>
            </div>
          </header>

          {lastError && (lastError.status === 503 || lastError.status === 404 || lastError.status >= 500) && (
            <div className="rounded-lg border-2 border-red-500 bg-red-50 p-4">
              <div className="flex items-start gap-3">
                <AlertCircle className="h-6 w-6 text-red-600 flex-shrink-0 mt-0.5" />
                <div className="flex-1">
                  <h3 className="text-lg font-semibold text-red-900">Admin API Unavailable ({lastError.status})</h3>
                  <p className="mt-1 text-sm text-red-800">{lastError.message}</p>
                  {lastError.detail && lastError.detail !== lastError.message && (
                    <p className="mt-1 text-xs text-red-700 font-mono">{lastError.detail}</p>
                  )}
                  <div className="mt-3 flex gap-2">
                    <Button asChild variant="destructive" size="sm">
                      <Link to="/admin/diagnostics">Go to Diagnostics</Link>
                    </Button>
                    <Button
                      variant="outline"
                      size="sm"
                      onClick={() => loadCompanies({ search: search.trim(), take })}
                      disabled={loading}
                    >
                      <RefreshCcw className="h-4 w-4 mr-2" />
                      Retry
                    </Button>
                  </div>
                </div>
              </div>
            </div>
          )}

          <section className="rounded-lg border border-slate-200 bg-white overflow-hidden">
            <DataTable
              columns={columns}
              data={filteredItems}
              conditionalRowStyles={[
                {
                  when: (row) => isDeletedCompany(row),
                  style: {
                    backgroundColor: "#f8fafc",
                    color: "#64748b",
                  },
                },
              ]}
              progressPending={loading && items.length === 0}
              progressComponent={progressComponent}
              pagination
              paginationPerPage={25}
              paginationRowsPerPageOptions={[10, 25, 50, 100]}
              highlightOnHover
              pointerOnHover
              dense
              theme={tableTheme}
              selectableRows
              onSelectedRowsChange={(state) => setSelectedRows(state?.selectedRows || [])}
              clearSelectedRows={selectedRows.length === 0}
              contextActions={contextActions}
              onRowClicked={(row) => openEditorForCompany(row)}
              noDataComponent={noDataComponent}
            />
          </section>

          <Dialog open={editorOpen} onOpenChange={handleEditorOpenChange}>
            <DialogContent className="w-[95vw] max-w-[1500px] h-[90vh] max-h-[90vh] p-0 bg-white overflow-hidden flex flex-col gap-0">
              <ErrorBoundary
                resetKeys={[editorOriginalId, editorOpen]}
                fallback={({ error }) => (
                  <div className="bg-white opacity-100 w-full h-full max-h-[90vh] overflow-auto">
                    <div className="p-6 space-y-4">
                      <div className="text-lg font-semibold text-slate-900">Edit dialog crashed</div>
                      <div className="text-sm text-slate-700 font-mono whitespace-pre-wrap break-words">
                        {asString(error?.message || error)}
                      </div>
                      <pre className="rounded border border-slate-200 bg-slate-50 p-3 text-xs text-slate-800 whitespace-pre-wrap break-words">
                        {prettyJson(error)}
                      </pre>
                      <Button type="button" onClick={closeEditor}>
                        Close
                      </Button>
                    </div>
                  </div>
                )}
              >
                <div className="flex h-full min-h-0 flex-col">
                  <DialogHeader className="flex-none px-6 py-4 border-b bg-white">
                    <DialogTitle>{editorOriginalId ? "Edit company v2" : "New company"}</DialogTitle>
                    <DialogDescription className="sr-only">
                      Edit company details. Use Refresh search to fetch proposed updates.
                    </DialogDescription>
                  </DialogHeader>

                  <div className="relative flex flex-1 min-h-0">
                    <div
                      data-testid="edit-scroll-area"
                      ref={setEditorScrollNode}
                      className="flex-1 min-h-0 overflow-auto no-scrollbar px-6 py-4 pr-16"
                    >
                  {editorLoadError ? (
                    <div className="rounded-lg border border-red-200 bg-red-50 p-4 text-sm text-red-900">
                      {asString(editorLoadError)}
                    </div>
                  ) : null}

                  {editorLoading && !editorLoadError ? (
                    <div className="rounded-lg border border-slate-200 bg-slate-50 p-4 text-sm text-slate-700">
                      Loading company…
                    </div>
                  ) : null}

                  {!editorDraft && !editorLoading && !editorLoadError ? (
                    <div className="rounded-lg border border-amber-200 bg-amber-50 p-4 text-sm text-amber-900">
                      Could not load company. Close and re-open.
                    </div>
                  ) : null}

                  {editorDraft ? (
                    <div className="space-y-5">
                      <div className="rounded-lg border border-slate-200 bg-slate-50 p-4">
                        <div className="flex flex-col gap-3 lg:flex-row lg:items-start lg:justify-between">
                          <div className="min-w-0">
                            <div className="text-xs font-medium text-slate-700">company_id</div>
                            <div className="mt-1 flex flex-col gap-3 sm:flex-row sm:items-start sm:gap-4">
                              <div className="flex flex-wrap items-center gap-2">
                                <code className="rounded bg-white border border-slate-200 px-2 py-1 text-xs text-slate-900">
                                  {editorOriginalId ? asString(editorDraft.company_id).trim() || "(missing)" : editorCompanyId || "(auto)"}
                                </code>
                                <Button
                                  variant="outline"
                                  size="sm"
                                  onClick={async () => {
                                    const value = editorOriginalId
                                      ? asString(editorDraft.company_id).trim()
                                      : asString(editorCompanyId).trim();
                                    const ok = await copyToClipboard(value);
                                    if (ok) toast.success("Copied");
                                    else toast.error("Copy failed");
                                  }}
                                  disabled={
                                    !(editorOriginalId
                                      ? asString(editorDraft.company_id).trim()
                                      : asString(editorCompanyId).trim())
                                  }
                                  title="Copy company_id"
                                >
                                  <Copy className="h-4 w-4" />
                                </Button>
                              </div>

                              {editorOriginalId ? (
                                <Button
                                  variant="outline"
                                  size="sm"
                                  className="flex-none"
                                  onClick={refreshCompany}
                                  disabled={refreshLoading || editorSaving}
                                  title="Refresh search"
                                >
                                  <RefreshCcw className="h-4 w-4 mr-2" />
                                  {refreshLoading ? "Refreshing…" : "Refresh search"}
                                </Button>
                              ) : null}

                              {editorOriginalId ? (
                                <div className="min-w-0 flex-1 text-xs text-muted-foreground max-w-[520px] leading-snug">
                                  Click “Refresh search” to fetch proposed updates. Protected fields (logo, notes, manual stars) are never overwritten.
                                </div>
                              ) : null}
                            </div>
                          </div>

                          {!editorOriginalId ? (
                            <div className="min-w-[260px]">
                              <label className="text-xs font-medium text-slate-700">Override company_id (optional)</label>
                              <Input
                                value={asString(editorDraft.company_id)}
                                onChange={(e) => setEditorDraft((d) => ({ ...d, company_id: e.target.value }))}
                                placeholder={slugifyCompanyId(getCompanyName(editorDraft)) || "auto-generated"}
                                className="mt-1"
                              />
                            </div>
                          ) : null}
                        </div>
                      </div>

                      {editorOriginalId && (refreshLoading || refreshError || refreshProposed) ? (
                        <div className="rounded-lg border border-slate-200 bg-white p-4 space-y-3">
                          <div className="flex flex-wrap items-center justify-between gap-2">
                            <div className="text-sm font-semibold text-slate-900">Proposed refresh</div>
                            {refreshProposed && diffRows.length > 0 ? (
                              <div className="flex flex-wrap items-center gap-2">
                                <Button type="button" size="sm" variant="outline" onClick={selectAllDiffs}>
                                  Select all
                                </Button>
                                <Button type="button" size="sm" variant="outline" onClick={clearAllDiffs}>
                                  Clear
                                </Button>
                                <Button
                                  type="button"
                                  size="sm"
                                  onClick={applySelectedDiffs}
                                  disabled={selectedDiffCount === 0}
                                >
                                  Apply selected ({selectedDiffCount})
                                </Button>
                              </div>
                            ) : null}
                          </div>

                          {refreshError ? (
                            <div className="rounded border border-red-200 bg-red-50 p-3 text-sm text-red-900">
                              <div className="flex flex-wrap items-start justify-between gap-2">
                                <div className="min-w-0">
                                  <div className="font-semibold">
                                    Refresh failed{refreshError?.status ? ` (HTTP ${refreshError.status})` : ""}
                                  </div>
                                  <div className="mt-1 whitespace-pre-wrap break-words">{asString(refreshError?.message)}</div>
                                  {Array.isArray(refreshError?.attempts) && refreshError.attempts.length ? (
                                    <div className="mt-2 text-xs text-red-900/80 whitespace-pre-wrap break-words">
                                      Tried: {refreshError.attempts.map((a) => `${a.path} → ${a.status}`).join(", ")}
                                      {refreshError?.build_id ? ` • build ${asString(refreshError.build_id)}` : ""}
                                    </div>
                                  ) : refreshError?.build_id ? (
                                    <div className="mt-2 text-xs text-red-900/80">Build: {asString(refreshError.build_id)}</div>
                                  ) : null}
                                </div>
                                <Button
                                  type="button"
                                  size="sm"
                                  variant="outline"
                                  className="bg-white"
                                  onClick={async () => {
                                    const ok = await copyToClipboard(prettyJson(refreshError));
                                    if (ok) toast.success("Copied error");
                                    else toast.error("Copy failed");
                                  }}
                                  title="Copy error"
                                >
                                  <Copy className="h-4 w-4 mr-2" />
                                  Copy error
                                </Button>
                              </div>
                            </div>
                          ) : null}

                          {refreshLoading && !refreshProposed && !refreshError ? (
                            <div className="rounded border border-slate-200 bg-slate-50 p-3 text-sm text-slate-700">
                              Fetching proposed updates…
                            </div>
                          ) : refreshProposed ? (
                            diffRows.length > 0 ? (
                              <div className="space-y-3">
                                {diffRows.map((row) => (
                                  <div key={row.key} className="rounded-lg border border-slate-200 bg-slate-50 p-3">
                                    <div className="flex items-start gap-3">
                                      <Checkbox
                                        checked={Boolean(refreshSelection[row.key])}
                                        onCheckedChange={(checked) =>
                                          setRefreshSelection((prev) => ({
                                            ...(prev || {}),
                                            [row.key]: Boolean(checked),
                                          }))
                                        }
                                        aria-label={`Overwrite ${row.label}`}
                                      />
                                      <div className="flex-1 min-w-0">
                                        <div className="text-sm font-medium text-slate-900">{row.label}</div>
                                        <div className="mt-2 grid grid-cols-1 lg:grid-cols-2 gap-3">
                                          <div className="rounded border border-slate-200 bg-white p-2">
                                            <div className="text-xs font-semibold text-slate-700">Current</div>
                                            <pre className="mt-1 whitespace-pre-wrap break-words text-xs text-slate-800">{row.currentText}</pre>
                                          </div>
                                          <div className="rounded border border-slate-200 bg-white p-2">
                                            <div className="text-xs font-semibold text-slate-700">Proposed</div>
                                            <pre className="mt-1 whitespace-pre-wrap break-words text-xs text-slate-800">{row.proposedText}</pre>
                                          </div>
                                        </div>
                                      </div>
                                    </div>
                                  </div>
                                ))}

                                <div className="text-xs text-slate-600">
                                  Protected fields are never overwritten: logo, structured notes, and manual stars.
                                </div>
                              </div>
                            ) : (
                              <div className="rounded border border-slate-200 bg-slate-50 p-3 text-sm text-slate-700">
                                No differences found.
                              </div>
                            )
                          ) : null}
                        </div>
                      ) : null}

                      <div className="grid grid-cols-1 gap-6 lg:grid-cols-[minmax(0,1fr)_minmax(320px,460px)]">
                        <div className="space-y-5">
                          <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
                            <div className="space-y-1 md:col-span-2">
                              <div className="flex items-center justify-between gap-2">
                                <label className="text-sm text-slate-700">
                                  Company name <span className="text-red-600">*</span>
                                </label>
                                {asString(editorDisplayNameOverride).trim() ? (
                                  <span className="rounded-full bg-emerald-50 border border-emerald-200 px-2 py-0.5 text-[11px] text-emerald-900">
                                    Using display name
                                  </span>
                                ) : null}
                              </div>
                              <Input
                                required
                                value={asString(editorDraft.company_name)}
                                onChange={(e) => {
                                  const next = e.target.value;
                                  setEditorDraft((d) => {
                                    const base = d && typeof d === "object" ? d : {};
                                    const override = asString(editorDisplayNameOverride).trim();
                                    const out = { ...base, company_name: next };
                                    if (!override) out.name = next;
                                    return out;
                                  });
                                }}
                                placeholder="Acme Corp"
                              />
                            </div>

                            <div className="space-y-2 md:col-span-2">
                              <button
                                type="button"
                                className="flex w-full items-center justify-between rounded-md border border-slate-200 bg-white px-3 py-2 text-sm text-slate-800 hover:bg-slate-50"
                                onClick={() => setEditorShowAdvanced((v) => !v)}
                                aria-expanded={editorShowAdvanced}
                              >
                                <span className="font-medium">Display options</span>
                                <ChevronDown className={editorShowAdvanced ? "h-4 w-4 rotate-180 transition-transform" : "h-4 w-4 transition-transform"} />
                              </button>

                              {editorShowAdvanced ? (
                                <div className="rounded-lg border border-slate-200 bg-slate-50 p-3 space-y-2">
                                  <div className="space-y-1">
                                    <label className="text-sm text-slate-700">Display name (optional)</label>
                                    <Input
                                      value={editorDisplayNameOverride}
                                      onChange={(e) => {
                                        const next = e.target.value;
                                        setEditorDisplayNameOverride(next);
                                        setEditorDraft((d) => {
                                          const base = d && typeof d === "object" ? d : {};
                                          const companyName = asString(base.company_name).trim();
                                          return { ...base, name: asString(next).trim() ? next : companyName };
                                        });
                                      }}
                                      placeholder={asString(editorDraft.company_name) || ""}
                                    />
                                  </div>
                                  <div className="text-xs text-slate-600">
                                    If set, this is what users see. If empty, we show Company name.
                                  </div>
                                </div>
                              ) : null}
                            </div>

                            <div className="space-y-1 md:col-span-2">
                              <label className="text-sm text-slate-700">Website URL</label>
                              <Input
                                value={asString(editorDraft.website_url)}
                                onChange={(e) => setEditorDraft((d) => ({ ...d, website_url: e.target.value }))}
                                placeholder="https://example.com"
                              />
                            </div>

                            <div className="space-y-1 md:col-span-2">
                              <label className="text-sm text-slate-700">Tagline</label>
                              <Input
                                value={asString(editorDraft.tagline)}
                                onChange={(e) => setEditorDraft((d) => ({ ...d, tagline: e.target.value }))}
                                placeholder="Mission statement…"
                              />
                            </div>

                            <div className="space-y-1">
                              <label className="text-sm text-slate-700">Amazon URL</label>
                              <Input
                                value={asString(editorDraft.amazon_url)}
                                onChange={(e) => setEditorDraft((d) => ({ ...d, amazon_url: e.target.value }))}
                              />
                            </div>

                            <div className="space-y-1">
                              <label className="text-sm text-slate-700">Amazon store URL</label>
                              <Input
                                value={asString(editorDraft.amazon_store_url)}
                                onChange={(e) => setEditorDraft((d) => ({ ...d, amazon_store_url: e.target.value }))}
                              />
                            </div>
                          </div>

                          <div className="space-y-2">
                            <label className="text-sm text-slate-700">Logo</label>

                            {asString(editorDraft.logo_url).trim() ? (
                              <div className="flex items-center gap-3 rounded-lg border border-slate-200 bg-white p-2">
                                <img
                                  src={asString(editorDraft.logo_url).trim()}
                                  alt="Company logo"
                                  className="h-12 w-12 rounded border border-slate-200 object-contain bg-white"
                                  loading="lazy"
                                  onError={(e) => {
                                    e.currentTarget.style.display = "none";
                                  }}
                                />
                                <div className="flex-1 min-w-0">
                                  <div className="text-xs text-slate-500">Current logo_url</div>
                                  <div className="text-xs text-slate-800 break-all">{asString(editorDraft.logo_url).trim()}</div>
                                </div>
                              </div>
                            ) : (
                              <div className="text-xs text-slate-500">No logo uploaded.</div>
                            )}

                            <div className="flex flex-wrap items-center gap-2">
                              <input
                                type="file"
                                accept="image/png,image/jpeg,image/webp"
                                onChange={handleLogoFileChange}
                                className="block w-full max-w-[360px] text-sm text-slate-700 file:mr-3 file:rounded-md file:border-0 file:bg-slate-900 file:px-3 file:py-2 file:text-sm file:font-medium file:text-white hover:file:bg-slate-900/90"
                                disabled={logoUploading || logoDeleting}
                              />

                              <Button
                                variant="outline"
                                onClick={uploadLogo}
                                disabled={!editorOriginalId || !logoFile || logoUploading || Boolean(logoUploadError) || logoDeleting}
                              >
                                {logoUploading ? "Uploading…" : "Upload"}
                              </Button>

                              <Button
                                variant="outline"
                                onClick={clearLogoReference}
                                disabled={logoUploading || logoDeleting || !asString(editorDraft.logo_url).trim()}
                              >
                                Clear
                              </Button>

                              <Button
                                variant="outline"
                                className="border-red-600 text-red-600 hover:bg-red-600 hover:text-white"
                                onClick={deleteLogoFromStorage}
                                disabled={
                                  logoUploading ||
                                  logoDeleting ||
                                  !editorOriginalId ||
                                  !asString(editorDraft.logo_url).trim() ||
                                  !(asString(editorDraft.logo_url).includes(".blob.core.windows.net") &&
                                    asString(editorDraft.logo_url).includes("/company-logos/"))
                                }
                              >
                                {logoDeleting ? "Deleting…" : "Delete from storage"}
                              </Button>
                            </div>

                            {logoFile ? (
                              <div className="text-xs text-slate-600">
                                Selected: {logoFile.name} ({Math.round((logoFile.size / 1024) * 10) / 10}KB)
                              </div>
                            ) : null}

                            {logoUploadError ? <div className="text-xs text-red-700">{logoUploadError}</div> : null}

                            {!editorOriginalId ? (
                              <div className="text-xs text-slate-600">Save the company first to enable uploads.</div>
                            ) : null}
                          </div>

                          <StringListEditor
                            label="Affiliate link URLs"
                            value={editorDraft.affiliate_link_urls}
                            onChange={(next) => setEditorDraft((d) => ({ ...(d || {}), affiliate_link_urls: next }))}
                          />

                          <LocationSourcesEditor
                            value={editorDraft.location_sources}
                            onChange={(next) => setEditorDraft((d) => ({ ...(d || {}), location_sources: next }))}
                          />

                          <StructuredLocationListEditor
                            label="HQ locations"
                            value={editorDraft.headquarters_locations}
                            onChange={(next) => setEditorDraft((d) => ({ ...(d || {}), headquarters_locations: next }))}
                          />

                          <StructuredLocationListEditor
                            label="Manufacturing locations"
                            value={editorDraft.manufacturing_locations}
                            onChange={(next) => setEditorDraft((d) => ({ ...(d || {}), manufacturing_locations: next }))}
                          />

                          <StringListEditor
                            label="Industries"
                            value={editorDraft.industries}
                            onChange={(next) => setEditorDraft((d) => ({ ...(d || {}), industries: next }))}
                            placeholder="Add an industry…"
                          />

                          <StringListEditor
                            label="Keywords"
                            value={editorDraft.keywords}
                            onChange={(next) => setEditorDraft((d) => ({ ...(d || {}), keywords: next }))}
                            placeholder="Add a keyword…"
                          />
                        </div>

                        <div className="space-y-5">
                          <div className="space-y-3 rounded-lg border border-slate-200 bg-white p-4">
                            <div className="text-sm font-semibold text-slate-900">Visibility</div>
                            <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                              <label className="flex items-start gap-2 text-sm text-slate-800">
                                <Checkbox
                                  checked={Boolean(editorDraft.show_location_sources_to_users)}
                                  onCheckedChange={(v) =>
                                    setEditorDraft((d) => ({
                                      ...(d || {}),
                                      show_location_sources_to_users: Boolean(v),
                                    }))
                                  }
                                />
                                <span>Show location sources to users</span>
                              </label>

                              <label className="flex items-start gap-2 text-sm text-slate-800">
                                <Checkbox
                                  checked={Boolean(editorDraft.visibility?.hq_public)}
                                  onCheckedChange={(v) =>
                                    setEditorDraft((d) => ({
                                      ...(d || {}),
                                      visibility: { ...normalizeVisibility(d?.visibility), hq_public: Boolean(v) },
                                    }))
                                  }
                                />
                                <span>Show HQ location</span>
                              </label>

                              <label className="flex items-start gap-2 text-sm text-slate-800">
                                <Checkbox
                                  checked={Boolean(editorDraft.visibility?.manufacturing_public)}
                                  onCheckedChange={(v) =>
                                    setEditorDraft((d) => ({
                                      ...(d || {}),
                                      visibility: {
                                        ...normalizeVisibility(d?.visibility),
                                        manufacturing_public: Boolean(v),
                                      },
                                    }))
                                  }
                                />
                                <span>Show manufacturing locations</span>
                              </label>

                              <label className="flex items-start gap-2 text-sm text-slate-800">
                                <Checkbox
                                  checked={Boolean(editorDraft.visibility?.admin_rating_public)}
                                  onCheckedChange={(v) =>
                                    setEditorDraft((d) => ({
                                      ...(d || {}),
                                      visibility: {
                                        ...normalizeVisibility(d?.visibility),
                                        admin_rating_public: Boolean(v),
                                      },
                                    }))
                                  }
                                />
                                <span>Show QQ rating</span>
                              </label>
                            </div>
                          </div>

                          <RatingEditor draft={editorDraft} onChange={(next) => setEditorDraft(next)} />

                          <ImportedReviewsPanel
                            companyId={
                              asString(editorDraft.company_id).trim() ||
                              asString(editorOriginalId).trim() ||
                              asString(editorCompanyId).trim()
                            }
                          />

                          <CompanyNotesEditor
                            value={editorDraft.notes_entries}
                            onChange={(next) => setEditorDraft((d) => ({ ...(d || {}), notes_entries: next }))}
                          />

                          <div className="space-y-1">
                            <label className="text-sm text-slate-700">Internal notes (legacy)</label>
                            <textarea
                              value={asString(editorDraft.notes)}
                              onChange={(e) => setEditorDraft((d) => ({ ...d, notes: e.target.value }))}
                              className="min-h-[200px] w-full rounded-md border border-slate-200 bg-white px-3 py-2 text-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-slate-400"
                              placeholder="Internal notes…"
                            />
                          </div>
                        </div>
                      </div>

                      {editorValidationError ? (
                        <div className="rounded-lg border border-amber-200 bg-amber-50 p-3 text-sm text-amber-900">
                          {editorValidationError}
                        </div>
                      ) : null}
                    </div>
                  ) : null}
                  </div>

                  <div className="absolute right-2 top-2 bottom-2">
                    <ScrollScrubber position="relative" scrollEl={editorScrollEl} scrollRef={editorScrollRef} />
                  </div>
                </div>

                <DialogFooter className="flex-none px-6 py-4 border-t">
                  {editorOriginalId ? (
                    <Button
                      variant="outline"
                      className="border-red-600 text-red-600 hover:bg-red-600 hover:text-white mr-auto"
                      onClick={() =>
                        openDeleteConfirm({
                          kind: "single",
                          company_id: editorOriginalId,
                          company_name: getCompanyName(editorDraft),
                        })
                      }
                      disabled={editorSaving}
                    >
                      <Trash2 className="h-4 w-4 mr-2" />
                      Delete
                    </Button>
                  ) : (
                    <span className="mr-auto" />
                  )}
                  <Button variant="outline" onClick={closeEditor}>
                    Cancel
                  </Button>
                  <Button onClick={saveEditor} disabled={editorSaving || Boolean(editorValidationError)}>
                    <Save className="h-4 w-4 mr-2" />
                    {editorSaving ? "Saving…" : editorOriginalId ? "Save changes" : "Create"}
                  </Button>
                </DialogFooter>
                </div>
              </ErrorBoundary>
            </DialogContent>
          </Dialog>

          <AlertDialog open={deleteConfirmOpen} onOpenChange={(open) => !deleteConfirmLoading && setDeleteConfirmOpen(open)}>
            <AlertDialogContent>
              <AlertDialogHeader>
                <AlertDialogTitle>Confirm delete</AlertDialogTitle>
                <AlertDialogDescription>
                  This action is irreversible. The company will be removed from the admin list immediately.
                </AlertDialogDescription>
              </AlertDialogHeader>

              <div className="space-y-2">
                {deleteConfirm?.kind === "bulk" ? (
                  <div className="text-sm text-slate-700">Delete {asString(deleteConfirm.label)}?</div>
                ) : (
                  <div className="text-sm text-slate-700">
                    Delete <span className="font-semibold">{asString(deleteConfirm?.company_name) || "this company"}</span> (
                    <code className="text-xs">{asString(deleteConfirm?.company_id)}</code>)?
                  </div>
                )}

                {deleteConfirmError ? (
                  <div className="rounded border border-red-200 bg-red-50 p-2 text-xs text-red-900">
                    <div className="font-medium">Delete failed</div>
                    <div>{asString(deleteConfirmError.message)}</div>
                    {deleteConfirmError.detail ? (
                      <div className="mt-1 whitespace-pre-wrap break-words font-mono text-red-800">
                        {asString(deleteConfirmError.detail)}
                      </div>
                    ) : null}
                    {deleteConfirmError.body && typeof deleteConfirmError.body === "object" ? (
                      <pre className="mt-1 whitespace-pre-wrap break-words font-mono text-red-800">
                        {prettyJson(deleteConfirmError.body)}
                      </pre>
                    ) : null}
                  </div>
                ) : null}
              </div>

              <AlertDialogFooter>
                <AlertDialogCancel disabled={deleteConfirmLoading}>Cancel</AlertDialogCancel>
                <AlertDialogAction
                  className="bg-red-600 hover:bg-red-600/90"
                  onClick={(e) => {
                    e.preventDefault();
                    confirmDelete();
                  }}
                  disabled={deleteConfirmLoading}
                >
                  {deleteConfirmLoading ? "Deleting…" : "Delete"}
                </AlertDialogAction>
              </AlertDialogFooter>
            </AlertDialogContent>
          </AlertDialog>
        </main>
      </div>
    </>
  );
}
