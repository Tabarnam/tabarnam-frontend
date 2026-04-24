const COMPANY_HOMEPAGES_CONTAINER = "company-homepages";
const DEFAULT_AZURE_STORAGE_ACCOUNT_NAME = "tabarnamstor2356";

export function toStableHomepageUrl(input) {
  const url = typeof input === "string" ? input.trim() : "";
  if (!url) return "";

  if (url.startsWith("/api/company-homepage?")) return url;

  if (hasSasParams(url)) return url;

  const qIndex = url.indexOf("?");
  return qIndex === -1 ? url : url.slice(0, qIndex);
}

export function hasSasParams(input) {
  const url = typeof input === "string" ? input : "";
  return /[?&](sv|sig|se)=/i.test(url);
}

function getAzureAccountName() {
  const fromEnv =
    (typeof import.meta !== "undefined" && import.meta.env && import.meta.env.VITE_AZURE_STORAGE_ACCOUNT_NAME) || "";

  return (typeof fromEnv === "string" && fromEnv.trim())
    ? fromEnv.trim()
    : DEFAULT_AZURE_STORAGE_ACCOUNT_NAME;
}

function isAbsoluteHttpUrl(input) {
  return /^https?:\/\//i.test(input);
}

function looksLikeBlobHostWithoutProtocol(input) {
  return /^[a-z0-9-]+\.blob\.core\.windows\.net\//i.test(input);
}

function buildAzureCompanyHomepageUrl(path) {
  const accountName = getAzureAccountName();
  if (!accountName) return "";

  const normalizedPath = String(path || "").replace(/^\/+/, "");
  if (!normalizedPath) return "";

  return `https://${accountName}.blob.core.windows.net/${COMPANY_HOMEPAGES_CONTAINER}/${normalizedPath}`;
}

function isAzureCompanyHomepagesBlobUrl(input) {
  try {
    const u = new URL(input);
    if (!u.hostname.toLowerCase().endsWith(".blob.core.windows.net")) return false;

    const path = u.pathname || "";
    return path === `/${COMPANY_HOMEPAGES_CONTAINER}` || path.startsWith(`/${COMPANY_HOMEPAGES_CONTAINER}/`);
  } catch {
    return false;
  }
}

function toCompanyHomepageProxyUrl(absoluteAzureUrl) {
  return `/api/company-homepage?src=${encodeURIComponent(absoluteAzureUrl)}`;
}

function maybeProxyAzureCompanyHomepageUrl(input) {
  const stable = toStableHomepageUrl(input);
  if (!stable) return "";

  if (stable.startsWith("/")) return stable;

  if (hasSasParams(stable)) return stable;

  if (isAzureCompanyHomepagesBlobUrl(stable)) return toCompanyHomepageProxyUrl(stable);

  return stable;
}

function normalizeRawHomepageUrl(raw) {
  const trimmed = typeof raw === "string" ? raw.trim() : "";
  if (!trimmed) return "";
  if (/^blob:/i.test(trimmed)) return "";

  if (trimmed.startsWith("//")) return maybeProxyAzureCompanyHomepageUrl(`https:${trimmed}`);
  if (looksLikeBlobHostWithoutProtocol(trimmed)) return maybeProxyAzureCompanyHomepageUrl(`https://${trimmed}`);
  if (isAbsoluteHttpUrl(trimmed)) return maybeProxyAzureCompanyHomepageUrl(trimmed);

  return trimmed;
}

function buildCompanyHomepageUrlFromFallback(companyId, raw) {
  const cleaned = String(raw || "").replace(/^\/+/, "");
  if (!cleaned) return "";

  if (cleaned.startsWith(`${COMPANY_HOMEPAGES_CONTAINER}/`)) {
    return maybeProxyAzureCompanyHomepageUrl(
      buildAzureCompanyHomepageUrl(cleaned.slice(`${COMPANY_HOMEPAGES_CONTAINER}/`.length))
    );
  }

  if (companyId && !cleaned.includes("/")) {
    return maybeProxyAzureCompanyHomepageUrl(
      buildAzureCompanyHomepageUrl(`${encodeURIComponent(companyId)}/${encodeURIComponent(cleaned)}`)
    );
  }

  if (cleaned.includes("/")) {
    return maybeProxyAzureCompanyHomepageUrl(buildAzureCompanyHomepageUrl(cleaned));
  }

  return "";
}

/**
 * Returns the best homepage-image URL for a company.
 * Reads company.homepage_image_url and proxies Azure blobs through /api/company-homepage.
 */
export function getCompanyHomepageUrl(company) {
  const raw = typeof company?.homepage_image_url === "string" ? company.homepage_image_url : "";
  const normalized = normalizeRawHomepageUrl(raw);
  if (normalized) return maybeProxyAzureCompanyHomepageUrl(normalized);

  const companyId =
    (typeof company?.company_id === "string" && company.company_id.trim()) ||
    (typeof company?.id === "string" && company.id.trim()) ||
    "";

  return maybeProxyAzureCompanyHomepageUrl(buildCompanyHomepageUrlFromFallback(companyId, raw));
}
