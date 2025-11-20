import React, { useState } from "react";
import { MapPin } from "lucide-react";
import ReviewsWidget from "@/components/ReviewsWidget";

function normalizeAffiliateLinks(company) {
  if (!company) return [];
  const links = [];

  if (Array.isArray(company.affiliate_links)) {
    for (const entry of company.affiliate_links) {
      if (!entry) continue;
      if (typeof entry === "string") {
        links.push({ label: "", url: entry });
      } else if (typeof entry === "object" && entry.url) {
        links.push({ label: entry.label || "", url: entry.url });
      }
    }
  }

  if (Array.isArray(company.affiliate_link_urls)) {
    for (const url of company.affiliate_link_urls) {
      if (url) links.push({ label: "", url });
    }
  }

  for (let i = 1; i <= 5; i += 1) {
    const url =
      company[`affiliate_link_${i}`] ||
      company[`affiliate_link_${i}_url`] ||
      company[`affiliate${i}_url`];
    if (url) links.push({ label: "", url });
  }

  const seen = new Set();
  const deduped = [];
  for (const link of links) {
    const key = (link.url || "").trim();
    if (!key || seen.has(key)) continue;
    seen.add(key);
    deduped.push(link);
    if (deduped.length >= 5) break;
  }
  return deduped;
}

function inferAffiliateLabel(link, fallbackPrefix = "Affiliate") {
  const explicit = (link?.label || "").trim();
  if (explicit) return explicit;
  const rawUrl = (link?.url || "").trim();
  if (!rawUrl) return fallbackPrefix;
  try {
    const u = new URL(rawUrl.startsWith("http") ? rawUrl : `https://${rawUrl}`);
    const host = u.hostname.replace(/^www\./i, "");
    return host || fallbackPrefix;
  } catch {
    return rawUrl || fallbackPrefix;
  }
}

