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

  // Dark mode → neutral gray pill so both black and white logos stay visible
  if (isDark) {
    return (
      <div className="rounded-md bg-gray-300 p-1 flex items-center justify-center">
        <img
          src={logoUrl}
          alt={altText}
          className={className}
          {...props}
        />
      </div>
    );
  }

  return (
    <img
      src={logoUrl}
      alt={altText}
      className={className}
      {...props}
    />
  );
}
