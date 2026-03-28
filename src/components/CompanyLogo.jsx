import React from "react";
import { useTheme } from "next-themes";
import { getCompanyLogoUrl } from "@/lib/logoUrl";

/**
 * Theme-aware company logo.
 *
 * Renders the light or dark logo variant based on the current theme.
 * Falls back to the light variant when no dark variant exists.
 */
export default function CompanyLogo({ company, className, alt, ...props }) {
  const { resolvedTheme } = useTheme();
  const variant = resolvedTheme === "dark" ? "dark" : "light";
  const logoUrl = getCompanyLogoUrl(company, variant);

  if (!logoUrl) return null;

  return (
    <img
      src={logoUrl}
      alt={alt || `${company?.company_name || company?.display_name || "Company"} logo`}
      className={className}
      {...props}
    />
  );
}