export default function ExpandableCompanyRow({
  company,
  sortBy,
  unit,
  onKeywordSearch,
  rightColsOrder,
}) {
  const [isExpanded, setIsExpanded] = useState(false);

  const affiliateLinks = normalizeAffiliateLinks(company);
  const amazonLink = company.amazon_store_url || company.amazon_url || "";

  const truncateText = (text, length = 60) => {
    if (!text) return "—";
    return text.length > length ? text.substring(0, length) + "…" : text;
  };

  const formatDistance = (dist, unitLabel) => {
    return typeof dist === "number" ? `${dist.toFixed(1)} ${unitLabel}` : "—";
  };

  const formatLocationDisplayName = (geo) => {
    // Format as "City, State/Province, Country" without street address
    const parts = [];
    if (geo.city) parts.push(geo.city);
    if (geo.state) parts.push(geo.state);
    if (geo.country) parts.push(geo.country);
    return parts.length > 0 ? parts.join(", ") : "—";
  };

  const getLocationsList = (locations, geocodes, distances = [], isManu = false) => {
    // For manufacturing, prefer the pre-calculated distances array which already has geo data with distances
    if (isManu && Array.isArray(distances) && distances.length > 0) {
      return distances.slice(0, 5).map((geo) => ({
        formatted: formatLocationDisplayName(geo),
        distance: typeof geo.dist === "number" ? geo.dist : null,
      }));
    }
    // Otherwise use geocodes or locations
    const sourceArray = Array.isArray(geocodes) && geocodes.length > 0 ? geocodes : (Array.isArray(locations) ? locations : []);
    if (!sourceArray || !Array.isArray(sourceArray)) return [];
    return sourceArray.slice(0, 5).map((geo) => ({
      formatted: formatLocationDisplayName(geo),
      distance: null,
    }));
  };

  const manuLocations = getLocationsList(
    company.manufacturing_locations,
    company.manufacturing_geocodes,
    company._manuDists || [],
    true
  );

  const hqLocations = company.headquarters && Array.isArray(company.headquarters)
    ? company.headquarters.slice(0, 5).map((hq) => ({
        formatted: formatLocationDisplayName(hq),
        distance: null,
      }))
    : company.headquarters_location
    ? [{ formatted: company.headquarters_location, distance: null }]
    : [];

  const hqLocation = hqLocations;

  const getReviewsPreviews = () => {
    if (!company._reviews) return [];
    return company._reviews.slice(0, 3);
  };

  const renderRightColumn = (colKey) => {
    if (colKey === "manu") {
      return (
        <div className="space-y-2">
          {manuLocations.map((loc, idx) => (
            <div key={idx} className="text-sm flex items-start gap-1">
              {typeof loc.distance === "number" && (
                <div className="text-xs text-gray-600 font-medium whitespace-nowrap pt-0.5">
                  {formatDistance(loc.distance, unit)}
                </div>
              )}
              <div className="text-gray-900">{loc.formatted}</div>
            </div>
          ))}
          {manuLocations.length === 0 && <div className="text-sm text-gray-500">—</div>}
        </div>
      );
    }

    if (colKey === "hq") {
      return (
        <div className="space-y-1">
          {hqLocation.map((loc, idx) => (
            <div key={idx} className="text-sm text-gray-900">
              {loc.formatted}
            </div>
          ))}
          {hqLocation.length === 0 && <div className="text-sm text-gray-500">—</div>}
        </div>
      );
    }

    if (colKey === "manu-expanded") {
      return (
        <div className="space-y-2">
          {manuLocations.map((loc, idx) => (
            <div key={idx} className="text-sm flex items-start gap-1">
              {typeof loc.distance === "number" && (
                <div className="text-xs text-gray-600 font-medium whitespace-nowrap pt-0.5">
                  {formatDistance(loc.distance, unit)}
                </div>
              )}
              <div className="text-gray-900">{loc.formatted}</div>
            </div>
          ))}
          {manuLocations.length === 0 && <div className="text-sm text-gray-500">—</div>}
        </div>
      );
    }

    if (colKey === "stars") {
      const reviews = getReviewsPreviews();
      return (
        <div className="space-y-1">
          {reviews.map((review, idx) => (
            <div key={idx} className="text-xs text-gray-600 border-b pb-1 line-clamp-2">
              {review.abstract || review.text || "—"}
            </div>
          ))}

          {[...Array(Math.max(0, 3 - reviews.length))].map((_, idx) => (
            <div key={`empty-${idx}`} className="text-xs text-gray-400 pb-1 h-5" />
          ))}

          {reviews.length > 0 && (
            <button
              onClick={() => setIsExpanded(true)}
              className="text-xs text-blue-600 hover:underline pt-1"
            >
              Expand reviews
            </button>
          )}
        </div>
      );
    }

    return null;
  };

  const handleRowClick = () => {
    setIsExpanded(!isExpanded);
  };

  const handleExpandedClick = (e) => {
    if (e.target.closest("a, button")) return;
    setIsExpanded(false);
  };

  if (isExpanded) {
    return (
      <div
        onClick={handleExpandedClick}
        className="border-2 rounded-lg mb-4 p-6 bg-white cursor-pointer"
        style={{ borderColor: "#B1DDE3", borderWidth: "2px" }}
      >
        <div className="grid grid-cols-5 gap-4 mb-6 pb-6 border-b">
          <div className="col-span-2">
            <div className="font-bold text-lg text-gray-900">{company.company_name}</div>
            {company.company_tagline && (
              <div className="text-sm text-gray-600 mt-1">{company.company_tagline}</div>
            )}
            {company.url && (
              <div className="text-xs text-blue-600 mt-1 truncate hover:text-blue-800">
                <a href={company.url} target="_blank" rel="noreferrer">
                  {company.url}
                </a>
              </div>
            )}

            {(affiliateLinks.length > 0 || amazonLink) && (
              <div className="mt-3 space-y-1">
                {affiliateLinks.map((link, idx) => (
                  <div key={link.url || idx} className="text-sm">
                    <a
                      href={link.url}
                      target="_blank"
                      rel="noreferrer"
                      className="text-blue-600 hover:underline"
                      onClick={(e) => e.stopPropagation()}
                    >
                      {inferAffiliateLabel(link, `Affiliate ${idx + 1}`)}
                    </a>
                  </div>
                ))}
                {amazonLink && (
                  <div className="text-sm">
                    <a
                      href={amazonLink}
                      target="_blank"
                      rel="noreferrer"
                      className="text-blue-600 hover:underline"
                      onClick={(e) => e.stopPropagation()}
                    >
                      Amazon Store
                    </a>
                  </div>
                )}
              </div>
            )}

            <div className="text-sm font-semibold text-gray-700 mt-3">Industries</div>
            <div className="text-sm text-gray-600 mt-1 flex flex-wrap gap-1">
              {Array.isArray(company.industries) &&
                company.industries.map((ind, idx) => (
                  <button
                    key={idx}
                    onClick={(e) => {
                      e.stopPropagation();
                      onKeywordSearch(ind);
                    }}
                    className="text-blue-600 hover:underline"
                  >
                    {ind}
                    {idx < company.industries.length - 1 && ","}
                  </button>
                ))}
            </div>
          </div>

          <div>
            {company.logo_url ? (
              <img
                src={company.logo_url}
                alt={company.company_name}
                className="w-full h-24 object-contain mb-3"
                onError={(e) => {
                  e.target.style.display = "none";
                }}
              />
            ) : (
              <div className="w-full h-24 mb-3 bg-gray-100 rounded flex items-center justify-center text-gray-700 font-bold text-2xl">
                {company.company_name
                  .split(" ")
                  .map((w) => w[0])
                  .join("")
                  .substring(0, 2)
                  .toUpperCase()}
              </div>
            )}
            <div className="text-sm font-semibold text-gray-700">Keywords</div>
            <div className="text-sm text-gray-600 mt-1 flex flex-wrap gap-1">
              {String(company.product_keywords || "")
                .split(",")
                .map((kw) => kw.trim())
                .filter(Boolean)
                .map((kw, idx) => (
                  <button
                    key={idx}
                    onClick={(e) => {
                      e.stopPropagation();
                      onKeywordSearch(kw);
                    }}
                    className="text-blue-600 hover:underline text-xs"
                  >
                    {kw}
                  </button>
                ))}
            </div>
          </div>

          {rightColsOrder.map((colKey) => (
            <div key={colKey}>
              <div className="text-sm font-semibold text-gray-700 mb-2">
                {colKey === "manu" ? "Manufacturing" : colKey === "hq" ? "HQ" : "Reviews"}
              </div>
              {renderRightColumn(colKey)}
            </div>
          ))}
        </div>

        <div className="mt-6 col-span-5">
          <div className="text-lg font-bold text-gray-900 mb-4">Reviews</div>
          <ReviewsWidget companyName={company.company_name} />
        </div>

        <div className="text-xs text-gray-500 mt-4 text-center">Click anywhere to collapse</div>
      </div>
    );
  }

  return (
    <div
      onClick={handleRowClick}
      className="grid grid-cols-12 gap-3 border rounded-lg p-2 bg-white hover:bg-gray-50 cursor-pointer mb-3 transition-colors"
      style={{ borderColor: "#649BA0" }}
    >
      <div className="col-span-4">
        <div className="font-bold text-gray-900">{company.company_name}</div>
        {company.company_tagline && (
          <div className="text-xs text-gray-600 mt-1">{company.company_tagline}</div>
        )}
        {company.url && (
          <div className="text-xs text-blue-600 mt-1 truncate">{truncateText(company.url, 40)}</div>
        )}

        {(affiliateLinks.length > 0 || amazonLink) && (
          <div className="mt-2 space-y-0.5 text-xs">
            {affiliateLinks.map((link, idx) => (
              <div key={link.url || idx} className="truncate">
                <span className="font-semibold text-gray-700 mr-1">Aff.</span>
                <span className="text-blue-600 hover:underline">
                  {inferAffiliateLabel(link, `Affiliate ${idx + 1}`)}
                </span>
              </div>
            ))}
            {amazonLink && (
              <div className="truncate">
                <span className="font-semibold text-gray-700 mr-1">Aff.</span>
                <span className="text-blue-600 hover:underline">Amazon Store</span>
              </div>
            )}
          </div>
        )}

        <div className="text-xs font-semibold text-gray-700 mt-2">Industries</div>
        <div className="flex flex-wrap gap-1 mt-1">
          {Array.isArray(company.industries) &&
            company.industries.slice(0, 3).map((ind, idx) => (
              <button
                key={idx}
                onClick={(e) => {
                  e.stopPropagation();
                  onKeywordSearch(ind);
                }}
                className="text-xs text-blue-600 hover:underline"
              >
                {ind}
              </button>
            ))}
          {company.industries?.length > 3 && (
            <span className="text-xs text-gray-500">+{company.industries.length - 3}</span>
          )}
        </div>
      </div>

      <div className="col-span-2">
        {company.logo_url ? (
          <img
            src={company.logo_url}
            alt={company.company_name}
            className="w-full h-20 object-contain mb-2"
            onError={(e) => {
              e.target.style.display = "none";
            }}
          />
        ) : (
          <div className="w-full h-20 mb-2 bg-gray-100 rounded flex items-center justify-center text-gray-700 font-bold text-lg">
            {company.company_name
              .split(" ")
              .map((w) => w[0])
              .join("")
              .substring(0, 2)
              .toUpperCase()}
          </div>
        )}
        <div className="text-xs font-semibold text-gray-700">Keywords</div>
        <div className="flex flex-wrap gap-1 mt-1">
          {String(company.product_keywords || "")
            .split(",")
            .map((kw) => kw.trim())
            .filter(Boolean)
            .slice(0, 4)
            .map((kw, idx) => (
              <button
                key={idx}
                onClick={(e) => {
                  e.stopPropagation();
                  onKeywordSearch(kw);
                }}
                className="text-xs text-blue-600 hover:underline bg-gray-100 px-1 py-0.5 rounded"
              >
                {kw}
              </button>
            ))}
        </div>
      </div>

      {rightColsOrder.map((colKey, colIdx) => (
        <div key={colKey} className="col-span-2">
          <div className="text-xs font-semibold text-gray-700 flex items-center gap-1 mb-2">
            {colIdx === 0 && <MapPin size={14} />}
            {colKey === "manu" ? "Manufacturing" : colKey === "hq" ? "HQ" : "Reviews"}
          </div>
          {renderRightColumn(colKey)}
        </div>
      ))}
    </div>
  );
}
