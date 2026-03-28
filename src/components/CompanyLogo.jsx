import React from "react";
import { useTheme } from "next-themes";
import { getCompanyLogoUrl } from "@/lib/logoUrl";

/**
 * Theme-aware company logo.
 *
 * In dark mode: always wraps logo in a neutral gray pill for contrast,
 * since we can't predict if a logo is light or dark colored.
 * In light mode: renders the logo as-is.
 *
 * The logo_url_dark field is reserved for future admin-uploaded dark
 * variants but is not consumed here until manual review is in place.
 */
export default function CompanyLogo({ company, className, alt, ...props }) {
  const { resolvedTheme } = useTheme();
  const isDark = resolvedTheme === "dark";

  const logoUrl = getCompanyLogoUrl(company, "light");
  if (!logoUrl) return null;

  const altText = alt || `${company?.company_name || company?.display_name || "Company"} logo`;

  // Neutral gray pill in both modes — provides contrast for black logos
  // on dark backgrounds and white logos on light backgrounds
  return (
    <div className={`rounded-md p-1 flex items-center justify-center ${isDark ? "bg-gray-600" : "bg-gray-200"}`}>
      <img
        src={logoUrl}
        alt={altText}
        className={className}
        {...props}
      />
    </div>
  );
}
