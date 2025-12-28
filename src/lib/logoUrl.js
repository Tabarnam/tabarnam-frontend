const COMPANY_LOGOS_CONTAINER = "company-logos";
const DEFAULT_AZURE_STORAGE_ACCOUNT_NAME = "tabarnamstor2356";

export function toStableLogoUrl(input) {
  const url = typeof input === "string" ? input.trim() : "";
  if (!url) return "";

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

function normalizeRawLogoUrl(raw) {
  const trimmed = typeof raw === "string" ? raw.trim() : "";
  if (!trimmed) return "";
  if (/^blob:/i.test(trimmed)) return "";

  if (trimmed.startsWith("//")) return toStableLogoUrl(`https:${trimmed}`);
  if (looksLikeBlobHostWithoutProtocol(trimmed)) return toStableLogoUrl(`https://${trimmed}`);
  if (isAbsoluteHttpUrl(trimmed)) return toStableLogoUrl(trimmed);

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
    return buildAzureCompanyLogoUrl(cleaned.slice(`${COMPANY_LOGOS_CONTAINER}/`.length));
  }

  // If we already have a companyId and the stored value is just the filename,
  // build: https://<account>.blob.core.windows.net/company-logos/<companyId>/<filename>
  if (companyId && !cleaned.includes("/")) {
    return buildAzureCompanyLogoUrl(`${encodeURIComponent(companyId)}/${encodeURIComponent(cleaned)}`);
  }

  // If it already looks like <companyId>/<filename>, just prepend the Azure base.
  if (cleaned.includes("/")) {
    return buildAzureCompanyLogoUrl(cleaned);
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
  if (normalized) return normalized;

  const companyId =
    (typeof company?.company_id === "string" && company.company_id.trim()) ||
    (typeof company?.id === "string" && company.id.trim()) ||
    "";

  return buildCompanyLogoUrlFromFallback(companyId, rawLogo);
}
