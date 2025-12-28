const COMPANY_LOGOS_CONTAINER = "company-logos";
const DEFAULT_AZURE_STORAGE_ACCOUNT_NAME = "tabarnamstor2356";

export function toStableLogoUrl(input) {
  const url = typeof input === "string" ? input.trim() : "";
  if (!url) return "";

  // Our logo proxy endpoint needs its query string preserved.
  if (url.startsWith("/api/company-logo?")) return url;

  // If the logo URL includes Azure SAS parameters, we must preserve the query string
  // or the asset will 403 (private container / signed URL access).
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
  // e.g. tabarnamstor2356.blob.core.windows.net/company-logos/... (missing https://)
  return /^[a-z0-9-]+\.blob\.core\.windows\.net\//i.test(input);
}

function buildAzureCompanyLogoUrl(path) {
  const accountName = getAzureAccountName();
  if (!accountName) return "";

  const normalizedPath = String(path || "").replace(/^\/+/, "");
  if (!normalizedPath) return "";

  return `https://${accountName}.blob.core.windows.net/${COMPANY_LOGOS_CONTAINER}/${normalizedPath}`;
}

function isAzureCompanyLogosBlobUrl(input) {
  try {
    const u = new URL(input);
    if (!u.hostname.toLowerCase().endsWith(".blob.core.windows.net")) return false;

    const path = u.pathname || "";
    return path === `/${COMPANY_LOGOS_CONTAINER}` || path.startsWith(`/${COMPANY_LOGOS_CONTAINER}/`);
  } catch {
    return false;
  }
}

function toCompanyLogoProxyUrl(absoluteAzureUrl) {
  return `/api/company-logo?src=${encodeURIComponent(absoluteAzureUrl)}`;
}

function maybeProxyAzureCompanyLogoUrl(input) {
  const stable = toStableLogoUrl(input);
  if (!stable) return "";

  // Local assets and our own proxy URLs should never be rewritten.
  if (stable.startsWith("/")) return stable;

  // If a SAS URL is provided, keep it as-is (it may already be signed for private access).
  if (hasSasParams(stable)) return stable;

  // If this is an Azure Blob URL under company-logos, proxy it so it can be served from private storage.
  if (isAzureCompanyLogosBlobUrl(stable)) return toCompanyLogoProxyUrl(stable);

  return stable;
}

function normalizeRawLogoUrl(raw) {
  const trimmed = typeof raw === "string" ? raw.trim() : "";
  if (!trimmed) return "";
  if (/^blob:/i.test(trimmed)) return "";

  if (trimmed.startsWith("//")) return maybeProxyAzureCompanyLogoUrl(`https:${trimmed}`);
  if (looksLikeBlobHostWithoutProtocol(trimmed)) return maybeProxyAzureCompanyLogoUrl(`https://${trimmed}`);
  if (isAbsoluteHttpUrl(trimmed)) return maybeProxyAzureCompanyLogoUrl(trimmed);

  return trimmed;
}

function buildCompanyLogoUrlFromFallback(companyId, rawLogoUrl) {
  const raw = typeof rawLogoUrl === "string" ? rawLogoUrl.trim() : "";
  if (!raw) return "";

  // Allow local/public assets (e.g. /logos/foo.svg)
  if (raw.startsWith("/")) return raw;

  const cleaned = raw.replace(/^\/+/, "");

  // If someone stored the container path without hostname, normalize it.
  if (cleaned.startsWith(`${COMPANY_LOGOS_CONTAINER}/`)) {
    return maybeProxyAzureCompanyLogoUrl(
      buildAzureCompanyLogoUrl(cleaned.slice(`${COMPANY_LOGOS_CONTAINER}/`.length))
    );
  }

  // If we already have a companyId and the stored value is just the filename,
  // build: https://<account>.blob.core.windows.net/company-logos/<companyId>/<filename>
  if (companyId && !cleaned.includes("/")) {
    return maybeProxyAzureCompanyLogoUrl(
      buildAzureCompanyLogoUrl(`${encodeURIComponent(companyId)}/${encodeURIComponent(cleaned)}`)
    );
  }

  // If it already looks like <companyId>/<filename>, just prepend the Azure base.
  if (cleaned.includes("/")) {
    return maybeProxyAzureCompanyLogoUrl(buildAzureCompanyLogoUrl(cleaned));
  }

  return "";
}

/**
 * Returns the best logo URL for a company.
 *
 * Supports:
 * - Fully-qualified URLs stored in company.logo_url
 * - Local public assets (/logos/...)
 * - Relative Azure paths like:
 *   - company_123/uuid.png
 *   - company-logos/company_123/uuid.png
 */
export function getCompanyLogoUrl(company) {
  const rawLogo = typeof company?.logo_url === "string" ? company.logo_url : "";
  const normalized = normalizeRawLogoUrl(rawLogo);
  if (normalized) return maybeProxyAzureCompanyLogoUrl(normalized);

  const companyId =
    (typeof company?.company_id === "string" && company.company_id.trim()) ||
    (typeof company?.id === "string" && company.id.trim()) ||
    "";

  return maybeProxyAzureCompanyLogoUrl(buildCompanyLogoUrlFromFallback(companyId, rawLogo));
}
