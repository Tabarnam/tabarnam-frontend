import React, { useState } from "react";
import { MapPin } from "lucide-react";
import ReviewsWidget from "@/components/ReviewsWidget";

export default function ExpandableCompanyRow({
  company,
  sortBy,
  unit,
  onKeywordSearch,
  rightColsOrder,
}) {
  const [isExpanded, setIsExpanded] = useState(false);

  const truncateText = (text, length = 60) => {
    if (!text) return "—";
    return text.length > length ? text.substring(0, length) + "…" : text;
  };

  const formatDistance = (dist, unit) => {
    return typeof dist === "number" ? `${dist.toFixed(1)} ${unit}` : "—";
  };

  const getLocationsList = (locations, geocodes, isManu = false) => {
    if (!geocodes || !Array.isArray(geocodes)) return [];
    return geocodes.slice(0, 5).map((geo, idx) => ({
      formatted: geo.formatted_address || `${geo.city}, ${geo.country}`,
      distance: isManu ? geo.dist : null,
    }));
  };

  const manuLocations = getLocationsList(
    company.manufacturing_locations,
    company.manufacturing_geocodes,
    true
  );
  const hqLocation = company.headquarters_location
    ? [{ formatted: company.headquarters_location, distance: null }]
    : [];

  const getReviewsPreviews = () => {
    if (!company._reviews) return [];
    return company._reviews.slice(0, 3);
  };

  const renderRightColumn = (colKey) => {
    if (colKey === "manu") {
      return (
        <div className="space-y-1">
          {manuLocations.map((loc, idx) => (
            <div key={idx} className="text-sm">
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

    if (colKey === "stars") {
      const reviews = getReviewsPreviews();
      return (
        <div className="space-y-1">
          {/* Row 2, 3, 4: Review snippets */}
          {reviews.map((review, idx) => (
            <div key={idx} className="text-xs text-gray-600 border-b pb-1 line-clamp-2">
              {review.abstract || review.text || "—"}
            </div>
          ))}

          {/* Fill remaining rows */}
          {[...Array(Math.max(0, 3 - reviews.length))].map((_, idx) => (
            <div key={`empty-${idx}`} className="text-xs text-gray-400 pb-1 h-5"></div>
          ))}

          {/* Row 5: Expand reviews link */}
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
    if (e.target.closest("a, button")) return; // Don't collapse on link/button clicks
    setIsExpanded(false);
  };

  if (isExpanded) {
    return (
      <div
        onClick={handleExpandedClick}
        className="border-2 border-gray-400 rounded-lg mb-4 p-6 bg-white cursor-pointer"
        style={{ borderWidth: "2px" }}
      >
        {/* Collapsed view (same as below, but inside expanded container) */}
        <div className="grid grid-cols-5 gap-4 mb-6 pb-6 border-b">
          {/* Column 1: Company Info (1.75x width) */}
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

          {/* Column 2: Logo & Keywords */}
          <div>
            {company.logo_url && (
              <img
                src={company.logo_url}
                alt={company.company_name}
                className="w-full h-24 object-contain mb-3"
              />
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

          {/* Columns 3-5: Location/Stars (expanded) */}
          {rightColsOrder.map((colKey) => (
            <div key={colKey}>
              <div className="text-sm font-semibold text-gray-700 mb-2">
                {colKey === "manu" ? "Manufacturing" : colKey === "hq" ? "HQ" : "Reviews"}
              </div>
              {renderRightColumn(colKey)}
            </div>
          ))}
        </div>

        {/* Full Reviews Section at Bottom */}
        <div className="mt-6 col-span-5">
          <div className="text-lg font-bold text-gray-900 mb-4">Reviews</div>
          <ReviewsWidget companyName={company.company_name} />
        </div>

        <div className="text-xs text-gray-500 mt-4 text-center">
          Click anywhere to collapse
        </div>
      </div>
    );
  }

  // COLLAPSED VIEW
  return (
    <div
      onClick={handleRowClick}
      className="grid grid-cols-12 gap-3 border rounded-lg p-4 bg-white hover:bg-gray-50 cursor-pointer mb-3 transition-colors"
    >
      {/* Column 1: Company Info (spans 4 cols out of 12 for 1.75x width) */}
      <div className="col-span-4">
        <div className="font-bold text-gray-900">{company.company_name}</div>
        {company.company_tagline && (
          <div className="text-xs text-gray-600 mt-1">{company.company_tagline}</div>
        )}
        {company.url && (
          <div className="text-xs text-blue-600 mt-1 truncate">
            {truncateText(company.url, 40)}
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

      {/* Column 2: Logo & Keywords (spans 2 cols) */}
      <div className="col-span-2">
        {company.logo_url && (
          <img
            src={company.logo_url}
            alt={company.company_name}
            className="w-full h-20 object-contain mb-2"
          />
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

      {/* Columns 3-5: Dynamic (Manufacturing/HQ/Stars based on sort) */}
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
