export function getCompanyDisplayName(company: unknown): string {
  if (!company || typeof company !== "object") return "";
  const c = company as Record<string, unknown>;
  const name = typeof c.name === "string" ? c.name.trim() : "";
  const companyName = typeof c.company_name === "string" ? c.company_name.trim() : "";
  return name || companyName;
}

export function getCompanyCanonicalName(company: unknown): string {
  if (!company || typeof company !== "object") return "";
  const c = company as Record<string, unknown>;
  const companyName = typeof c.company_name === "string" ? c.company_name.trim() : "";
  const name = typeof c.name === "string" ? c.name.trim() : "";
  return companyName || name;
}
