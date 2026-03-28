import React from "react";
import { useTheme } from "next-themes";
import { getCompanyLogoUrl } from "@/lib/logoUrl";

/**
 * Theme-aware company logo.
 *
 * - If a distinct dark variant exists, switches logo based on theme.
 * - If no dark variant, wraps logo in a neutral gray pill in dark mode
 *   so both black and white logos remain visible.
 * - In light mode, renders the logo as-is.
 */
export default function CompanyLogo({ company, className, alt, ...props }) {
  const { resolvedTheme } = useTheme();
  const isDark = resolvedTheme === "dark";

  const lightUrl = getCompanyLogoUrl(company, "light");
  const darkUrl = getCompanyLogoUrl(company, "dark");
  const hasDarkVariant = darkUrl && darkUrl !== lightUrl;

  const logoUrl = isDark && hasDarkVariant ? darkUrl : lightUrl;
  if (!logoUrl) return null;

  const altText = alt || `${company?.company_name || company?.display_name || "Company"} logo`;

  // Dark mode without a distinct dark variant → neutral gray pill for contrast
  if (isDark && !hasDarkVariant) {
    return (
      <div className="rounded-md bg-gray-100 dark:bg-gray-700 p-1 flex items-center justify-center">
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
